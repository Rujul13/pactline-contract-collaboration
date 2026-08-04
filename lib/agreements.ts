import { env } from "cloudflare:workers";
import { DomainError } from "./contracts";

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
  const pending = await db.prepare("SELECT COUNT(*) AS total FROM proposed_changes WHERE contract_id = ? AND status = 'pending'").bind(contractId).first<{ total: number }>();
  if ((pending?.total ?? 0) > 0) throw new DomainError("Resolve every pending proposal before agreeing", 409);

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
  const crmOutboxId = crypto.randomUUID();
  const notificationOutboxId = crypto.randomUUID();
  const results = await db.batch([
    db.prepare("UPDATE contracts SET status = 'locked', locked_at = ?, updated_at = ? WHERE id = ? AND current_version = ? AND status != 'locked'").bind(now, now, contractId, contract.current_version),
    db.prepare("INSERT INTO audit_log_entries (id, contract_id, actor_id, actor_display, action, target_type, target_id, version_number, request_id, ip_address, user_agent, metadata, created_at) VALUES (?, ?, ?, ?, 'contract.locked', 'contract', ?, ?, ?, ?, ?, json(?), ?)").bind(lockAuditId, contractId, actor.id, actor.display, contractId, contract.current_version, actor.requestId, actor.ipAddress ?? null, actor.userAgent ?? null, JSON.stringify({ bothPartiesAgreed: true }), now),
    db.prepare("INSERT INTO integration_outbox (id, contract_id, destination, event_type, payload, created_at) VALUES (?, ?, 'crm', 'contract_locked', json(?), ?)").bind(crmOutboxId, contractId, JSON.stringify({ crmRecordId: contract.crm_record_id, status: "locked", versionNumber: contract.current_version }), now),
    db.prepare("INSERT INTO integration_outbox (id, contract_id, destination, event_type, payload, created_at) VALUES (?, ?, 'notifications', 'contract_locked', json(?), ?)").bind(notificationOutboxId, contractId, JSON.stringify({ status: "locked", versionNumber: contract.current_version }), now),
  ]);
  if ((results[0].meta.changes ?? 0) !== 1) throw new DomainError("The contract lock conflicted with another request", 409);
  return { agreed: true, locked: true, versionNumber: contract.current_version };
}
