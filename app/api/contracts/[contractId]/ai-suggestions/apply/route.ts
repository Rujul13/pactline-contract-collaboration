import { env } from "cloudflare:workers";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { currentGroqModel } from "@/lib/ai-assistant";
import { sha256Hex } from "@/lib/security";
import { guardedBatch, MutationConflictError, mutationGuard } from "@/lib/mutations";

type ApplyBody = { baseVersion?: number; operation?: "insert_clause" | "replace_block"; targetBlockId?: string | null; afterBlockId?: string | null; heading?: string | null; paragraphs?: string[]; replacementText?: string | null };
type BlockRow = { id: string; block_key: string; order_index: number; kind: string; current_text: string };

export async function POST(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const { contractId } = await context.params;
  let body: ApplyBody;
  try { body = await request.json() as ApplyBody; } catch { return Response.json({ error: "Valid JSON is required" }, { status: 400 }); }
  if (!Number.isInteger(body.baseVersion) || !body.operation || !["insert_clause", "replace_block"].includes(body.operation)) return Response.json({ error: "A valid AI suggestion and base version are required" }, { status: 400 });
  const contract = await env.DB.prepare(`SELECT c.current_version, c.status, c.initiator_id FROM contracts c JOIN users u ON u.id=c.initiator_id WHERE c.id=? AND u.external_identity_id=?`).bind(contractId, user.userId).first<{ current_version: number; status: string; initiator_id: string }>();
  if (!contract) return Response.json({ error: "Contract not found" }, { status: 404 });
  if (["agreed", "locked"].includes(contract.status)) return Response.json({ error: "The contract is locked" }, { status: 409 });
  if (contract.current_version !== body.baseVersion) return Response.json({ error: "The document changed. Generate or review the suggestion again." }, { status: 409 });
  const pending = await env.DB.prepare("SELECT COUNT(*) AS total FROM paragraph_proposals WHERE contract_id=? AND status='pending'").bind(contractId).first<{ total: number }>();
  if ((pending?.total ?? 0) > 0) return Response.json({ error: "Resolve pending client proposals before applying an AI draft" }, { status: 409 });
  const blocks = await env.DB.prepare("SELECT id, block_key, order_index, kind, current_text FROM document_blocks WHERE contract_id=? ORDER BY order_index").bind(contractId).all<BlockRow>();
  const now = new Date().toISOString(); const nextVersion = contract.current_version + 1; const versionId = crypto.randomUUID(); const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();

  if (body.operation === "replace_block") {
    const target = blocks.results.find((block) => block.id === body.targetBlockId); const replacement = body.replacementText?.trim();
    if (!target) return Response.json({ error: "Selected paragraph not found" }, { status: 404 });
    if (!replacement || replacement.length < 10 || replacement.length > 50_000 || replacement === target.current_text) return Response.json({ error: "The replacement must contain changed paragraph text" }, { status: 400 });
    const afterHash = await sha256Hex(replacement); const beforeHash = await sha256Hex(target.current_text);
    const snapshot = blocks.results.map((block) => ({ ...block, current_text: block.id === target.id ? replacement : block.current_text }));
    const guard = mutationGuard(
      "EXISTS (SELECT 1 FROM contracts c JOIN document_blocks b ON b.contract_id=c.id WHERE c.id=? AND c.current_version=? AND c.status NOT IN ('agreed','locked') AND b.id=? AND b.current_text=? AND NOT EXISTS (SELECT 1 FROM paragraph_proposals p WHERE p.contract_id=c.id AND p.status='pending'))",
      [contractId, contract.current_version, target.id, target.current_text],
    );
    try {
      await guardedBatch(guard, [
      env.DB.prepare("UPDATE document_blocks SET current_text=?, content_hash=?, updated_at=? WHERE id=? AND current_text=?").bind(replacement, afterHash, now, target.id, target.current_text),
      env.DB.prepare("INSERT INTO contract_versions (id, contract_id, version_number, created_by, snapshot, created_at) VALUES (?, ?, ?, ?, json(?), ?)").bind(versionId, contractId, nextVersion, contract.initiator_id, JSON.stringify(snapshot), now),
      env.DB.prepare("UPDATE contracts SET current_version=?, status='negotiating', updated_at=? WHERE id=? AND current_version=?").bind(nextVersion, now, contractId, contract.current_version),
      env.DB.prepare("INSERT INTO audit_log_entries (id, contract_id, actor_id, actor_display, action, target_type, target_id, version_number, before_hash, after_hash, request_id, metadata, created_at) VALUES (?, ?, ?, ?, 'ai.paragraph_rewritten', 'document_block', ?, ?, ?, ?, ?, json(?), ?)").bind(crypto.randomUUID(), contractId, user.userId, user.displayName, target.id, nextVersion, beforeHash, afterHash, requestId, JSON.stringify({ previousVersion: contract.current_version, model: currentGroqModel() }), now),
      ]);
    } catch (error) {
      if (error instanceof MutationConflictError) return Response.json({ error: "The AI edit conflicted with another change" }, { status: 409 });
      throw error;
    }
    return Response.json({ versionNumber: nextVersion, operation: body.operation, updatedBlockId: target.id });
  }

  const heading = body.heading?.trim(); const paragraphs = Array.isArray(body.paragraphs) ? body.paragraphs.slice(0, 6).map((paragraph) => paragraph.trim()).filter(Boolean) : [];
  if (!heading || heading.length > 300 || paragraphs.length < 1 || paragraphs.some((paragraph) => paragraph.length < 10 || paragraph.length > 50_000)) return Response.json({ error: "Clause heading and 1–6 valid paragraphs are required" }, { status: 400 });
  const afterBlock = body.afterBlockId ? blocks.results.find((block) => block.id === body.afterBlockId) : null;
  if (body.afterBlockId && !afterBlock) return Response.json({ error: "Clause placement paragraph not found" }, { status: 404 });
  const insertAt = afterBlock ? afterBlock.order_index + 1 : blocks.results.length; const additions = [{ id: crypto.randomUUID(), block_key: `ai-${crypto.randomUUID()}`, order_index: insertAt, kind: "heading", current_text: heading }, ...paragraphs.map((paragraph, index) => ({ id: crypto.randomUUID(), block_key: `ai-${crypto.randomUUID()}`, order_index: insertAt + index + 1, kind: "body", current_text: paragraph }))];
  const hashes = await Promise.all(additions.map((block) => sha256Hex(block.current_text)));
  const shifted = blocks.results.map((block) => ({ ...block, order_index: block.order_index >= insertAt ? block.order_index + additions.length : block.order_index }));
  const snapshot = [...shifted, ...additions].sort((left, right) => left.order_index - right.order_index);
  const statements = [];
  if (insertAt < blocks.results.length) {
    statements.push(env.DB.prepare("UPDATE document_blocks SET order_index=order_index+1000000 WHERE contract_id=? AND order_index>=?").bind(contractId, insertAt));
    statements.push(env.DB.prepare("UPDATE document_blocks SET order_index=order_index-1000000+? WHERE contract_id=? AND order_index>=?").bind(additions.length, contractId, 1000000 + insertAt));
  }
  statements.push(...additions.map((block, index) => env.DB.prepare("INSERT INTO document_blocks (id, contract_id, block_key, order_index, kind, current_text, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(block.id, contractId, block.block_key, block.order_index, block.kind, block.current_text, hashes[index], now, now)));
  statements.push(
    env.DB.prepare("INSERT INTO contract_versions (id, contract_id, version_number, created_by, snapshot, created_at) VALUES (?, ?, ?, ?, json(?), ?)").bind(versionId, contractId, nextVersion, contract.initiator_id, JSON.stringify(snapshot), now),
    env.DB.prepare("UPDATE contracts SET current_version=?, status='negotiating', updated_at=? WHERE id=? AND current_version=?").bind(nextVersion, now, contractId, contract.current_version),
    env.DB.prepare("INSERT INTO audit_log_entries (id, contract_id, actor_id, actor_display, action, target_type, target_id, version_number, request_id, metadata, created_at) VALUES (?, ?, ?, ?, 'ai.clause_inserted', 'document_block', ?, ?, ?, json(?), ?)").bind(crypto.randomUUID(), contractId, user.userId, user.displayName, additions[0].id, nextVersion, requestId, JSON.stringify({ previousVersion: contract.current_version, model: currentGroqModel(), insertedBlockIds: additions.map((block) => block.id), afterBlockId: afterBlock?.id ?? null }), now),
  );
  const guard = mutationGuard(
    "EXISTS (SELECT 1 FROM contracts c WHERE c.id=? AND c.current_version=? AND c.status NOT IN ('agreed','locked') AND NOT EXISTS (SELECT 1 FROM paragraph_proposals p WHERE p.contract_id=c.id AND p.status='pending'))",
    [contractId, contract.current_version],
  );
  try {
    await guardedBatch(guard, statements);
  } catch (error) {
    if (error instanceof MutationConflictError) return Response.json({ error: "The clause insertion conflicted with another change" }, { status: 409 });
    throw error;
  }
  return Response.json({ versionNumber: nextVersion, operation: body.operation, insertedBlockIds: additions.map((block) => block.id) });
}
