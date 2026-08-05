import { env } from "cloudflare:workers";
import { getChatGPTUser } from "@/app/chatgpt-auth";

export async function GET(_request: Request, context: { params: Promise<{ contractId: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const { contractId } = await context.params;
  const contract = await env.DB.prepare(`SELECT c.id, c.title, c.status, c.current_version, c.updated_at FROM contracts c JOIN users u ON u.id = c.initiator_id WHERE c.id = ? AND u.external_identity_id = ?`).bind(contractId, user.userId).first();
  if (!contract) return Response.json({ error: "Contract not found" }, { status: 404 });
  const [blocks, proposals, parties, documents, versions, agreements, activity, access] = await Promise.all([
    env.DB.prepare("SELECT id, block_key, order_index, kind, current_text, content_hash, updated_at FROM document_blocks WHERE contract_id = ? ORDER BY order_index").bind(contractId).all(),
    env.DB.prepare(`SELECT p.id, p.block_id, p.base_version, p.original_text, p.proposed_text, p.counter_text, p.rationale, p.status, p.created_at, a.username, party.name AS proposed_by_name FROM paragraph_proposals p JOIN access_accounts a ON a.id = p.proposed_by_account_id JOIN parties party ON party.id = a.party_id WHERE p.contract_id = ? ORDER BY p.created_at DESC`).bind(contractId).all(),
    env.DB.prepare("SELECT id, role, name, company, email FROM parties WHERE contract_id = ? ORDER BY role").bind(contractId).all(),
    env.DB.prepare("SELECT id, filename, byte_size, sha256, scan_status, created_at FROM document_objects WHERE contract_id = ? ORDER BY created_at DESC").bind(contractId).all(),
    env.DB.prepare("SELECT id, version_number, created_by, document_sha256, created_at FROM contract_versions WHERE contract_id = ? ORDER BY version_number DESC").bind(contractId).all(),
    env.DB.prepare("SELECT a.party_id, a.version_number, a.agreed_at, p.role, p.name FROM agreements a JOIN parties p ON p.id = a.party_id WHERE a.contract_id = ? ORDER BY a.agreed_at DESC").bind(contractId).all(),
    env.DB.prepare("SELECT id, actor_display, action, target_type, version_number, metadata, created_at FROM audit_log_entries WHERE contract_id = ? ORDER BY created_at DESC LIMIT 50").bind(contractId).all(),
    env.DB.prepare("SELECT a.id, a.username, a.permission, a.status, a.expires_at, a.last_signed_in_at, p.name, p.email FROM access_accounts a JOIN parties p ON p.id=a.party_id WHERE a.contract_id=? ORDER BY a.created_at DESC").bind(contractId).all(),
  ]);
  return Response.json({ contract, blocks: blocks.results, proposals: proposals.results, parties: parties.results, documents: documents.results, versions: versions.results, agreements: agreements.results, activity: activity.results, access: access.results }, { headers: { "cache-control": "private, no-store" } });
}
