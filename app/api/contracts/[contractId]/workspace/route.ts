import { env } from "cloudflare:workers";
import { getChatGPTUser } from "@/app/chatgpt-auth";

export async function GET(_request: Request, context: { params: Promise<{ contractId: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const { contractId } = await context.params;
  const contract = await env.DB.prepare(`SELECT c.id, c.title, c.status, c.current_version, c.updated_at FROM contracts c JOIN users u ON u.id = c.initiator_id WHERE c.id = ? AND u.external_identity_id = ?`).bind(contractId, user.userId).first();
  if (!contract) return Response.json({ error: "Contract not found" }, { status: 404 });
  const [blocks, proposals, parties, documents] = await Promise.all([
    env.DB.prepare("SELECT id, block_key, order_index, kind, current_text, content_hash, updated_at FROM document_blocks WHERE contract_id = ? ORDER BY order_index").bind(contractId).all(),
    env.DB.prepare(`SELECT p.id, p.block_id, p.base_version, p.original_text, p.proposed_text, p.rationale, p.status, p.created_at, a.username, party.name AS proposed_by_name FROM paragraph_proposals p JOIN access_accounts a ON a.id = p.proposed_by_account_id JOIN parties party ON party.id = a.party_id WHERE p.contract_id = ? ORDER BY p.created_at DESC`).bind(contractId).all(),
    env.DB.prepare("SELECT id, role, name, company, email FROM parties WHERE contract_id = ? ORDER BY role").bind(contractId).all(),
    env.DB.prepare("SELECT id, filename, byte_size, sha256, scan_status, created_at FROM document_objects WHERE contract_id = ? ORDER BY created_at DESC").bind(contractId).all(),
  ]);
  return Response.json({ contract, blocks: blocks.results, proposals: proposals.results, parties: parties.results, documents: documents.results }, { headers: { "cache-control": "private, no-store" } });
}
