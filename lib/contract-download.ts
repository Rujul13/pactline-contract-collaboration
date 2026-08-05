import { env } from "cloudflare:workers";
import { createDocumentDocx, type DocumentBlock } from "./docx";
import { sha256BufferHex } from "./docx-server";

export async function renderContractDocx(contractId: string) {
  const contract = await env.DB.prepare("SELECT id, title, current_version, status, initiator_id FROM contracts WHERE id=?").bind(contractId).first<{ id: string; title: string; current_version: number; status: string; initiator_id: string }>();
  if (!contract) return null;
  const rows = await env.DB.prepare("SELECT id, kind, current_text FROM document_blocks WHERE contract_id=? ORDER BY order_index").bind(contractId).all<{ id: string; kind: DocumentBlock["kind"]; current_text: string }>();
  const blocks = rows.results.map((row) => ({ id: row.id, kind: row.kind, text: row.current_text }));
  const blob = createDocumentDocx(contract.title, contract.current_version, blocks);
  return { contract, blob, bytes: await blob.arrayBuffer(), filename: `${contract.title.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "")}-v${contract.current_version}.docx` };
}

export async function ensureFinalDocument(contractId: string) {
  const rendered = await renderContractDocx(contractId);
  if (!rendered || rendered.contract.status !== "locked") return null;
  const key = `contracts/${contractId}/final/v${rendered.contract.current_version}.docx`;
  const existing = await env.DB.prepare("SELECT id FROM document_objects WHERE object_key=?").bind(key).first();
  if (!existing) {
    const sha256 = await sha256BufferHex(rendered.bytes); const now = new Date().toISOString(); const documentId = crypto.randomUUID();
    await env.DOCUMENTS.put(key, rendered.bytes, { httpMetadata: { contentType: rendered.blob.type }, customMetadata: { contractId, version: String(rendered.contract.current_version), final: "true" } });
    await env.DB.batch([
      env.DB.prepare("INSERT INTO document_objects (id, contract_id, object_key, filename, content_type, byte_size, sha256, scan_status, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)").bind(documentId, contractId, key, rendered.filename, rendered.blob.type, rendered.bytes.byteLength, sha256, rendered.contract.initiator_id, now),
      env.DB.prepare("UPDATE contract_versions SET document_object_key=?, document_sha256=? WHERE contract_id=? AND version_number=?").bind(key, sha256, contractId, rendered.contract.current_version),
    ]);
  }
  return rendered;
}

export function docxResponse(rendered: NonNullable<Awaited<ReturnType<typeof renderContractDocx>>>) {
  return new Response(rendered.bytes, { headers: { "content-type": rendered.blob.type, "content-disposition": `attachment; filename="${rendered.filename}"`, "cache-control": "private, no-store" } });
}

