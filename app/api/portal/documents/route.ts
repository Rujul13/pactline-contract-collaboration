import { env } from "cloudflare:workers";
import { parseDocxBytes, sha256BufferHex } from "@/lib/docx-server";
import { requirePortalSession } from "@/lib/portal-auth";

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const CATEGORIES = new Set(["msa", "nda", "sow", "cloud_agreement", "po", "invoice", "insurance_certificate", "minority_business_certificate", "other"]);
const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;

export async function POST(request: Request) {
  const auth = await requirePortalSession(request);
  if (auth.response) return auth.response;
  const session = auth.session!;
  const form = await request.formData();
  const file = form.get("document");
  const title = String(form.get("title") ?? "").trim().slice(0, 180);
  const category = String(form.get("category") ?? "other");
  const expirationDate = String(form.get("expirationDate") ?? "").trim() || null;
  if (!title || !(file instanceof File)) return Response.json({ error: "A title and document are required" }, { status: 400 });
  if (!CATEGORIES.has(category)) return Response.json({ error: "Document category is invalid" }, { status: 400 });
  if (file.size <= 0 || file.size > MAX_DOCUMENT_BYTES) return Response.json({ error: "Documents must be between 1 byte and 15 MB" }, { status: 413 });

  const lowerName = file.name.toLowerCase();
  const contentType = lowerName.endsWith(".docx") ? DOCX_TYPE : lowerName.endsWith(".pdf") ? "application/pdf" : null;
  if (!contentType) return Response.json({ error: "Only DOCX and PDF documents are accepted" }, { status: 415 });
  const bytes = await file.arrayBuffer();
  if (contentType === DOCX_TYPE) {
    try { parseDocxBytes(bytes); } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Unable to read the Word document" }, { status: 400 }); }
  }
  if (contentType === "application/pdf" && new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") return Response.json({ error: "The uploaded file is not a valid PDF" }, { status: 400 });

  const relationships = await env.DB.prepare("SELECT customer_organization_id FROM supplier_relationships WHERE supplier_organization_id=? AND status='active' ORDER BY created_at").bind(session.organizationId).all<{ customer_organization_id: string }>();
  if (!relationships.results.length) return Response.json({ error: "No active vendor relationship was found" }, { status: 409 });
  if (relationships.results.length > 1) return Response.json({ error: "Choose a vendor workspace before uploading a document" }, { status: 409 });

  const documentId = crypto.randomUUID(); const versionId = crypto.randomUUID(); const now = new Date().toISOString();
  const filename = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 140);
  const ownerOrganizationId = relationships.results[0].customer_organization_id;
  const objectKey = `orgs/${ownerOrganizationId}/vault/${documentId}/versions/1/${versionId}-${filename}`;
  const sha256 = await sha256BufferHex(bytes);
  await env.DOCUMENTS.put(objectKey, bytes, { httpMetadata: { contentType }, customMetadata: { documentId, uploadedBy: session.accountId, sha256 } });
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO vault_documents (id,owner_organization_id,supplier_organization_id,title,category,visibility,status,expiration_date,current_version,extraction_status,created_at,updated_at) VALUES (?,?,?,?,?,'shared','active',?,1,'not_started',?,?)").bind(documentId, ownerOrganizationId, session.organizationId, title, category, expirationDate, now, now),
      env.DB.prepare("INSERT INTO vault_document_versions (id,document_id,version_number,object_key,filename,content_type,byte_size,sha256,scan_status,uploaded_by,created_at) VALUES (?,?,1,?,?,?,?,?,'pending',?,?)").bind(versionId, documentId, objectKey, filename, contentType, bytes.byteLength, sha256, session.accountId, now),
    ]);
  } catch (error) {
    await env.DOCUMENTS.delete(objectKey);
    throw error;
  }
  return Response.json({ document: { id: documentId, title, category, filename, contentType, expirationDate } }, { status: 201 });
}
