import { env } from "cloudflare:workers";
import { getApproverSession } from "@/lib/approver-auth";
import { captureError } from "@/lib/monitoring";

export async function GET(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const session = await getApproverSession(request);
  if (!session) {
    return Response.json({ error: "Unauthorized: No active approver session" }, { status: 401 });
  }

  const { contractId } = await context.params;
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();

  try {
    const contract = await env.DB.prepare(
      "SELECT id, title, status, lifecycle_stage, current_version FROM contracts WHERE id = ?"
    ).bind(contractId).first<{
      id: string;
      title: string;
      status: string;
      lifecycle_stage: string;
      current_version: number;
    }>();

    if (!contract) {
      return Response.json({ error: "Contract not found" }, { status: 404 });
    }

    // Find active assignment for this approver on the contract for current version
    const assignment = await env.DB.prepare(
      `SELECT * FROM approval_assignments
       WHERE contract_id = ? AND delegated_approver_id = ? AND version_number = ?
       ORDER BY created_at DESC`
    ).bind(contractId, session.delegatedApproverId, contract.current_version).first<{
      id: string;
      version_number: number;
      kind: string;
      required: number;
      status: string;
      decision_reason: string | null;
      resolved_at: string | null;
    }>();

    if (!assignment) {
      return Response.json({ error: "Forbidden: You have no active assignment for this contract version" }, { status: 403 });
    }

    // Fetch document blocks for read-only snapshot
    const blocks = await env.DB.prepare(
      `SELECT block_key, order_index, kind, current_text
       FROM document_blocks
       WHERE contract_id = ?
       ORDER BY order_index ASC`
    ).bind(contractId).all<{
      block_key: string;
      order_index: number;
      kind: string;
      current_text: string;
    }>();

    return Response.json({
      contract,
      assignment,
      snapshot: blocks.results || [],
      approver: {
        id: session.delegatedApproverId,
        displayName: session.displayName,
        titleRole: session.titleRole,
        email: session.email,
      },
    });
  } catch (error) {
    await captureError(error, { requestId, route: "/api/approver/contracts/:id", method: "GET", actorScope: "approver", contractId });
    return Response.json({ error: "Failed to load contract approval workspace", requestId }, { status: 500 });
  }
}
