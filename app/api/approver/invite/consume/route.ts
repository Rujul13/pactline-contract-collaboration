import { consumeInviteToken, applyApproverSessionCookie } from "@/lib/approver-auth";
import { captureError } from "@/lib/monitoring";
import { env } from "cloudflare:workers";

export async function POST(request: Request) {
  let body: { token?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Valid JSON is required" }, { status: 400 });
  }

  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();

  try {
    if (!body.token || typeof body.token !== "string") {
      return Response.json({ error: "Invite token is required" }, { status: 400 });
    }

    const result = await consumeInviteToken(body.token);
    if (!result.success) {
      return Response.json({ error: result.error }, { status: 410 });
    }

    // Record audit log entry
    await env.DB.prepare(
      `INSERT INTO audit_log_entries
         (id, contract_id, actor_id, actor_display, action, target_type, target_id, request_id, metadata, created_at)
       VALUES (?, ?, ?, ?, 'approval_invite.consumed', 'approval_invite', ?, ?, json(?), ?)`
    ).bind(
      crypto.randomUUID(), result.contractId, result.delegatedApproverId, "Delegated Approver", result.assignmentId, requestId,
      JSON.stringify({ assignmentId: result.assignmentId }), new Date().toISOString()
    ).run();

    const headers = new Headers({ "Content-Type": "application/json" });
    applyApproverSessionCookie(headers, result.sessionToken);

    return new Response(JSON.stringify({ success: true, contractId: result.contractId }), {
      status: 200,
      headers,
    });
  } catch (error) {
    await captureError(error, { requestId, route: "/api/approver/invite/consume", method: "POST", actorScope: "approver" });
    return Response.json({ error: "Failed to consume invite token", requestId }, { status: 500 });
  }
}
