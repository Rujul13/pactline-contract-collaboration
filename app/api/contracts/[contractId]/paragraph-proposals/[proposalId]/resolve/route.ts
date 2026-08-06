import { env } from "cloudflare:workers";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { sha256Hex } from "@/lib/security";
import { guardedBatch, MutationConflictError, mutationGuard } from "@/lib/mutations";

type ProposalRow = { id: string; block_id: string; base_version: number; original_text: string; proposed_text: string; status: string; current_text: string; current_version: number; contract_status: string };

export async function POST(request: Request, context: { params: Promise<{ contractId: string; proposalId: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const { contractId, proposalId } = await context.params;
  let body: { action?: "accept" | "reject" | "counter"; counterText?: string };
  try { body = await request.json() as typeof body; } catch { return Response.json({ error: "Valid JSON is required" }, { status: 400 }); }
  if (!body.action || !["accept", "reject", "counter"].includes(body.action)) return Response.json({ error: "Action must be accept, reject, or counter" }, { status: 400 });
  const owner = await env.DB.prepare("SELECT c.id FROM contracts c JOIN users u ON u.id = c.initiator_id WHERE c.id = ? AND u.external_identity_id = ?").bind(contractId, user.userId).first();
  if (!owner) return Response.json({ error: "Contract not found" }, { status: 404 });
  const proposal = await env.DB.prepare(`SELECT p.*, b.current_text, c.current_version, c.status AS contract_status FROM paragraph_proposals p JOIN document_blocks b ON b.id = p.block_id JOIN contracts c ON c.id = p.contract_id WHERE p.id = ? AND p.contract_id = ?`).bind(proposalId, contractId).first<ProposalRow>();
  if (!proposal) return Response.json({ error: "Proposal not found" }, { status: 404 });
  if (proposal.status !== "pending") return Response.json({ error: "Proposal was already resolved" }, { status: 409 });
  if (["agreed", "locked"].includes(proposal.contract_status) || proposal.base_version !== proposal.current_version || proposal.current_text !== proposal.original_text) return Response.json({ error: "Proposal is stale or the contract is locked" }, { status: 409 });
  const now = new Date().toISOString(); const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const proposalGuard = () => mutationGuard(
    "EXISTS (SELECT 1 FROM paragraph_proposals p JOIN document_blocks b ON b.id=p.block_id JOIN contracts c ON c.id=p.contract_id WHERE p.id=? AND p.contract_id=? AND p.status='pending' AND p.base_version=c.current_version AND b.current_text=p.original_text AND c.status NOT IN ('agreed','locked'))",
    [proposalId, contractId],
  );
  if (body.action === "reject") {
    try {
      await guardedBatch(proposalGuard(), [
      env.DB.prepare("UPDATE paragraph_proposals SET status = 'rejected', resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ? AND status = 'pending'").bind(now, user.userId, now, proposalId),
      env.DB.prepare("INSERT INTO audit_log_entries (id, contract_id, actor_id, actor_display, action, target_type, target_id, request_id, metadata, created_at) VALUES (?, ?, ?, ?, 'paragraph_proposal.rejected', 'paragraph_proposal', ?, ?, json(?), ?)").bind(crypto.randomUUID(), contractId, user.userId, user.displayName, proposalId, requestId, "{}", now),
      ]);
    } catch (error) {
      if (error instanceof MutationConflictError) return Response.json({ error: "Resolution conflicted with another request" }, { status: 409 });
      throw error;
    }
    return Response.json({ status: "rejected", versionNumber: proposal.current_version });
  }
  if (body.action === "counter") {
    const counterText = body.counterText?.trim();
    if (!counterText || counterText.length < 10 || counterText.length > 50_000) return Response.json({ error: "Counterproposal must contain between 10 and 50,000 characters" }, { status: 400 });
    if (counterText === proposal.original_text || counterText === proposal.proposed_text) return Response.json({ error: "Counterproposal must differ from both existing versions" }, { status: 400 });
    try {
      await guardedBatch(proposalGuard(), [
      env.DB.prepare("UPDATE paragraph_proposals SET status = 'countered', counter_text = ?, resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ? AND status = 'pending'").bind(counterText, now, user.userId, now, proposalId),
      env.DB.prepare("INSERT INTO audit_log_entries (id, contract_id, actor_id, actor_display, action, target_type, target_id, version_number, request_id, metadata, created_at) VALUES (?, ?, ?, ?, 'paragraph_proposal.countered', 'paragraph_proposal', ?, ?, ?, json(?), ?)").bind(crypto.randomUUID(), contractId, user.userId, user.displayName, proposalId, proposal.current_version, requestId, JSON.stringify({ blockId: proposal.block_id, counterText }), now),
      ]);
    } catch (error) {
      if (error instanceof MutationConflictError) return Response.json({ error: "Resolution conflicted with another request" }, { status: 409 });
      throw error;
    }
    return Response.json({ status: "countered", versionNumber: proposal.current_version });
  }
  const nextVersion = proposal.current_version + 1; const blocks = await env.DB.prepare("SELECT id, block_key, order_index, kind, current_text FROM document_blocks WHERE contract_id = ? ORDER BY order_index").bind(contractId).all<Record<string, unknown>>();
  const snapshot = blocks.results.map((block) => ({ ...block, current_text: block.id === proposal.block_id ? proposal.proposed_text : block.current_text }));
  const beforeHash = await sha256Hex(proposal.original_text); const afterHash = await sha256Hex(proposal.proposed_text); const versionId = crypto.randomUUID();
  try {
    await guardedBatch(proposalGuard(), [
    env.DB.prepare("UPDATE paragraph_proposals SET status = 'accepted', resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ? AND status = 'pending'").bind(now, user.userId, now, proposalId),
    env.DB.prepare("UPDATE document_blocks SET current_text = ?, content_hash = ?, updated_at = ? WHERE id = ? AND current_text = ?").bind(proposal.proposed_text, afterHash, now, proposal.block_id, proposal.original_text),
    env.DB.prepare("INSERT INTO contract_versions (id, contract_id, version_number, created_by, snapshot, created_at) VALUES (?, ?, ?, ?, json(?), ?)").bind(versionId, contractId, nextVersion, user.userId, JSON.stringify(snapshot), now),
    env.DB.prepare("UPDATE contracts SET current_version = ?, status = 'negotiating', updated_at = ? WHERE id = ? AND current_version = ? AND status NOT IN ('agreed', 'locked')").bind(nextVersion, now, contractId, proposal.current_version),
    env.DB.prepare("INSERT INTO audit_log_entries (id, contract_id, actor_id, actor_display, action, target_type, target_id, version_number, before_hash, after_hash, request_id, metadata, created_at) VALUES (?, ?, ?, ?, 'paragraph_proposal.accepted', 'paragraph_proposal', ?, ?, ?, ?, ?, json(?), ?)").bind(crypto.randomUUID(), contractId, user.userId, user.displayName, proposalId, nextVersion, beforeHash, afterHash, requestId, JSON.stringify({ previousVersion: proposal.current_version, blockId: proposal.block_id }), now),
    ]);
  } catch (error) {
    if (error instanceof MutationConflictError) return Response.json({ error: "Acceptance conflicted with another request" }, { status: 409 });
    throw error;
  }
  return Response.json({ status: "accepted", versionNumber: nextVersion });
}
