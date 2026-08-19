import { env } from "cloudflare:workers";
import { requireOwnerApi } from "@/lib/owner-boundary";
import { ownerContract } from "@/lib/workflow";
import { captureError } from "@/lib/monitoring";
import { validateReplyParent } from "@/lib/comment-threads";

export async function POST(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const auth = await requireOwnerApi(request); if (auth.response) return auth.response;
  const { contractId } = await context.params; if (!await ownerContract(contractId, auth.user.userId)) return Response.json({ error: "Contract not found" }, { status: 404 });
  let body: { action?: "add" | "reply" | "resolve" | "reopen"; blockId?: string; body?: string; parentCommentId?: string; commentId?: string; reason?: string }; try { body = await request.json() as typeof body; } catch { return Response.json({ error: "Valid JSON is required" }, { status: 400 }); }
  const now = new Date().toISOString(); const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  try {
  if (body.action === "add") {
    if (body.parentCommentId) return Response.json({ error: "Use the reply action to respond to an existing comment" }, { status: 400 });
    const text = body.body?.trim(); if (!body.blockId || !text || text.length > 5000) return Response.json({ error: "Choose a paragraph and enter a comment up to 5,000 characters" }, { status: 400 });
    const block = await env.DB.prepare("SELECT id FROM document_blocks WHERE id=? AND contract_id=?").bind(body.blockId, contractId).first(); if (!block) return Response.json({ error: "Paragraph not found" }, { status: 404 });
    const round = await env.DB.prepare("SELECT id FROM review_rounds WHERE contract_id=? AND status='open' ORDER BY round_number DESC LIMIT 1").bind(contractId).first<{ id: string }>(); const id = crypto.randomUUID();
    await env.DB.batch([env.DB.prepare("INSERT INTO paragraph_comments (id,contract_id,block_id,review_round_id,parent_comment_id,author_kind,author_id,author_display,body,status,created_at,updated_at) VALUES (?,?,?,?,NULL,'owner',?,?,?,'open',?,?)").bind(id, contractId, body.blockId, round?.id ?? null, auth.user.userId, auth.user.displayName, text, now, now), env.DB.prepare("INSERT INTO audit_log_entries (id,contract_id,actor_id,actor_display,action,target_type,target_id,request_id,metadata,created_at) VALUES (?,?,?,?, 'paragraph_comment.added','paragraph_comment',?,?,json(?),?)").bind(crypto.randomUUID(), contractId, auth.user.userId, auth.user.displayName, id, requestId, JSON.stringify({ blockId: body.blockId }), now)]);
    return Response.json({ comment: { id, body: text, authorDisplay: auth.user.displayName } }, { status: 201 });
  }
  if (body.action === "reply") {
    const text = body.body?.trim(); if (!body.blockId || !body.parentCommentId || !text || text.length > 5000) return Response.json({ error: "Choose a paragraph, the comment you are replying to, and enter a reply up to 5,000 characters" }, { status: 400 });
    const validation = await validateReplyParent(contractId, body.parentCommentId, body.blockId); if (!validation.ok) { const messages: Record<typeof validation.reason, string> = { not_found: "The comment you are replying to was not found on this contract", not_root: "Replies can only be added to the original comment, not to another reply", wrong_block: "The reply must target the same paragraph as the original comment", resolved: "This thread is resolved. Reopen it before replying." }; return Response.json({ error: messages[validation.reason] }, { status: validation.reason === "resolved" ? 409 : 400 }); }
    const round = await env.DB.prepare("SELECT id FROM review_rounds WHERE contract_id=? AND status='open' ORDER BY round_number DESC LIMIT 1").bind(contractId).first<{ id: string }>(); const id = crypto.randomUUID();
    await env.DB.batch([env.DB.prepare("INSERT INTO paragraph_comments (id,contract_id,block_id,review_round_id,parent_comment_id,author_kind,author_id,author_display,body,status,created_at,updated_at) VALUES (?,?,?,?,?,'owner',?,?,?,'open',?,?)").bind(id, contractId, body.blockId, round?.id ?? null, body.parentCommentId, auth.user.userId, auth.user.displayName, text, now, now), env.DB.prepare("INSERT INTO audit_log_entries (id,contract_id,actor_id,actor_display,action,target_type,target_id,request_id,metadata,created_at) VALUES (?,?,?,?, 'paragraph_comment.replied','paragraph_comment',?,?,json(?),?)").bind(crypto.randomUUID(), contractId, auth.user.userId, auth.user.displayName, id, requestId, JSON.stringify({ blockId: body.blockId, parentCommentId: body.parentCommentId }), now)]);
    return Response.json({ comment: { id, body: text, authorDisplay: auth.user.displayName } }, { status: 201 });
  }
  if (body.action === "resolve" && body.commentId) {
    const reason = body.reason?.trim(); if (!reason || reason.length < 3 || reason.length > 500) return Response.json({ error: "A resolution reason between 3 and 500 characters is required" }, { status: 400 });
    const root = await env.DB.prepare("SELECT id FROM paragraph_comments WHERE id=? AND contract_id=? AND status='open' AND parent_comment_id IS NULL").bind(body.commentId, contractId).first();
    if (!root) return Response.json({ error: "Open comment thread not found" }, { status: 404 });
    await env.DB.batch([
      env.DB.prepare("UPDATE paragraph_comments SET status='resolved',resolved_by=?,resolved_at=?,resolution_reason=?,updated_at=? WHERE id=? AND contract_id=?").bind(auth.user.userId, now, reason, now, body.commentId, contractId),
      env.DB.prepare("UPDATE paragraph_comments SET status='resolved',resolved_by=?,resolved_at=?,updated_at=? WHERE parent_comment_id=? AND contract_id=? AND status='open'").bind(auth.user.userId, now, now, body.commentId, contractId),
      env.DB.prepare("INSERT INTO audit_log_entries (id,contract_id,actor_id,actor_display,action,target_type,target_id,request_id,metadata,created_at) VALUES (?,?,?,?, 'paragraph_comment.resolved','paragraph_comment',?,?,json(?),?)").bind(crypto.randomUUID(), contractId, auth.user.userId, auth.user.displayName, body.commentId, requestId, JSON.stringify({ reason }), now),
    ]);
    return Response.json({ resolved: true });
  }
  if (body.action === "reopen" && body.commentId) {
    const result = await env.DB.prepare("UPDATE paragraph_comments SET status='open',reopened_by=?,reopened_at=?,resolved_by=NULL,resolved_at=NULL,resolution_reason=NULL,updated_at=? WHERE id=? AND contract_id=? AND status='resolved' AND parent_comment_id IS NULL").bind(auth.user.userId, now, now, body.commentId, contractId).run();
    if (!result.meta.changes) return Response.json({ error: "Resolved comment thread not found" }, { status: 404 });
    await env.DB.batch([
      env.DB.prepare("UPDATE paragraph_comments SET status='open',updated_at=? WHERE parent_comment_id=? AND contract_id=? AND status='resolved'").bind(now, body.commentId, contractId),
      env.DB.prepare("INSERT INTO audit_log_entries (id,contract_id,actor_id,actor_display,action,target_type,target_id,request_id,metadata,created_at) VALUES (?,?,?,?, 'paragraph_comment.reopened','paragraph_comment',?,?,json('{}'),?)").bind(crypto.randomUUID(), contractId, auth.user.userId, auth.user.displayName, body.commentId, requestId, now),
    ]);
    return Response.json({ reopened: true });
  }
  return Response.json({ error: "Action must add, reply, resolve, or reopen a comment" }, { status: 400 });
  } catch (error) {
    await captureError(error, { requestId, route: "/api/contracts/:id/comments", method: "POST", actorScope: "owner", contractId });
    return Response.json({ error: "Unable to update the paragraph discussion", requestId }, { status: 500 });
  }
}
