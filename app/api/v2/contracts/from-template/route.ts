import { env } from "cloudflare:workers";
import { requireOwnerApi } from "@/lib/owner-boundary";
import { parseDocxBytes, sha256BufferHex } from "@/lib/docx-server";
import { fillTemplateDocx } from "@/lib/template-docx";
import { hashPassword, randomToken, sha256Hex } from "@/lib/security";
import { getOwnerOrganizationId } from "@/lib/v2";

type Body = { templateId?: string; title?: string; supplierOrganizationId?: string; values?: Record<string, string>; clauseModuleIds?: string[]; reviewerName?: string; reviewerEmail?: string };

export async function POST(request: Request) {
  const auth = await requireOwnerApi(request); if (auth.response) return auth.response;
  const organizationId = await getOwnerOrganizationId(auth.user.userId); const body = await request.json().catch(() => null) as Body | null;
  const title = body?.title?.trim().slice(0, 160); const supplierOrganizationId = body?.supplierOrganizationId?.trim(); const templateId = body?.templateId?.trim();
  if (!organizationId || !title || !supplierOrganizationId || !templateId || !body?.values || typeof body.values !== "object") return Response.json({ error: "Template, title, supplier, and field values are required" }, { status: 400 });
  const [template, supplier, owner, portalAccount] = await Promise.all([
    env.DB.prepare("SELECT id,name,object_key,fields FROM contract_templates WHERE id=? AND organization_id=? AND status='active'").bind(templateId, organizationId).first<{ id: string; name: string; object_key: string; fields: string }>(),
    env.DB.prepare("SELECT o.id,o.name FROM organizations o JOIN supplier_relationships r ON r.supplier_organization_id=o.id WHERE o.id=? AND r.customer_organization_id=? AND r.status='active'").bind(supplierOrganizationId, organizationId).first<{ id: string; name: string }>(),
    env.DB.prepare("SELECT u.id FROM users u JOIN organization_memberships m ON m.user_id=u.id WHERE m.organization_id=? AND u.external_identity_id=? AND m.status='active'").bind(organizationId, auth.user.userId).first<{ id: string }>(),
    env.DB.prepare("SELECT id,display_name,email FROM portal_accounts WHERE organization_id=? AND status='active' ORDER BY created_at LIMIT 1").bind(supplierOrganizationId).first<{ id: string; display_name: string; email: string }>(),
  ]);
  if (!template || !supplier || !owner) return Response.json({ error: "Template, supplier, or owner was not found" }, { status: 404 });
  const fields = typeof template.fields === "string" ? JSON.parse(template.fields) as Array<{ key: string; required: boolean }> : template.fields as unknown as Array<{ key: string; required: boolean }>;
  const values: Record<string, string> = {}; for (const field of fields) { const value = String(body.values[field.key] ?? "").trim().slice(0, 5_000); if (field.required && !value) return Response.json({ error: `${field.key.replaceAll('_', ' ')} is required` }, { status: 400 }); values[field.key] = value; }
  const moduleIds = Array.isArray(body.clauseModuleIds) ? [...new Set(body.clauseModuleIds)].slice(0, 20) : [];
  const modules = moduleIds.length ? await env.DB.prepare(`SELECT id,heading,body FROM clause_modules WHERE organization_id=? AND status='active' AND id IN (${moduleIds.map(() => "?").join(",")})`).bind(organizationId, ...moduleIds).all<{ id: string; heading: string; body: string }>() : { results: [] };
  const source = await env.DOCUMENTS.get(template.object_key); if (!source) return Response.json({ error: "Template file is unavailable" }, { status: 404 });
  const generated = fillTemplateDocx(await source.arrayBuffer(), values, modules.results); const generatedBuffer = generated.buffer.slice(generated.byteOffset, generated.byteOffset + generated.byteLength);
  const parsed = parseDocxBytes(generatedBuffer); const contractId = crypto.randomUUID(); const versionId = crypto.randomUUID(); const documentId = crypto.randomUUID(); const ownerPartyId = crypto.randomUUID(); const supplierPartyId = crypto.randomUUID(); const now = new Date().toISOString(); const filename = `${title.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "agreement"}-v1.docx`; const objectKey = `contracts/${contractId}/versions/1/${documentId}-${filename}`; const sha = await sha256BufferHex(generatedBuffer);
  const rows = await Promise.all(parsed.map(async (block, index) => ({ id: crypto.randomUUID(), blockKey: `paragraph-${index + 1}`, orderIndex: index, ...block, hash: await sha256Hex(block.text) }))); const snapshot = rows.map((block) => ({ id: block.id, block_key: block.blockKey, order_index: block.orderIndex, kind: block.kind, current_text: block.text }));
  await env.DOCUMENTS.put(objectKey, generatedBuffer, { httpMetadata: { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }, customMetadata: { contractId, templateId, version: "1" } });
  const statements = [
    env.DB.prepare("INSERT INTO contracts (id,title,initiator_id,approver_id,responsible_owner_id,status,lifecycle_stage,template_id,current_version,owner_organization_id,counterparty_organization_id,origin,created_at,updated_at) VALUES (?,?,?,?,?,'draft','draft',?,1,?,?,'customer_template',?,?)").bind(contractId, title, owner.id, owner.id, owner.id, templateId, organizationId, supplierOrganizationId, now, now),
    env.DB.prepare("INSERT INTO parties (id,contract_id,role,name,company,email,created_at,updated_at) VALUES (?,?,'initiator','Vendor Admin',(SELECT name FROM organizations WHERE id=?),?,?,?)").bind(ownerPartyId, contractId, organizationId, auth.user.email, now, now),
    env.DB.prepare("INSERT INTO parties (id,contract_id,role,name,company,email,created_at,updated_at) VALUES (?,?,'counterparty',?,?,?, ?,?)").bind(supplierPartyId, contractId, body.reviewerName?.trim().slice(0, 120) || portalAccount?.display_name || "Customer Reviewer", supplier.name, body.reviewerEmail?.trim().slice(0, 254) || portalAccount?.email || "customer@example.test", now, now),
    ...rows.map((block) => env.DB.prepare("INSERT INTO document_blocks (id,contract_id,block_key,order_index,kind,current_text,content_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(block.id, contractId, block.blockKey, block.orderIndex, block.kind, block.text, block.hash, now, now)),
    env.DB.prepare("INSERT INTO contract_versions (id,contract_id,version_number,created_by,snapshot,document_object_key,document_sha256,created_at) VALUES (?,?,1,?,json(?),?,?,?)").bind(versionId, contractId, owner.id, JSON.stringify(snapshot), objectKey, sha, now),
    env.DB.prepare("INSERT INTO document_objects (id,contract_id,object_key,filename,content_type,byte_size,sha256,scan_status,uploaded_by,created_at) VALUES (?,?,?,?,?,?,?,'pending',?,?)").bind(documentId, contractId, objectKey, filename, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", generated.byteLength, sha, owner.id, now),
  ];
  if (portalAccount) {
    const accessAccountId = crypto.randomUUID(); const username = `portal-${portalAccount.id.slice(0, 8)}-${contractId.slice(0, 8)}`; const passwordHash = await hashPassword(randomToken(24));
    statements.push(
      env.DB.prepare("INSERT INTO access_accounts (id,contract_id,party_id,username,password_hash,permission,status,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,'propose_changes','active','2099-12-31T23:59:59.000Z',?,?)").bind(accessAccountId, contractId, supplierPartyId, username, passwordHash, now, now),
      env.DB.prepare("INSERT INTO contract_access_grants (id,contract_id,portal_account_id,legacy_access_account_id,permission,status,created_at,updated_at) VALUES (?,?,?,?, 'propose_changes','active',?,?)").bind(crypto.randomUUID(), contractId, portalAccount.id, accessAccountId, now, now),
    );
  }
  try { await env.DB.batch(statements); } catch (error) { await env.DOCUMENTS.delete(objectKey); throw error; }
  return Response.json({ contract: { id: contractId, title, status: "draft", current_version: 1, origin: "customer_template" } }, { status: 201 });
}
