import { env } from "cloudflare:workers";
import { portalGrant, requirePortalSession } from "@/lib/portal-auth";
import { guardedBatch, MutationConflictError, mutationGuard } from "@/lib/mutations";

type ProposedEdit = { blockId?: string; originalText?: string; proposedText?: string; rationale?: string };

async function contextFor(request: Request, contractId: string) {
  const auth = await requirePortalSession(request);
  if (auth.response) return { response: auth.response };
  const grant = await portalGrant(auth.session!, contractId);
  if (!grant) return { response: Response.json({ error: "Contract not found" }, { status: 404 }) };
  const row = await env.DB.prepare("SELECT g.legacy_access_account_id,p.id AS party_id FROM contract_access_grants g JOIN contracts c ON c.id=g.contract_id JOIN parties p ON p.contract_id=c.id AND p.role='counterparty' WHERE g.contract_id=? AND g.portal_account_id=?").bind(contractId, auth.session!.accountId).first<{ legacy_access_account_id: string | null; party_id: string }>();
  return { session: auth.session!, grant, legacyAccountId: row?.legacy_access_account_id ?? null, partyId: row?.party_id ?? null };
}

export async function GET(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const { contractId } = await context.params;
  const access = await contextFor(request, contractId);
  if (access.response) return access.response;
  const [contract, blocks, proposals, agreements] = await Promise.all([
    env.DB.prepare("SELECT id,title,status,current_version,origin,effective_date,expiration_date,updated_at FROM contracts WHERE id=?").bind(contractId).first(),
    env.DB.prepare("SELECT id,block_key,order_index,kind,current_text FROM document_blocks WHERE contract_id=? ORDER BY order_index").bind(contractId).all(),
    access.legacyAccountId ? env.DB.prepare("SELECT id,block_id,base_version,original_text,proposed_text,counter_text,rationale,status,created_at FROM paragraph_proposals WHERE contract_id=? AND proposed_by_account_id=? ORDER BY created_at DESC").bind(contractId, access.legacyAccountId).all() : Promise.resolve({ results: [] }),
    env.DB.prepare("SELECT party_id,version_number FROM agreements WHERE contract_id=? AND version_number=(SELECT current_version FROM contracts WHERE id=?)").bind(contractId, contractId).all(),
  ]);
  if (!contract) return Response.json({ error: "Contract not found" }, { status: 404 });
  return Response.json({ contract, blocks: blocks.results, proposals: proposals.results, agreements: agreements.results, reviewer: { name: access.session!.displayName, company: access.session!.organizationName, username: access.session!.username, permission: access.grant!.permission, partyId: access.partyId } }, { headers: { "cache-control": "private, no-store" } });
}

export async function POST(request: Request, context: { params: Promise<{ contractId: string }> }) {
  if (Number(request.headers.get("content-length") ?? 0) > 1_048_576) return Response.json({ error: "Proposal payload is too large" }, { status: 413 });
  const { contractId } = await context.params;
  const access = await contextFor(request, contractId);
  if (access.response) return access.response;
  if (access.grant!.permission !== "propose_changes" || !access.legacyAccountId) return Response.json({ error: "You cannot propose changes to this contract" }, { status: 403 });
  const body = await request.json().catch(() => null) as { baseVersion?: number; edits?: ProposedEdit[] } | null;
  if (!body || !Number.isInteger(body.baseVersion) || !Array.isArray(body.edits) || body.edits.length < 1 || body.edits.length > 100) return Response.json({ error: "Submit between 1 and 100 edits with a base version" }, { status: 400 });
  const contract = await env.DB.prepare("SELECT current_version,status FROM contracts WHERE id=?").bind(contractId).first<{ current_version: number; status: string }>();
  if (!contract || contract.current_version !== body.baseVersion || ["agreed", "locked"].includes(contract.status)) return Response.json({ error: "The document changed or is locked. Refresh before submitting." }, { status: 409 });
  const seen = new Set<string>();
  const prepared: Array<{ id: string; blockId: string; original: string; proposed: string; rationale: string | null }> = [];
  for (const edit of body.edits) {
    const blockId = edit.blockId?.trim(); const original = edit.originalText?.trim(); const proposed = edit.proposedText?.trim();
    if (!blockId || !original || !proposed || original === proposed || proposed.length > 50_000 || seen.has(blockId)) return Response.json({ error: "Each edit must target one unique paragraph with changed text" }, { status: 400 });
    const block = await env.DB.prepare("SELECT current_text FROM document_blocks WHERE id=? AND contract_id=?").bind(blockId, contractId).first<{ current_text: string }>();
    if (!block || block.current_text !== original) return Response.json({ error: "A paragraph changed during review. Refresh before submitting." }, { status: 409 });
    seen.add(blockId); prepared.push({ id: crypto.randomUUID(), blockId, original, proposed, rationale: edit.rationale?.trim().slice(0, 2_000) || null });
  }
  const now = new Date().toISOString();
  const statements = prepared.flatMap((edit) => [
    env.DB.prepare("UPDATE paragraph_proposals SET status='superseded',updated_at=? WHERE contract_id=? AND block_id=? AND proposed_by_account_id=? AND status='countered'").bind(now, contractId, edit.blockId, access.legacyAccountId),
    env.DB.prepare("INSERT INTO paragraph_proposals (id,contract_id,block_id,base_version,proposed_by_account_id,original_text,proposed_text,rationale,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'pending',?,?)").bind(edit.id, contractId, edit.blockId, body.baseVersion, access.legacyAccountId, edit.original, edit.proposed, edit.rationale, now, now),
  ]);
  statements.push(env.DB.prepare("INSERT INTO audit_log_entries (id,contract_id,actor_id,actor_display,action,target_type,request_id,metadata,created_at) VALUES (?,?,?,?, 'paragraph_proposals.submitted','contract',?,json(?),?)").bind(crypto.randomUUID(), contractId, access.session!.accountId, `${access.session!.displayName} (${access.session!.username})`, crypto.randomUUID(), JSON.stringify({ proposalIds: prepared.map((item) => item.id), count: prepared.length, baseVersion: body.baseVersion, portal: true }), now));
  const conditions = prepared.map(() => "EXISTS (SELECT 1 FROM document_blocks WHERE id=? AND contract_id=? AND current_text=?)").join(" AND ");
  try {
    await guardedBatch(mutationGuard(`EXISTS (SELECT 1 FROM contracts WHERE id=? AND current_version=? AND status NOT IN ('agreed','locked')) AND ${conditions}`, [contractId, body.baseVersion, ...prepared.flatMap((item) => [item.blockId, contractId, item.original])]), statements);
  } catch (error) {
    if (error instanceof MutationConflictError) return Response.json({ error: "The document changed during review. Refresh before submitting." }, { status: 409 });
    throw error;
  }
  return Response.json({ proposals: prepared.map((item) => ({ id: item.id, blockId: item.blockId, status: "pending" })) }, { status: 201 });
}
