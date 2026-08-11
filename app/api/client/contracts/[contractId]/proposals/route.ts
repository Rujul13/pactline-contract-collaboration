import { env } from "cloudflare:workers";
import { getClientSession } from "@/lib/client-auth";
import { guardedBatch, MutationConflictError, mutationGuard } from "@/lib/mutations";

type ProposedEdit = { blockId?: string; originalText?: string; proposedText?: string; rationale?: string };

export async function GET(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const session = await getClientSession(request);
  if (!session) return Response.json({ error: "Authentication required" }, { status: 401, headers: { "cache-control": "no-store" } });
  const { contractId } = await context.params;
  if (session.contractId !== contractId) return Response.json({ error: "Contract not found" }, { status: 404 });
  const [contract, blocks, proposals, agreements, comments, reviewRound] = await Promise.all([
    env.DB.prepare("SELECT id, title, status, current_version, lifecycle_stage, review_deadline_at, updated_at FROM contracts WHERE id = ?").bind(contractId).first(),
    env.DB.prepare("SELECT id, block_key, order_index, kind, current_text FROM document_blocks WHERE contract_id = ? ORDER BY order_index").bind(contractId).all(),
    env.DB.prepare("SELECT id, block_id, base_version, original_text, proposed_text, counter_text, rationale, resolution_reason, review_round_id, status, created_at FROM paragraph_proposals WHERE contract_id = ? AND proposed_by_account_id = ? ORDER BY created_at DESC").bind(contractId, session.accountId).all(),
    env.DB.prepare("SELECT party_id, version_number FROM agreements WHERE contract_id=? AND version_number=(SELECT current_version FROM contracts WHERE id=?)").bind(contractId, contractId).all(),
    env.DB.prepare("SELECT id,block_id,review_round_id,parent_comment_id,author_kind,author_display,body,status,created_at FROM paragraph_comments WHERE contract_id=? ORDER BY created_at ASC").bind(contractId).all(),
    env.DB.prepare("SELECT id,round_number,status,deadline_at FROM review_rounds WHERE contract_id=? ORDER BY round_number DESC LIMIT 1").bind(contractId).first(),
  ]);
  if (!contract) return Response.json({ error: "Contract not found" }, { status: 404 });
  return Response.json({ contract, blocks: blocks.results, proposals: proposals.results, agreements: agreements.results, comments: comments.results, reviewRound, reviewer: { name: session.name, company: session.company, username: session.username, permission: session.permission, partyId: session.partyId } }, { headers: { "cache-control": "private, no-store" } });
}

export async function POST(request: Request, context: { params: Promise<{ contractId: string }> }) {
  if (Number(request.headers.get("content-length") ?? 0) > 1_048_576) return Response.json({ error: "Proposal payload is too large" }, { status: 413 });
  const session = await getClientSession(request);
  if (!session) return Response.json({ error: "Authentication required" }, { status: 401 });
  const { contractId } = await context.params;
  if (session.contractId !== contractId || session.permission !== "propose_changes") return Response.json({ error: "You cannot propose changes to this contract" }, { status: 403 });
  let body: { baseVersion?: number; edits?: ProposedEdit[] };
  try { body = await request.json() as typeof body; } catch { return Response.json({ error: "Valid JSON is required" }, { status: 400 }); }
  if (!Number.isInteger(body.baseVersion) || !Array.isArray(body.edits) || body.edits.length < 1 || body.edits.length > 100) return Response.json({ error: "Submit between 1 and 100 edits with a base version" }, { status: 400 });
  const contract = await env.DB.prepare("SELECT current_version, status FROM contracts WHERE id = ?").bind(contractId).first<{ current_version: number; status: string }>();
  if (!contract) return Response.json({ error: "Contract not found" }, { status: 404 });
  if (["agreed", "locked"].includes(contract.status)) return Response.json({ error: "The contract is locked" }, { status: 409 });
  if (contract.current_version !== body.baseVersion) return Response.json({ error: "The document changed during your review. Refresh before submitting." }, { status: 409 });
  const ids = new Set<string>(); const prepared: Array<{ id: string; blockId: string; original: string; proposed: string; rationale: string | null }> = [];
  for (const edit of body.edits) {
    const blockId = edit.blockId?.trim(); const original = edit.originalText?.trim(); const proposed = edit.proposedText?.trim();
    if (!blockId || !original || !proposed || original === proposed || proposed.length > 50_000 || ids.has(blockId)) return Response.json({ error: "Each edit must target one unique paragraph with changed text" }, { status: 400 });
    const block = await env.DB.prepare("SELECT current_text FROM document_blocks WHERE id = ? AND contract_id = ?").bind(blockId, contractId).first<{ current_text: string }>();
    if (!block || block.current_text !== original) return Response.json({ error: "A paragraph changed during your review. Refresh before submitting." }, { status: 409 });
    ids.add(blockId); prepared.push({ id: crypto.randomUUID(), blockId, original, proposed, rationale: edit.rationale?.trim().slice(0, 2000) || null });
  }
  const now = new Date().toISOString(); const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const reviewRound = await env.DB.prepare("SELECT id FROM review_rounds WHERE contract_id=? AND status='open' ORDER BY round_number DESC LIMIT 1").bind(contractId).first<{ id: string }>();
  const statements = prepared.flatMap((edit) => [
    env.DB.prepare("UPDATE paragraph_proposals SET status = 'superseded', updated_at = ? WHERE contract_id = ? AND block_id = ? AND proposed_by_account_id = ? AND status = 'countered'").bind(now, contractId, edit.blockId, session.accountId),
    env.DB.prepare("INSERT INTO paragraph_proposals (id, contract_id, block_id, base_version, proposed_by_account_id, original_text, proposed_text, rationale, review_round_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)").bind(edit.id, contractId, edit.blockId, body.baseVersion, session.accountId, edit.original, edit.proposed, edit.rationale, reviewRound?.id ?? null, now, now),
  ]);
  statements.push(env.DB.prepare("INSERT INTO audit_log_entries (id, contract_id, actor_id, actor_display, action, target_type, request_id, metadata, created_at) VALUES (?, ?, ?, ?, 'paragraph_proposals.submitted', 'contract', ?, json(?), ?)").bind(crypto.randomUUID(), contractId, session.accountId, `${session.name} (${session.username})`, requestId, JSON.stringify({ proposalIds: prepared.map((edit) => edit.id), count: prepared.length, baseVersion: body.baseVersion }), now));
  const blockConditions = prepared.map(() => "EXISTS (SELECT 1 FROM document_blocks WHERE id=? AND contract_id=? AND current_text=?)").join(" AND ");
  const guard = mutationGuard(
    `EXISTS (SELECT 1 FROM contracts WHERE id=? AND current_version=? AND status NOT IN ('agreed','locked')) AND ${blockConditions}`,
    [contractId, body.baseVersion, ...prepared.flatMap((edit) => [edit.blockId, contractId, edit.original])],
  );
  try {
    await guardedBatch(guard, statements);
  } catch (error) {
    if (error instanceof MutationConflictError) return Response.json({ error: "The document changed during your review. Refresh before submitting." }, { status: 409 });
    throw error;
  }
  return Response.json({ proposals: prepared.map((edit) => ({ id: edit.id, blockId: edit.blockId, status: "pending" })) }, { status: 201 });
}
