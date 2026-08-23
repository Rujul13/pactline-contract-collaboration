import { env } from "cloudflare:workers";
import { getApproverSession } from "@/lib/approver-auth";
import { captureError } from "@/lib/monitoring";

export async function POST(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const session = await getApproverSession(request);
  if (!session) {
    return Response.json({ error: "Unauthorized: No active approver session" }, { status: 401 });
  }

  const { contractId } = await context.params;
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();

  let body: {
    assignmentId?: string;
    decision?: "approved" | "edits_requested";
    decisionReason?: string;
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Valid JSON is required" }, { status: 400 });
  }

  try {
    const { assignmentId, decision, decisionReason } = body;

    if (!assignmentId) {
      return Response.json({ error: "Assignment ID is required" }, { status: 400 });
    }

    if (!decision || !["approved", "edits_requested"].includes(decision)) {
      return Response.json({ error: "Decision must be 'approved' or 'edits_requested'" }, { status: 400 });
    }

    const reason = decisionReason?.trim();
    if (!reason || reason.length < 5 || reason.length > 2000) {
      return Response.json({ error: "A decision rationale of at least 5 characters is required" }, { status: 400 });
    }

    const contract = await env.DB.prepare(
      "SELECT id, current_version FROM contracts WHERE id = ?"
    ).bind(contractId).first<{ id: string; current_version: number }>();

    if (!contract) {
      return Response.json({ error: "Contract not found" }, { status: 404 });
    }

    // Decision Authorization Safeguard: Verify assignment belongs to this approver AND matches current version
    const assignment = await env.DB.prepare(
      `SELECT * FROM approval_assignments
       WHERE id = ? AND contract_id = ? AND delegated_approver_id = ?`
    ).bind(assignmentId, contractId, session.delegatedApproverId).first<{
      id: string;
      version_number: number;
      kind: string;
      status: string;
    }>();

    if (!assignment) {
      return Response.json({ error: "Forbidden: You are not authorized to decide this assignment" }, { status: 403 });
    }

    if (assignment.version_number !== contract.current_version) {
      return Response.json({ error: "Forbidden: This assignment is for a prior version and cannot be decided" }, { status: 403 });
    }

    if (assignment.status !== "pending") {
      return Response.json({ error: "Conflict: This assignment has already been decided or resolved" }, { status: 409 });
    }

    const now = new Date().toISOString();

    // ATOMIC COMPARE-AND-SET UPDATE: require pending status, current version, and ownership
    const result = await env.DB.prepare(
      `UPDATE approval_assignments
       SET status = ?, decision_reason = ?, resolved_at = ?, updated_at = ?
       WHERE id = ?
         AND contract_id = ?
         AND delegated_approver_id = ?
         AND version_number = (SELECT current_version FROM contracts WHERE id = ?)
         AND status = 'pending'`
    ).bind(decision, reason, now, now, assignmentId, contractId, session.delegatedApproverId, contractId).run();

    if (result.meta.changes !== 1) {
      return Response.json({
        error: "Conflict: Pending assignment not found, already decided, for an outdated version, or unauthorized"
      }, { status: 409 });
    }

    // Audit log entry ONLY when CAS update affected exactly 1 row
    await env.DB.prepare(
      `INSERT INTO audit_log_entries
         (id, contract_id, actor_id, actor_display, action, target_type, target_id, version_number, request_id, metadata, created_at)
       VALUES (?, ?, ?, ?, 'approval_decision.recorded', 'approval_assignment', ?, ?, ?, json(?), ?)`
    ).bind(
      crypto.randomUUID(), contractId, session.delegatedApproverId, `${session.displayName} (${session.titleRole})`,
      assignmentId, assignment.version_number, requestId,
      JSON.stringify({ kind: assignment.kind, decision, decisionReason: reason }), now
    ).run();

    return Response.json({
      success: true,
      assignmentId,
      status: decision,
      resolvedAt: now,
    });
  } catch (error) {
    await captureError(error, { requestId, route: "/api/approver/contracts/:id/decide", method: "POST", actorScope: "approver", contractId });
    return Response.json({ error: "Failed to record approval decision", requestId }, { status: 500 });
  }
}
