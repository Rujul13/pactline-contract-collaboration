import { env } from "cloudflare:workers";
import { diffText } from "./text-diff";

export const LIFECYCLE_STAGES = ["draft", "internal_review", "external_review", "approved", "executed", "expired", "renewed"] as const;
export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;

export async function ownerContract(contractId: string, externalIdentityId: string) {
  return env.DB.prepare(`SELECT c.*, u.display_name AS responsible_owner_name
    FROM contracts c JOIN users owner ON owner.id=c.initiator_id
    LEFT JOIN users u ON u.id=COALESCE(c.responsible_owner_id,c.initiator_id)
    WHERE c.id=? AND owner.external_identity_id=?`).bind(contractId, externalIdentityId).first<Record<string, unknown>>();
}

export async function workflowWorkspace(contractId: string) {
  const [rounds, comments, approvals, relationships, reminders, errors] = await Promise.all([
    env.DB.prepare("SELECT * FROM review_rounds WHERE contract_id=? ORDER BY round_number DESC").bind(contractId).all(),
    env.DB.prepare("SELECT * FROM paragraph_comments WHERE contract_id=? ORDER BY created_at ASC").bind(contractId).all(),
    env.DB.prepare("SELECT a.*,u.display_name AS approver_name FROM approval_requests a JOIN users u ON u.id=a.approver_id WHERE a.contract_id=? ORDER BY a.created_at DESC").bind(contractId).all(),
    env.DB.prepare(`SELECT r.*,source.title AS source_title,target.title AS target_title FROM contract_relationships r
      JOIN contracts source ON source.id=r.source_contract_id JOIN contracts target ON target.id=r.target_contract_id
      WHERE r.source_contract_id=? OR r.target_contract_id=? ORDER BY r.created_at DESC`).bind(contractId, contractId).all(),
    env.DB.prepare("SELECT * FROM reminder_schedules WHERE contract_id=? ORDER BY due_at ASC").bind(contractId).all(),
    env.DB.prepare("SELECT id,request_id,route,method,severity,message,occurrence_count,first_seen_at,last_seen_at,resolved_at FROM error_events WHERE contract_id=? OR contract_id IS NULL ORDER BY resolved_at IS NOT NULL,last_seen_at DESC LIMIT 25").bind(contractId).all(),
  ]);
  return { reviewRounds: rounds.results, comments: comments.results, approvals: approvals.results, relationships: relationships.results, reminders: reminders.results, errors: errors.results };
}

type SnapshotBlock = { id: string; block_key: string; order_index: number; kind: string; current_text: string };
function parseSnapshot(value: unknown): SnapshotBlock[] {
  if (Array.isArray(value)) return value as SnapshotBlock[];
  if (typeof value !== "string") return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

export async function compareVersions(contractId: string, from: number, to: number) {
  const versions = await env.DB.prepare("SELECT version_number,snapshot,created_at FROM contract_versions WHERE contract_id=? AND version_number IN (?,?) ORDER BY version_number").bind(contractId, from, to).all<{ version_number: number; snapshot: unknown; created_at: string }>();
  const fromVersion = versions.results.find((item) => item.version_number === from);
  const toVersion = versions.results.find((item) => item.version_number === to);
  if (!fromVersion || !toVersion) return null;
  const oldBlocks = parseSnapshot(fromVersion.snapshot); const newBlocks = parseSnapshot(toVersion.snapshot);
  const oldByKey = new Map(oldBlocks.map((block) => [block.block_key || block.id, block]));
  const newByKey = new Map(newBlocks.map((block) => [block.block_key || block.id, block]));
  const keys = [...new Set([...oldByKey.keys(), ...newByKey.keys()])];
  const blocks = keys.map((key) => {
    const oldBlock = oldByKey.get(key); const newBlock = newByKey.get(key);
    const originalText = oldBlock?.current_text ?? ""; const proposedText = newBlock?.current_text ?? "";
    return { key, kind: newBlock?.kind ?? oldBlock?.kind ?? "body", orderIndex: newBlock?.order_index ?? oldBlock?.order_index ?? 0, originalText, proposedText, changed: originalText !== proposedText, diff: diffText(originalText, proposedText) };
  }).sort((a, b) => a.orderIndex - b.orderIndex);
  return { from: { number: fromVersion.version_number, createdAt: fromVersion.created_at }, to: { number: toVersion.version_number, createdAt: toVersion.created_at }, blocks, changedCount: blocks.filter((block) => block.changed).length };
}

export function calendarText(contract: Record<string, unknown>, reminders: Array<Record<string, unknown>>) {
  const escape = (value: unknown) => String(value ?? "").replaceAll("\\", "\\\\").replaceAll(",", "\\,").replaceAll(";", "\\;").replaceAll("\n", "\\n");
  const stamp = (value: unknown) => String(value ?? "").replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const events = reminders.filter((item) => item.status === "scheduled").map((item) => [
    "BEGIN:VEVENT", `UID:${escape(item.id)}@pactline`, `DTSTAMP:${stamp(new Date().toISOString())}`, `DTSTART:${stamp(item.due_at)}`,
    `SUMMARY:${escape(`${contract.title}: ${String(item.kind).replaceAll("_", " ")}`)}`, `DESCRIPTION:${escape(`Pactline reminder for ${contract.title}`)}`, "END:VEVENT",
  ].join("\r\n"));
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Pactline//Contract Reminders//EN", "CALSCALE:GREGORIAN", ...events, "END:VCALENDAR", ""].join("\r\n");
}
