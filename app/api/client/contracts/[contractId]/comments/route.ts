import { env } from "cloudflare:workers";
import { getClientSession } from "@/lib/client-auth";

type ParentRow = { id: string; block_id: string; status: string; parent_comment_id: string | null };

export async function POST(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const session = await getClientSession(request); if (!session) return Response.json({ error: "Authentication required" }, { status: 401 });
  const { contractId } = await context.params;
  if (session.contractId !== contractId) return Response.json({ error: "Contract not found" }, { status: 404 });
  if (!["comment", "propose_changes"].includes(session.permission)) return Response.json({ error: "You cannot comment on this contract" }, { status: 403 });
  let body: { blockId?: string; body?: string; parentCommentId?: string }; try { body = await request.json() as typeof body; } catch { return Response.json({ error: "Valid JSON is required" }, { status: 400 }); }
  const text = body.body?.trim(); if (!body.blockId || !text || text.length > 5000) return Response.json({ error: "Choose a paragraph and enter a comment up to 5,000 characters" }, { status: 400 });
  const block = await env.DB.prepare("SELECT id FROM document_blocks WHERE id=? AND contract_id=?").bind(body.blockId, contractId).first(); if (!block) return Response.json({ error: "Paragraph not found" }, { status: 404 });
  if (body.parentCommentId) {
    const parent = await env.DB.prepare("SELECT id, block_id, status, parent_comment_id FROM paragraph_comments WHERE id=? AND contract_id=?").bind(body.parentCommentId, contractId).first<ParentRow>();
    if (!parent) return Response.json({ error: "The comment you are replying to was not found on this contract" }, { status: 400 });
    if (parent.parent_comment_id !== null) return Response.json({ error: "Replies can only be added to the original comment, not to another reply" }, { status: 400 });
    if (parent.block_id !== body.blockId) return Response.json({ error: "The reply must target the same paragraph as the original comment" }, { status: 400 });
    if (parent.status === "resolved") return Response.json({ error: "This thread is resolved. Ask the contract owner to reopen it before replying." }, { status: 409 });
  }
  const round = await env.DB.prepare("SELECT id FROM review_rounds WHERE contract_id=? AND status='open' ORDER BY round_number DESC LIMIT 1").bind(contractId).first<{ id: string }>(); const now = new Date().toISOString(); const id = crypto.randomUUID(); const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  await env.DB.batch([env.DB.prepare("INSERT INTO paragraph_comments (id,contract_id,block_id,review_round_id,parent_comment_id,author_kind,author_id,author_display,body,status,created_at,updated_at) VALUES (?,?,?,?,?,'reviewer',?,?,?,'open',?,?)").bind(id, contractId, body.blockId, round?.id ?? null, body.parentCommentId ?? null, session.accountId, `${session.name} (${session.username})`, text, now, now), env.DB.prepare("INSERT INTO audit_log_entries (id,contract_id,actor_id,actor_display,action,target_type,target_id,request_id,metadata,created_at) VALUES (?,?,?,?, ?,'paragraph_comment',?,?,json(?),?)").bind(crypto.randomUUID(), contractId, session.accountId, `${session.name} (${session.username})`, body.parentCommentId ? "paragraph_comment.replied" : "paragraph_comment.added", id, requestId, JSON.stringify({ blockId: body.blockId }), now)]);
  return Response.json({ comment: { id, body: text, authorDisplay: session.name } }, { status: 201 });
}
