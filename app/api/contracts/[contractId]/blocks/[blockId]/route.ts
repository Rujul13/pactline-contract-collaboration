import { env } from "cloudflare:workers";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { sha256Hex } from "@/lib/security";

export async function POST(request: Request, context: { params: Promise<{ contractId: string; blockId: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const { contractId, blockId } = await context.params;
  const body = await request.json().catch(() => null) as { text?: string; baseVersion?: number } | null;
  const text = body?.text?.trim();
  if (!text || text.length > 50_000 || !Number.isInteger(body?.baseVersion)) return Response.json({ error: "Valid paragraph text and base version are required" }, { status: 400 });
  const row = await env.DB.prepare(`SELECT b.current_text, c.current_version, c.status, c.initiator_id FROM document_blocks b JOIN contracts c ON c.id=b.contract_id JOIN users u ON u.id=c.initiator_id WHERE b.id=? AND b.contract_id=? AND u.external_identity_id=?`).bind(blockId, contractId, user.userId).first<{ current_text: string; current_version: number; status: string; initiator_id: string }>();
  if (!row) return Response.json({ error: "Paragraph not found" }, { status: 404 });
  if (["agreed", "locked"].includes(row.status) || row.current_version !== body!.baseVersion) return Response.json({ error: "The document changed or is locked" }, { status: 409 });
  if (row.current_text === text) return Response.json({ error: "The paragraph has not changed" }, { status: 400 });
  const nextVersion = row.current_version + 1; const now = new Date().toISOString(); const afterHash = await sha256Hex(text);
  const blocks = await env.DB.prepare("SELECT id, block_key, order_index, kind, current_text FROM document_blocks WHERE contract_id=? ORDER BY order_index").bind(contractId).all<Record<string, unknown>>();
  const snapshot = blocks.results.map((block) => ({ ...block, current_text: block.id === blockId ? text : block.current_text }));
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE document_blocks SET current_text=?, content_hash=?, updated_at=? WHERE id=? AND current_text=?").bind(text, afterHash, now, blockId, row.current_text),
    env.DB.prepare("INSERT INTO contract_versions (id, contract_id, version_number, created_by, snapshot, created_at) VALUES (?, ?, ?, ?, json(?), ?)").bind(crypto.randomUUID(), contractId, nextVersion, row.initiator_id, JSON.stringify(snapshot), now),
    env.DB.prepare("UPDATE contracts SET current_version=?, status='negotiating', updated_at=? WHERE id=? AND current_version=?").bind(nextVersion, now, contractId, row.current_version),
    env.DB.prepare("INSERT INTO audit_log_entries (id, contract_id, actor_id, actor_display, action, target_type, target_id, version_number, before_hash, after_hash, request_id, metadata, created_at) VALUES (?, ?, ?, 'Contract Owner', 'paragraph.updated', 'document_block', ?, ?, ?, ?, ?, json(?), ?)").bind(crypto.randomUUID(), contractId, user.userId, blockId, nextVersion, await sha256Hex(row.current_text), afterHash, crypto.randomUUID(), JSON.stringify({ previousVersion: row.current_version }), now),
  ]);
  if ((results[0].meta.changes ?? 0) !== 1 || (results[2].meta.changes ?? 0) !== 1) return Response.json({ error: "The update conflicted with another change" }, { status: 409 });
  return Response.json({ versionNumber: nextVersion, text });
}
