import { env } from "cloudflare:workers";
import { requireOwnerApi } from "@/lib/owner-boundary";
import { parseDocxBytes, sha256BufferHex } from "@/lib/docx-server";
import { sha256Hex } from "@/lib/security";
import { DEMO_OWNER_ORGANIZATION_ID } from "@/lib/v2";

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function POST(request: Request) {
  const auth = await requireOwnerApi(request);
  if (auth.response) return auth.response;
  const user = auth.user;
  const form = await request.formData();
  const file = form.get("document");
  const title = String(form.get("title") ?? "").trim().slice(0, 160);
  const clientCompany = String(form.get("clientCompany") ?? "Customer Company").trim().slice(0, 120) || "Customer Company";
  const reviewerName = String(form.get("reviewerName") ?? "Customer Reviewer").trim().slice(0, 120) || "Customer Reviewer";
  const reviewerEmail = String(form.get("reviewerEmail") ?? "reviewer@example.test").trim().slice(0, 254) || "reviewer@example.test";
  if (!title || !(file instanceof File)) return Response.json({ error: "A contract title and DOCX document are required" }, { status: 400 });
  if (!file.name.toLowerCase().endsWith(".docx")) return Response.json({ error: "Only .docx Word documents are accepted" }, { status: 415 });
  if (file.size <= 0 || file.size > 15 * 1024 * 1024) return Response.json({ error: "The DOCX document must be between 1 byte and 15 MB" }, { status: 413 });
  const bytes = await file.arrayBuffer();
  let blocks;
  try { blocks = parseDocxBytes(bytes); } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Unable to read the Word document" }, { status: 400 }); }
  const owner = await env.DB.prepare("SELECT id FROM users WHERE external_identity_id = ?").bind(user.userId).first<{ id: string }>();
  if (!owner) return Response.json({ error: "Open the workspace once before creating a contract" }, { status: 409 });

  const contractId = crypto.randomUUID(); const ownerPartyId = crypto.randomUUID(); const clientPartyId = crypto.randomUUID(); const versionId = crypto.randomUUID(); const documentId = crypto.randomUUID();
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120); const objectKey = `contracts/${contractId}/versions/1/${documentId}-${safeName}`;
  const now = new Date().toISOString(); const sha256 = await sha256BufferHex(bytes);
  const rows = await Promise.all(blocks.map(async (block, index) => ({ id: crypto.randomUUID(), blockKey: `paragraph-${index + 1}`, orderIndex: index, ...block, hash: await sha256Hex(block.text) })));
  const snapshot = rows.map((block) => ({ id: block.id, block_key: block.blockKey, order_index: block.orderIndex, kind: block.kind, current_text: block.text }));
  await env.DOCUMENTS.put(objectKey, bytes, { httpMetadata: { contentType: DOCX_TYPE }, customMetadata: { contractId, documentId, sha256, uploadedBy: user.userId } });
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO contracts (id, title, initiator_id, approver_id, responsible_owner_id, owner_organization_id, status, lifecycle_stage, current_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'draft', 'draft', 1, ?, ?)").bind(contractId, title, owner.id, owner.id, owner.id, DEMO_OWNER_ORGANIZATION_ID, now, now),
      env.DB.prepare("INSERT INTO parties (id, contract_id, role, name, company, email, created_at, updated_at) VALUES (?, ?, 'initiator', 'Vendor Admin', 'Vendor Company', ?, ?, ?)").bind(ownerPartyId, contractId, user.email, now, now),
      env.DB.prepare("INSERT INTO parties (id, contract_id, role, name, company, email, created_at, updated_at) VALUES (?, ?, 'counterparty', ?, ?, ?, ?, ?)").bind(clientPartyId, contractId, reviewerName, clientCompany, reviewerEmail, now, now),
      ...rows.map((block) => env.DB.prepare("INSERT INTO document_blocks (id, contract_id, block_key, order_index, kind, current_text, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(block.id, contractId, block.blockKey, block.orderIndex, block.kind, block.text, block.hash, now, now)),
      env.DB.prepare("INSERT INTO contract_versions (id, contract_id, version_number, created_by, snapshot, document_object_key, document_sha256, created_at) VALUES (?, ?, 1, ?, json(?), ?, ?, ?)").bind(versionId, contractId, owner.id, JSON.stringify(snapshot), objectKey, sha256, now),
      env.DB.prepare("INSERT INTO document_objects (id, contract_id, object_key, filename, content_type, byte_size, sha256, scan_status, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)").bind(documentId, contractId, objectKey, safeName, DOCX_TYPE, bytes.byteLength, sha256, owner.id, now),
      env.DB.prepare("INSERT INTO audit_log_entries (id, contract_id, actor_id, actor_display, action, target_type, target_id, version_number, request_id, metadata, created_at) VALUES (?, ?, ?, 'Vendor Admin', 'contract.created', 'contract', ?, 1, ?, json(?), ?)").bind(crypto.randomUUID(), contractId, owner.id, contractId, crypto.randomUUID(), JSON.stringify({ filename: safeName, paragraphs: rows.length, scanStatus: "pending" }), now),
    ]);
  } catch (error) {
    await env.DOCUMENTS.delete(objectKey);
    throw error;
  }
  return Response.json({ contract: { id: contractId, title, status: "draft", current_version: 1 } }, { status: 201 });
}
