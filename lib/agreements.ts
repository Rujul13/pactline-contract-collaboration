import { env } from "cloudflare:workers";
import { DomainError } from "./domain-error";
import { guardedBatch, MutationConflictError, mutationGuard } from "./mutations";

type Actor = { id: string; display: string; requestId: string; ipAddress?: string; userAgent?: string };
type ContractAgreementRow = { id: string; current_version: number; status: string; crm_record_id: string | null; initiator_external_id: string; initiator_party_id: string };

export async function recordInitiatorAgreement(contractId: string, actor: Actor) {
  const db = env.DB;
  const contract = await db.prepare(`
    SELECT c.id, c.current_version, c.status, c.crm_record_id,
      initiator.external_identity_id AS initiator_external_id,
      party.id AS initiator_party_id
    FROM contracts c
    JOIN users initiator ON initiator.id = c.initiator_id
    JOIN parties party ON party.contract_id = c.id AND party.role = 'initiator'
    WHERE c.id = ?
  `).bind(contractId).first<ContractAgreementRow>();
  if (!contract) throw new DomainError("Contract not found", 404);
  if (contract.initiator_external_id !== actor.id) throw new DomainError("You do not have permission to agree for the initiator", 403);
  if (contract.status === "locked") throw new DomainError("The contract is already locked", 409);
  const pending = await db.prepare("SELECT COUNT(*) AS total FROM paragraph_proposals WHERE contract_id = ? AND status = 'pending'").bind(contractId).first<{ total: number }>();
  if ((pending?.total ?? 0) > 0) throw new DomainError("Resolve every pending proposal before agreeing", 409);
  const incompleteApprovals = await db.prepare("SELECT COUNT(*) AS total FROM approval_requests WHERE contract_id=? AND version_number=? AND required=1 AND status!='approved'").bind(contractId, contract.current_version).first<{ total: number }>();
  if ((incompleteApprovals?.total ?? 0) > 0) throw new DomainError("Complete every required internal approval before the owner agrees", 409);

  const existing = await db.prepare("SELECT id FROM agreements WHERE contract_id = ? AND party_id = ? AND version_number = ?").bind(contractId, contract.initiator_party_id, contract.current_version).first<{ id: string }>();
  if (existing) return { agreed: true, locked: false, versionNumber: contract.current_version };

  const now = new Date().toISOString();
  const agreementId = crypto.randomUUID();
  const auditId = crypto.randomUUID();
  await db.batch([
    db.prepare("INSERT INTO agreements (id, contract_id, party_id, version_number, agreed_by, agreed_at) VALUES (?, ?, ?, ?, ?, ?)").bind(agreementId, contractId, contract.initiator_party_id, contract.current_version, actor.id, now),
    db.prepare("INSERT INTO audit_log_entries (id, contract_id, actor_id, actor_display, action, target_type, target_id, version_number, request_id, ip_address, user_agent, metadata, created_at) VALUES (?, ?, ?, ?, 'contract.agreed', 'agreement', ?, ?, ?, ?, ?, json(?), ?)").bind(auditId, contractId, actor.id, actor.display, agreementId, contract.current_version, actor.requestId, actor.ipAddress ?? null, actor.userAgent ?? null, JSON.stringify({ partyRole: "initiator" }), now),
  ]);

  const agreementCount = await db.prepare("SELECT COUNT(DISTINCT party_id) AS total FROM agreements WHERE contract_id = ? AND version_number = ?").bind(contractId, contract.current_version).first<{ total: number }>();
  if ((agreementCount?.total ?? 0) < 2) return { agreed: true, locked: false, versionNumber: contract.current_version };

  const lockAuditId = crypto.randomUUID();
  const lockGuard = mutationGuard(
    "EXISTS (SELECT 1 FROM contracts c WHERE c.id=? AND c.current_version=? AND c.status!='locked' AND NOT EXISTS (SELECT 1 FROM paragraph_proposals p WHERE p.contract_id=c.id AND p.status='pending') AND NOT EXISTS (SELECT 1 FROM approval_requests a WHERE a.contract_id=c.id AND a.version_number=c.current_version AND a.required=1 AND a.status!='approved') AND (SELECT COUNT(DISTINCT party_id) FROM agreements WHERE contract_id=c.id AND version_number=c.current_version)>=2)",
    [contractId, contract.current_version],
  );
  try {
    await guardedBatch(lockGuard, [
    db.prepare("UPDATE contracts SET status = 'locked', locked_at = ?, updated_at = ? WHERE id = ? AND current_version = ? AND status != 'locked'").bind(now, now, contractId, contract.current_version),
    db.prepare("INSERT INTO audit_log_entries (id, contract_id, actor_id, actor_display, action, target_type, target_id, version_number, request_id, ip_address, user_agent, metadata, created_at) VALUES (?, ?, ?, ?, 'contract.locked', 'contract', ?, ?, ?, ?, ?, json(?), ?)").bind(lockAuditId, contractId, actor.id, actor.display, contractId, contract.current_version, actor.requestId, actor.ipAddress ?? null, actor.userAgent ?? null, JSON.stringify({ bothPartiesAgreed: true }), now),
    ]);
  } catch (error) {
    if (error instanceof MutationConflictError) {
      const latest = await db.prepare("SELECT status FROM contracts WHERE id=?").bind(contractId).first<{ status: string }>();
      if (latest?.status === "locked") return { agreed: true, locked: true, versionNumber: contract.current_version };
      throw new DomainError("The contract lock conflicted with another request", 409);
    }
    throw error;
  }
  return { agreed: true, locked: true, versionNumber: contract.current_version };
}

export async function recordCounterpartyAgreement(contractId: string, session: { accountId: string; partyId: string; name: string; username: string }, requestId: string) {
  const db = env.DB;
  const contract = await db.prepare("SELECT current_version, status FROM contracts WHERE id=?").bind(contractId).first<{ current_version: number; status: string }>();
  if (!contract) throw new DomainError("Contract not found", 404);
  if (contract.status === "locked") return { agreed: true, locked: true, versionNumber: contract.current_version };
  const pending = await db.prepare("SELECT COUNT(*) AS total FROM paragraph_proposals WHERE contract_id=? AND status='pending'").bind(contractId).first<{ total: number }>();
  if ((pending?.total ?? 0) > 0) throw new DomainError("Resolve every pending proposal before agreeing", 409);
  const party = await db.prepare("SELECT id FROM parties WHERE id=? AND contract_id=? AND role='counterparty'").bind(session.partyId, contractId).first();
  if (!party) throw new DomainError("You cannot agree for this contract", 403);
  const existing = await db.prepare("SELECT id FROM agreements WHERE contract_id=? AND party_id=? AND version_number=?").bind(contractId, session.partyId, contract.current_version).first();
  if (!existing) {
    const now = new Date().toISOString();
    await db.batch([
      db.prepare("INSERT INTO agreements (id, contract_id, party_id, version_number, agreed_by, agreed_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), contractId, session.partyId, contract.current_version, session.accountId, now),
      db.prepare("INSERT INTO audit_log_entries (id, contract_id, actor_id, actor_display, action, target_type, target_id, version_number, request_id, metadata, created_at) VALUES (?, ?, ?, ?, 'contract.agreed', 'contract', ?, ?, ?, json(?), ?)").bind(crypto.randomUUID(), contractId, session.accountId, `${session.name} (${session.username})`, contractId, contract.current_version, requestId, JSON.stringify({ partyRole: "counterparty" }), now),
    ]);
  }
  const agreementCount = await db.prepare("SELECT COUNT(DISTINCT party_id) AS total FROM agreements WHERE contract_id=? AND version_number=?").bind(contractId, contract.current_version).first<{ total: number }>();
  if ((agreementCount?.total ?? 0) < 2) return { agreed: true, locked: false, versionNumber: contract.current_version };
  const incompleteApprovals = await db.prepare("SELECT COUNT(*) AS total FROM approval_requests WHERE contract_id=? AND version_number=? AND required=1 AND status!='approved'").bind(contractId, contract.current_version).first<{ total: number }>();
  if ((incompleteApprovals?.total ?? 0) > 0) return { agreed: true, locked: false, approvalPending: true, versionNumber: contract.current_version };
  const now = new Date().toISOString();
  const lockGuard = mutationGuard(
    "EXISTS (SELECT 1 FROM contracts c WHERE c.id=? AND c.current_version=? AND c.status!='locked' AND NOT EXISTS (SELECT 1 FROM paragraph_proposals p WHERE p.contract_id=c.id AND p.status='pending') AND NOT EXISTS (SELECT 1 FROM approval_requests a WHERE a.contract_id=c.id AND a.version_number=c.current_version AND a.required=1 AND a.status!='approved') AND (SELECT COUNT(DISTINCT party_id) FROM agreements WHERE contract_id=c.id AND version_number=c.current_version)>=2)",
    [contractId, contract.current_version],
  );
  try {
    await guardedBatch(lockGuard, [
    db.prepare("UPDATE contracts SET status='locked', locked_at=?, updated_at=? WHERE id=? AND current_version=? AND status!='locked'").bind(now, now, contractId, contract.current_version),
    db.prepare("INSERT INTO audit_log_entries (id, contract_id, actor_id, actor_display, action, target_type, target_id, version_number, request_id, metadata, created_at) VALUES (?, ?, ?, ?, 'contract.locked', 'contract', ?, ?, ?, json(?), ?)").bind(crypto.randomUUID(), contractId, session.accountId, `${session.name} (${session.username})`, contractId, contract.current_version, requestId, JSON.stringify({ bothPartiesAgreed: true }), now),
    ]);
  } catch (error) {
    if (error instanceof MutationConflictError) {
      const latest = await db.prepare("SELECT status FROM contracts WHERE id=?").bind(contractId).first<{ status: string }>();
      if (latest?.status === "locked") return { agreed: true, locked: true, versionNumber: contract.current_version };
      throw new DomainError("The contract lock conflicted with another request", 409);
    }
    throw error;
  }
  return { agreed: true, locked: true, versionNumber: contract.current_version };
}
