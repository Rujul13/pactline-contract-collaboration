import { env } from "cloudflare:workers";
import { portalGrant, requirePortalSession } from "@/lib/portal-auth";

export async function POST(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const auth = await requirePortalSession(request); if (auth.response) return auth.response;
  const { contractId } = await context.params; const grant = await portalGrant(auth.session!, contractId);
  if (!grant || !["comment", "propose_changes"].includes(grant.permission)) return Response.json({ error: "You cannot comment on this contract" }, { status: 403 });
  const body = await request.json().catch(() => null) as { blockId?: string; body?: string; parentCommentId?: string } | null; const text = body?.body?.trim();
  if (!body?.blockId || !text || text.length > 5000) return Response.json({ error: "Choose a paragraph and enter a comment up to 5,000 characters" }, { status: 400 });
  const block = await env.DB.prepare("SELECT id FROM document_blocks WHERE id=? AND contract_id=?").bind(body.blockId, contractId).first(); if (!block) return Response.json({ error: "Paragraph not found" }, { status: 404 });
  const round = await env.DB.prepare("SELECT id FROM review_rounds WHERE contract_id=? AND status='open' ORDER BY round_number DESC LIMIT 1").bind(contractId).first<{ id: string }>(); const now = new Date().toISOString(); const id = crypto.randomUUID(); const display = `${auth.session!.displayName} (${auth.session!.username})`;
  await env.DB.prepare("INSERT INTO paragraph_comments (id,contract_id,block_id,review_round_id,parent_comment_id,author_kind,author_id,author_display,body,status,created_at,updated_at) VALUES (?,?,?,?,?,'reviewer',?,?,?,'open',?,?)").bind(id, contractId, body.blockId, round?.id ?? null, body.parentCommentId ?? null, auth.session!.accountId, display, text, now, now).run();
  return Response.json({ comment: { id, body: text, authorDisplay: display } }, { status: 201 });
}
