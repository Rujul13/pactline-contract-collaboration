import { env } from "cloudflare:workers";
import { requireOwnerApi } from "@/lib/owner-boundary";
import { ownerContract } from "@/lib/workflow";
import { captureError } from "@/lib/monitoring";

export async function POST(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const auth = await requireOwnerApi(request); if (auth.response) return auth.response;
  const { contractId } = await context.params; if (!await ownerContract(contractId, auth.user.userId)) return Response.json({ error: "Contract not found" }, { status: 404 });
  let body: { action?: "open" | "close"; roundId?: string; deadlineAt?: string; reason?: string }; try { body = await request.json() as typeof body; } catch { return Response.json({ error: "Valid JSON is required" }, { status: 400 }); }
  const now = new Date().toISOString(); const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  try {
  if (body.action === "open") {
    let deadline: string | null = null; try { deadline = body.deadlineAt ? new Date(body.deadlineAt).toISOString() : null; } catch { return Response.json({ error: "Deadline must be valid" }, { status: 400 }); }
    const current = await env.DB.prepare("SELECT id FROM review_rounds WHERE contract_id=? AND status='open'").bind(contractId).first(); if (current) return Response.json({ error: "Close the current review round before opening another" }, { status: 409 });
    const max = await env.DB.prepare("SELECT COALESCE(MAX(round_number),0) AS number FROM review_rounds WHERE contract_id=?").bind(contractId).first<{ number: number }>(); const number = Number(max?.number ?? 0) + 1; const id = crypto.randomUUID();
    const statements = [env.DB.prepare("INSERT INTO review_rounds (id,contract_id,round_number,status,deadline_at,opened_by,created_at,updated_at) VALUES (?,?,?,'open',?,?,?,?)").bind(id, contractId, number, deadline, auth.user.userId, now, now), env.DB.prepare("UPDATE contracts SET lifecycle_stage='external_review',review_deadline_at=?,updated_at=? WHERE id=?").bind(deadline, now, contractId), env.DB.prepare("INSERT INTO audit_log_entries (id,contract_id,actor_id,actor_display,action,target_type,target_id,request_id,metadata,created_at) VALUES (?,?,?,?, 'review_round.opened','review_round',?,?,json(?),?)").bind(crypto.randomUUID(), contractId, auth.user.userId, auth.user.displayName, id, requestId, JSON.stringify({ roundNumber: number, deadline }), now)];
    if (deadline) statements.push(env.DB.prepare("INSERT INTO reminder_schedules (id,contract_id,kind,channel,due_at,recipient,status,created_at,updated_at) VALUES (?,?,'review_deadline','in_app',?,?,'scheduled',?,?)").bind(crypto.randomUUID(), contractId, deadline, auth.user.email, now, now));
    await env.DB.batch(statements); return Response.json({ reviewRound: { id, roundNumber: number, deadlineAt: deadline, status: "open" } }, { status: 201 });
  }
  if (body.action === "close" && body.roundId) {
    const reason = body.reason?.trim(); if (!reason || reason.length < 3 || reason.length > 2000) return Response.json({ error: "A closing reason is required" }, { status: 400 });
    const result = await env.DB.prepare("UPDATE review_rounds SET status='closed',closed_by=?,closed_at=?,updated_at=? WHERE id=? AND contract_id=? AND status='open'").bind(auth.user.userId, now, now, body.roundId, contractId).run();
    if (!result.meta.changes) return Response.json({ error: "Open review round not found" }, { status: 404 });
    await env.DB.batch([env.DB.prepare("UPDATE reminder_schedules SET status='cancelled',updated_at=? WHERE contract_id=? AND kind='review_deadline' AND status='scheduled'").bind(now, contractId), env.DB.prepare("INSERT INTO audit_log_entries (id,contract_id,actor_id,actor_display,action,target_type,target_id,request_id,metadata,created_at) VALUES (?,?,?,?, 'review_round.closed','review_round',?,?,json(?),?)").bind(crypto.randomUUID(), contractId, auth.user.userId, auth.user.displayName, body.roundId, requestId, JSON.stringify({ reason }), now)]);
    return Response.json({ closed: true });
  }
  return Response.json({ error: "Action must open or close a review round" }, { status: 400 });
  } catch (error) {
    await captureError(error, { requestId, route: "/api/contracts/:id/review-rounds", method: "POST", actorScope: "owner", contractId });
    return Response.json({ error: "Unable to update the review round", requestId }, { status: 500 });
  }
}
