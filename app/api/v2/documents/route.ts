import { env } from "cloudflare:workers";
import { requireOwnerApi } from "@/lib/owner-boundary";
import { parseDocxBytes, sha256BufferHex } from "@/lib/docx-server";
import { getOwnerOrganizationId } from "@/lib/v2";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const CATEGORIES = new Set(["msa", "nda", "sow", "cloud_agreement", "po", "invoice", "insurance_certificate", "minority_business_certificate", "other"]);
const VISIBILITY = new Set(["customer_only", "supplier_only", "shared"]);

export async function POST(request: Request) {
  const auth = await requireOwnerApi(request); if (auth.response) return auth.response;
  const organizationId = await getOwnerOrganizationId(auth.user.userId); if (!organizationId) return Response.json({ error: "Organization not found" }, { status: 404 });
  const form = await request.formData(); const file = form.get("document");
  const title = String(form.get("title") ?? "").trim().slice(0, 180); const category = String(form.get("category") ?? "other"); const visibility = String(form.get("visibility") ?? "shared");
  const supplierOrganizationId = String(form.get("supplierOrganizationId") ?? "").trim() || null; const effectiveDate = String(form.get("effectiveDate") ?? "").trim() || null; const expirationDate = String(form.get("expirationDate") ?? "").trim() || null;
  if (!title || !(file instanceof File)) return Response.json({ error: "A title and document are required" }, { status: 400 });
  if (!CATEGORIES.has(category) || !VISIBILITY.has(visibility)) return Response.json({ error: "Document category or visibility is invalid" }, { status: 400 });
  if (file.size <= 0 || file.size > 15 * 1024 * 1024) return Response.json({ error: "Documents must be between 1 byte and 15 MB" }, { status: 413 });
  const lower = file.name.toLowerCase(); const contentType = lower.endsWith(".docx") ? DOCX : lower.endsWith(".pdf") ? "application/pdf" : null;
  if (!contentType) return Response.json({ error: "Only DOCX and PDF documents are accepted" }, { status: 415 });
  const bytes = await file.arrayBuffer();
  if (contentType === DOCX) { try { parseDocxBytes(bytes); } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Unable to read the Word document" }, { status: 400 }); } }
  if (contentType === "application/pdf" && new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") return Response.json({ error: "The uploaded file is not a valid PDF" }, { status: 400 });
  if (supplierOrganizationId) {
    const relationship = await env.DB.prepare("SELECT id FROM supplier_relationships WHERE customer_organization_id=? AND supplier_organization_id=? AND status='active'").bind(organizationId, supplierOrganizationId).first();
    if (!relationship) return Response.json({ error: "Supplier relationship not found" }, { status: 404 });
  }
  const documentId = crypto.randomUUID(); const versionId = crypto.randomUUID(); const now = new Date().toISOString(); const filename = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 140);
  const objectKey = `orgs/${organizationId}/vault/${documentId}/versions/1/${versionId}-${filename}`; const sha = await sha256BufferHex(bytes);
  await env.DOCUMENTS.put(objectKey, bytes, { httpMetadata: { contentType }, customMetadata: { organizationId, documentId, version: "1", sha256: sha } });
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO vault_documents (id,owner_organization_id,supplier_organization_id,title,category,visibility,status,effective_date,expiration_date,current_version,extraction_status,created_at,updated_at) VALUES (?,?,?,?,?,?,'active',?,?,1,'not_started',?,?)").bind(documentId, organizationId, supplierOrganizationId, title, category, visibility, effectiveDate, expirationDate, now, now),
      env.DB.prepare("INSERT INTO vault_document_versions (id,document_id,version_number,object_key,filename,content_type,byte_size,sha256,scan_status,uploaded_by,created_at) VALUES (?,?,1,?,?,?,?,?,'pending',?,?)").bind(versionId, documentId, objectKey, filename, contentType, bytes.byteLength, sha, auth.user.userId, now),
    ]);
  } catch (error) { await env.DOCUMENTS.delete(objectKey); throw error; }
  return Response.json({ document: { id: documentId, title, category, visibility, filename, extraction_status: "not_started" } }, { status: 201 });
}
