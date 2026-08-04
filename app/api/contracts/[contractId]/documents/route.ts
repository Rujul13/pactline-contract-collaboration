import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../../chatgpt-auth";

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX_DOCX_BYTES = 15 * 1024 * 1024;

function hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function POST(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const { contractId } = await context.params;
  const authorized = await env.DB.prepare("SELECT c.id FROM contracts c JOIN users u ON u.id = c.initiator_id WHERE c.id = ? AND u.external_identity_id = ? AND c.status NOT IN ('agreed', 'locked')").bind(contractId, user.userId).first();
  if (!authorized) return Response.json({ error: "Contract not found or upload is not permitted" }, { status: 404 });

  const form = await request.formData();
  const file = form.get("document");
  if (!(file instanceof File)) return Response.json({ error: "A DOCX document is required" }, { status: 400 });
  if (!file.name.toLowerCase().endsWith(".docx") || file.type !== DOCX_TYPE) return Response.json({ error: "Only modern .docx Word documents are accepted" }, { status: 415 });
  if (file.size <= 0 || file.size > MAX_DOCX_BYTES) return Response.json({ error: "The DOCX document must be between 1 byte and 15 MB" }, { status: 413 });

  const body = await file.arrayBuffer();
  const sha256 = hex(await crypto.subtle.digest("SHA-256", body));
  const documentId = crypto.randomUUID();
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  const objectKey = `contracts/${contractId}/uploads/${documentId}-${safeName}`;
  await env.DOCUMENTS.put(objectKey, body, { httpMetadata: { contentType: DOCX_TYPE }, customMetadata: { contractId, documentId, sha256, uploadedBy: user.userId } });

  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO document_objects (id, contract_id, object_key, filename, content_type, byte_size, sha256, scan_status, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)").bind(documentId, contractId, objectKey, safeName, DOCX_TYPE, file.size, sha256, user.userId, now),
      env.DB.prepare("INSERT INTO audit_log_entries (id, contract_id, actor_id, actor_display, action, target_type, target_id, request_id, ip_address, user_agent, metadata, created_at) VALUES (?, ?, ?, ?, 'document.uploaded', 'document', ?, ?, ?, ?, json(?), ?)").bind(crypto.randomUUID(), contractId, user.userId, user.displayName, documentId, request.headers.get("x-request-id") ?? crypto.randomUUID(), request.headers.get("cf-connecting-ip"), request.headers.get("user-agent"), JSON.stringify({ filename: safeName, byteSize: file.size, sha256, scanStatus: "pending" }), now),
    ]);
  } catch (error) {
    await env.DOCUMENTS.delete(objectKey);
    throw error;
  }
  return Response.json({ document: { id: documentId, filename: safeName, byteSize: file.size, sha256, scanStatus: "pending" } }, { status: 201 });
}
