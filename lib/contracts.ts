import { env } from "cloudflare:workers";

export type ResolveAction = "accept" | "reject" | "counter";

type Actor = { id: string; display: string; requestId: string; ipAddress?: string; userAgent?: string };

type ProposalRow = {
  id: string;
  contract_id: string;
  clause_id: string;
  version_number: number;
  original_text: string;
  proposed_text: string;
  rationale: string;
  status: string;
  current_version: number;
  contract_status: string;
  current_text: string;
  initiator_external_id: string;
};

type ClauseRow = { id: string; clause_key: string; order_index: number; title: string; current_text: string; clause_type: string };

export class DomainError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function resolveProposal(contractId: string, proposalId: string, action: ResolveAction, actor: Actor, counterText?: string) {
  const db = env.DB;
  const proposal = await db.prepare(`
    SELECT p.*, c.current_version, c.status AS contract_status, cl.current_text, initiator.external_identity_id AS initiator_external_id
    FROM proposed_changes p
    JOIN contracts c ON c.id = p.contract_id
    JOIN clauses cl ON cl.id = p.clause_id
    JOIN users initiator ON initiator.id = c.initiator_id
    WHERE p.id = ? AND p.contract_id = ?
  `).bind(proposalId, contractId).first<ProposalRow>();

  if (!proposal) throw new DomainError("Proposal not found", 404);
  if (proposal.initiator_external_id !== actor.id) throw new DomainError("You do not have permission to resolve proposals for this contract", 403);
  if (proposal.status !== "pending") throw new DomainError("This proposal has already been resolved", 409);
  if (["agreed", "locked"].includes(proposal.contract_status)) throw new DomainError("The contract is locked for changes", 409);
  if (proposal.version_number !== proposal.current_version) throw new DomainError("This proposal targets an older contract version", 409);
  if (proposal.current_text !== proposal.original_text) throw new DomainError("The clause changed after this proposal was created", 409);

  const now = new Date().toISOString();
  const auditId = crypto.randomUUID();
  const commonAudit = [auditId, contractId, actor.id, actor.display, `proposal.${action}`, "proposed_change", proposalId, proposal.clause_id, proposal.current_version, actor.requestId, actor.ipAddress ?? null, actor.userAgent ?? null, now];

  if (action === "reject") {
    const results = await db.batch([
      db.prepare("UPDATE proposed_changes SET status = 'rejected', resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ? AND status = 'pending'").bind(now, actor.id, now, proposalId),
      db.prepare("INSERT INTO audit_log_entries (id, contract_id, actor_id, actor_display, action, target_type, target_id, clause_id, version_number, request_id, ip_address, user_agent, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json(?), ?)").bind(...commonAudit.slice(0, 12), JSON.stringify({ rationale: proposal.rationale }), now),
    ]);
    if ((results[0].meta.changes ?? 0) !== 1) throw new DomainError("Proposal resolution conflicted with another request", 409);
    return { status: "rejected" as const, versionNumber: proposal.current_version };
  }

  if (action === "counter") {
    const cleanCounter = counterText?.trim();
    if (!cleanCounter || cleanCounter.length < 10) throw new DomainError("Counterproposal text must contain at least 10 characters");
    const counterId = crypto.randomUUID();
    const results = await db.batch([
      db.prepare("UPDATE proposed_changes SET status = 'countered', resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ? AND status = 'pending'").bind(now, actor.id, now, proposalId),
      db.prepare("INSERT INTO proposed_changes (id, contract_id, clause_id, version_number, proposed_by, original_text, proposed_text, rationale, parent_change_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)").bind(counterId, contractId, proposal.clause_id, proposal.current_version, actor.id, proposal.current_text, cleanCounter, "Alternative language proposed by the initiator", proposalId, now, now),
      db.prepare("INSERT INTO audit_log_entries (id, contract_id, actor_id, actor_display, action, target_type, target_id, clause_id, version_number, request_id, ip_address, user_agent, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json(?), ?)").bind(...commonAudit.slice(0, 12), JSON.stringify({ counterProposalId: counterId }), now),
    ]);
    if ((results[0].meta.changes ?? 0) !== 1) throw new DomainError("Proposal resolution conflicted with another request", 409);
    return { status: "countered" as const, versionNumber: proposal.current_version, counterProposalId: counterId };
  }

  const clausesResult = await db.prepare("SELECT id, clause_key, order_index, title, current_text, clause_type FROM clauses WHERE contract_id = ? ORDER BY order_index").bind(contractId).all<ClauseRow>();
  const clauses = clausesResult.results;
  const nextVersion = proposal.current_version + 1;
  const versionId = crypto.randomUUID();
  const parent = await db.prepare("SELECT id FROM contract_versions WHERE contract_id = ? AND version_number = ?").bind(contractId, proposal.current_version).first<{ id: string }>();
  const snapshot = clauses.map((clause) => ({ id: clause.id, clauseKey: clause.clause_key, orderIndex: clause.order_index, title: clause.title, text: clause.id === proposal.clause_id ? proposal.proposed_text : clause.current_text, clauseType: clause.clause_type }));
  const beforeHash = await sha256(proposal.current_text);
  const afterHash = await sha256(proposal.proposed_text);

  const results = await db.batch([
    db.prepare("UPDATE proposed_changes SET status = 'accepted', resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ? AND status = 'pending'").bind(now, actor.id, now, proposalId),
    db.prepare("UPDATE clauses SET current_text = ?, updated_at = ? WHERE id = ? AND current_text = ?").bind(proposal.proposed_text, now, proposal.clause_id, proposal.current_text),
    db.prepare("INSERT INTO contract_versions (id, contract_id, version_number, created_by, snapshot, parent_version_id, created_at) VALUES (?, ?, ?, ?, json(?), ?, ?)").bind(versionId, contractId, nextVersion, actor.id, JSON.stringify(snapshot), parent?.id ?? null, now),
    db.prepare("UPDATE contracts SET current_version = ?, status = 'negotiating', updated_at = ? WHERE id = ? AND current_version = ? AND status NOT IN ('agreed', 'locked')").bind(nextVersion, now, contractId, proposal.current_version),
    db.prepare("INSERT INTO audit_log_entries (id, contract_id, actor_id, actor_display, action, target_type, target_id, clause_id, version_number, before_hash, after_hash, request_id, ip_address, user_agent, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json(?), ?)").bind(auditId, contractId, actor.id, actor.display, "proposal.accept", "proposed_change", proposalId, proposal.clause_id, nextVersion, beforeHash, afterHash, actor.requestId, actor.ipAddress ?? null, actor.userAgent ?? null, JSON.stringify({ previousVersion: proposal.current_version }), now),
  ]);

  if ((results[0].meta.changes ?? 0) !== 1 || (results[1].meta.changes ?? 0) !== 1 || (results[3].meta.changes ?? 0) !== 1) {
    throw new DomainError("Proposal acceptance conflicted with another request", 409);
  }
  return { status: "accepted" as const, versionNumber: nextVersion, clauseText: proposal.proposed_text, versionId };
}
