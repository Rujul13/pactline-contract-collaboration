import { env } from "cloudflare:workers";
import { requireOwnerApi } from "@/lib/owner-boundary";
import { ownerContract } from "@/lib/workflow";
import { captureError } from "@/lib/monitoring";

export async function POST(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const auth = await requireOwnerApi(request); if (auth.response) return auth.response;
  const { contractId } = await context.params; if (!await ownerContract(contractId, auth.user.userId)) return Response.json({ error: "Contract not found" }, { status: 404 });
  let body: { action?: "add" | "resolve"; blockId?: string; body?: string; parentCommentId?: string; commentId?: string }; try { body = await request.json() as typeof body; } catch { return Response.json({ error: "Valid JSON is required" }, { status: 400 }); }
  const now = new Date().toISOString(); const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  try {
  if (body.action === "add") {
    const text = body.body?.trim(); if (!body.blockId || !text || text.length > 5000) return Response.json({ error: "Choose a paragraph and enter a comment up to 5,000 characters" }, { status: 400 });
    const block = await env.DB.prepare("SELECT id FROM document_blocks WHERE id=? AND contract_id=?").bind(body.blockId, contractId).first(); if (!block) return Response.json({ error: "Paragraph not found" }, { status: 404 });
    const round = await env.DB.prepare("SELECT id FROM review_rounds WHERE contract_id=? AND status='open' ORDER BY round_number DESC LIMIT 1").bind(contractId).first<{ id: string }>(); const id = crypto.randomUUID();
    await env.DB.batch([env.DB.prepare("INSERT INTO paragraph_comments (id,contract_id,block_id,review_round_id,parent_comment_id,author_kind,author_id,author_display,body,status,created_at,updated_at) VALUES (?,?,?,?,?,'owner',?,?,?,'open',?,?)").bind(id, contractId, body.blockId, round?.id ?? null, body.parentCommentId ?? null, auth.user.userId, auth.user.displayName, text, now, now), env.DB.prepare("INSERT INTO audit_log_entries (id,contract_id,actor_id,actor_display,action,target_type,target_id,request_id,metadata,created_at) VALUES (?,?,?,?, 'paragraph_comment.added','paragraph_comment',?,?,json(?),?)").bind(crypto.randomUUID(), contractId, auth.user.userId, auth.user.displayName, id, requestId, JSON.stringify({ blockId: body.blockId }), now)]);
    return Response.json({ comment: { id, body: text, authorDisplay: auth.user.displayName } }, { status: 201 });
  }
  if (body.action === "resolve" && body.commentId) {
    const result = await env.DB.prepare("UPDATE paragraph_comments SET status='resolved',resolved_by=?,resolved_at=?,updated_at=? WHERE id=? AND contract_id=? AND status='open'").bind(auth.user.userId, now, now, body.commentId, contractId).run();
    if (!result.meta.changes) return Response.json({ error: "Open comment not found" }, { status: 404 });
    await env.DB.prepare("INSERT INTO audit_log_entries (id,contract_id,actor_id,actor_display,action,target_type,target_id,request_id,metadata,created_at) VALUES (?,?,?,?, 'paragraph_comment.resolved','paragraph_comment',?,?,json('{}'),?)").bind(crypto.randomUUID(), contractId, auth.user.userId, auth.user.displayName, body.commentId, requestId, now).run();
    return Response.json({ resolved: true });
  }
  return Response.json({ error: "Action must add or resolve a comment" }, { status: 400 });
  } catch (error) {
    await captureError(error, { requestId, route: "/api/contracts/:id/comments", method: "POST", actorScope: "owner", contractId });
    return Response.json({ error: "Unable to update the paragraph discussion", requestId }, { status: 500 });
  }
}
