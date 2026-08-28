import { env } from "cloudflare:workers";
import { requireOwnerApi } from "@/lib/owner-boundary";
import { parseDocxBytes, sha256BufferHex } from "@/lib/docx-server";
import { sha256Hex } from "@/lib/security";
import { DEMO_CONTRACT_ID } from "@/lib/demo";
import { guardedBatch, MutationConflictError, mutationGuard } from "@/lib/mutations";
import { prepareNextVersionApprovalStatements } from "@/lib/approver-auth";

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX_DOCX_BYTES = 15 * 1024 * 1024;

export async function POST(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const auth = await requireOwnerApi(request);
  if (auth.response) return auth.response;
  const user = auth.user;
  const { contractId } = await context.params;
  if (contractId === DEMO_CONTRACT_ID) return Response.json({ error: "The public sample cannot accept private uploads. Create a new contract instead." }, { status: 403 });
  const authorized = await env.DB.prepare("SELECT c.id FROM contracts c JOIN users u ON u.id = c.initiator_id WHERE c.id = ? AND u.external_identity_id = ? AND c.status NOT IN ('agreed', 'locked')").bind(contractId, user.userId).first();
  if (!authorized) return Response.json({ error: "Contract not found or upload is not permitted" }, { status: 404 });

  const form = await request.formData();
  const file = form.get("document");
  if (!(file instanceof File)) return Response.json({ error: "A DOCX document is required" }, { status: 400 });
  if (!file.name.toLowerCase().endsWith(".docx")) return Response.json({ error: "Only modern .docx Word documents are accepted" }, { status: 415 });
  if (file.size <= 0 || file.size > MAX_DOCX_BYTES) return Response.json({ error: "The DOCX document must be between 1 byte and 15 MB" }, { status: 413 });

  const body = await file.arrayBuffer();
  let parsed;
  try { parsed = parseDocxBytes(body); } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Unable to read the Word document" }, { status: 400 }); }
  const sha256 = await sha256BufferHex(body);
  const documentId = crypto.randomUUID();
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  const contract = await env.DB.prepare("SELECT current_version, initiator_id FROM contracts WHERE id=?").bind(contractId).first<{ current_version: number; initiator_id: string }>();
  if (!contract) return Response.json({ error: "Contract not found" }, { status: 404 });
  const nextVersion = contract.current_version + 1;
  const objectKey = `contracts/${contractId}/versions/${nextVersion}/${documentId}-${safeName}`;
  await env.DOCUMENTS.put(objectKey, body, { httpMetadata: { contentType: DOCX_TYPE }, customMetadata: { contractId, documentId, sha256, uploadedBy: user.userId } });

  const now = new Date().toISOString();
  try {
    const rows = await Promise.all(parsed.map(async (block, index) => ({ id: crypto.randomUUID(), blockKey: `paragraph-${index + 1}`, orderIndex: index, ...block, hash: await sha256Hex(block.text) })));
    const snapshot = rows.map((block) => ({ id: block.id, block_key: block.blockKey, order_index: block.orderIndex, kind: block.kind, current_text: block.text }));
    const guard = mutationGuard(
      "EXISTS (SELECT 1 FROM contracts WHERE id=? AND current_version=? AND status NOT IN ('agreed','locked'))",
      [contractId, contract.current_version],
    );

    // Prepare fresh version-scoped approval assignments atomically inside the same batch
    const nextApprovalStatements = await prepareNextVersionApprovalStatements(contractId, contract.current_version, nextVersion, now);

    await guardedBatch(guard, [
      env.DB.prepare("INSERT INTO document_objects (id, contract_id, object_key, filename, content_type, byte_size, sha256, scan_status, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)").bind(documentId, contractId, objectKey, safeName, DOCX_TYPE, file.size, sha256, user.userId, now),
      env.DB.prepare("DELETE FROM document_blocks WHERE contract_id=?").bind(contractId),
      ...rows.map((block) => env.DB.prepare("INSERT INTO document_blocks (id, contract_id, block_key, order_index, kind, current_text, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(block.id, contractId, block.blockKey, block.orderIndex, block.kind, block.text, block.hash, now, now)),
      env.DB.prepare("INSERT INTO contract_versions (id, contract_id, version_number, created_by, snapshot, document_object_key, document_sha256, created_at) VALUES (?, ?, ?, ?, json(?), ?, ?, ?)").bind(crypto.randomUUID(), contractId, nextVersion, contract.initiator_id, JSON.stringify(snapshot), objectKey, sha256, now),
      env.DB.prepare("UPDATE contracts SET current_version=?, status='negotiating', updated_at=? WHERE id=? AND current_version=?").bind(nextVersion, now, contractId, contract.current_version),
      env.DB.prepare("UPDATE paragraph_proposals SET status='withdrawn', resolved_at=?, resolved_by=?, updated_at=? WHERE contract_id=? AND status='pending'").bind(now, user.userId, now, contractId),
      env.DB.prepare("INSERT INTO audit_log_entries (id, contract_id, actor_id, actor_display, action, target_type, target_id, version_number, request_id, ip_address, user_agent, metadata, created_at) VALUES (?, ?, ?, ?, 'document.uploaded', 'document', ?, ?, ?, ?, ?, json(?), ?)").bind(crypto.randomUUID(), contractId, user.userId, "Vendor Admin", documentId, nextVersion, request.headers.get("x-request-id") ?? crypto.randomUUID(), request.headers.get("cf-connecting-ip"), request.headers.get("user-agent"), JSON.stringify({ filename: safeName, byteSize: file.size, sha256, scanStatus: "pending", paragraphs: rows.length }), now),
      ...nextApprovalStatements,
    ]);
  } catch (error) {
    await env.DOCUMENTS.delete(objectKey);
    if (error instanceof MutationConflictError) return Response.json({ error: "The document changed while the upload was processed. Please try again." }, { status: 409 });
    throw error;
  }
  return Response.json({ document: { id: documentId, filename: safeName, byteSize: file.size, sha256, scanStatus: "pending" }, versionNumber: nextVersion }, { status: 201 });
}
