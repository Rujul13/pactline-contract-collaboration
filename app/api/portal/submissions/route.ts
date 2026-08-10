import { env } from "cloudflare:workers";
import { parseDocxBytes, sha256BufferHex } from "@/lib/docx-server";
import { requirePortalSession } from "@/lib/portal-auth";
import { hashPassword, randomToken, sha256Hex } from "@/lib/security";

export async function POST(request: Request) {
  const auth = await requirePortalSession(request); if (auth.response) return auth.response; const session = auth.session!;
  const form = await request.formData(); const file = form.get("document"); const title = String(form.get("title") ?? "").trim().slice(0, 160);
  if (!title || !(file instanceof File) || !file.name.toLowerCase().endsWith(".docx")) return Response.json({ error: "A title and DOCX agreement are required" }, { status: 400 });
  if (file.size <= 0 || file.size > 15 * 1024 * 1024) return Response.json({ error: "Agreement must be between 1 byte and 15 MB" }, { status: 413 });
  const relationships = await env.DB.prepare("SELECT customer_organization_id FROM supplier_relationships WHERE supplier_organization_id=? AND status='active' ORDER BY created_at").bind(session.organizationId).all<{ customer_organization_id: string }>();
  if (!relationships.results.length) return Response.json({ error: "No active customer relationship was found" }, { status: 409 });
  if (relationships.results.length > 1) return Response.json({ error: "Choose a customer workspace before submitting this agreement" }, { status: 409 });
  const relationship = relationships.results[0];
  const owner = await env.DB.prepare("SELECT u.id,u.email FROM organization_memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=? AND m.status='active' ORDER BY CASE m.role WHEN 'owner_admin' THEN 0 ELSE 1 END LIMIT 1").bind(relationship.customer_organization_id).first<{ id: string; email: string }>();
  if (!owner) return Response.json({ error: "Customer contract owner was not found" }, { status: 409 });
  const bytes = await file.arrayBuffer(); let parsed; try { parsed = parseDocxBytes(bytes); } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Unable to read agreement" }, { status: 400 }); }
  const contractId = crypto.randomUUID(); const ownerPartyId = crypto.randomUUID(); const supplierPartyId = crypto.randomUUID(); const accessAccountId = crypto.randomUUID(); const documentId = crypto.randomUUID(); const versionId = crypto.randomUUID(); const now = new Date().toISOString(); const filename = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 140); const objectKey = `contracts/${contractId}/versions/1/${documentId}-${filename}`; const sha = await sha256BufferHex(bytes); const shadowPassword = await hashPassword(randomToken(24));
  const rows = await Promise.all(parsed.map(async (block, index) => ({ id: crypto.randomUUID(), blockKey: `paragraph-${index + 1}`, orderIndex: index, ...block, hash: await sha256Hex(block.text) }))); const snapshot = rows.map((block) => ({ id: block.id, block_key: block.blockKey, order_index: block.orderIndex, kind: block.kind, current_text: block.text }));
  await env.DOCUMENTS.put(objectKey, bytes, { httpMetadata: { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }, customMetadata: { contractId, submittedBy: session.accountId } });
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO contracts (id,title,initiator_id,approver_id,status,current_version,owner_organization_id,counterparty_organization_id,origin,submitted_by_portal_account_id,created_at,updated_at) VALUES (?,?,?,?,'draft',1,?,?,'supplier_upload',?,?,?)").bind(contractId, title, owner.id, owner.id, relationship.customer_organization_id, session.organizationId, session.accountId, now, now),
      env.DB.prepare("INSERT INTO parties (id,contract_id,role,name,company,email,created_at,updated_at) VALUES (?,?,'initiator','Contract Owner',(SELECT name FROM organizations WHERE id=?),?,?,?)").bind(ownerPartyId, contractId, relationship.customer_organization_id, owner.email, now, now),
      env.DB.prepare("INSERT INTO parties (id,contract_id,role,name,company,email,created_at,updated_at) VALUES (?,?,'counterparty',?,?,?,?,?)").bind(supplierPartyId, contractId, session.displayName, session.organizationName, session.email, now, now),
      env.DB.prepare("INSERT INTO access_accounts (id,contract_id,party_id,username,password_hash,permission,status,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,'propose_changes','active','2099-12-31T23:59:59.000Z',?,?)").bind(accessAccountId, contractId, supplierPartyId, `portal-${session.accountId.slice(0, 8)}-${contractId.slice(0, 8)}`, shadowPassword, now, now),
      env.DB.prepare("INSERT INTO contract_access_grants (id,contract_id,portal_account_id,legacy_access_account_id,permission,status,created_at,updated_at) VALUES (?,?,?,?, 'propose_changes','active',?,?)").bind(crypto.randomUUID(), contractId, session.accountId, accessAccountId, now, now),
      ...rows.map((block) => env.DB.prepare("INSERT INTO document_blocks (id,contract_id,block_key,order_index,kind,current_text,content_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(block.id, contractId, block.blockKey, block.orderIndex, block.kind, block.text, block.hash, now, now)),
      env.DB.prepare("INSERT INTO contract_versions (id,contract_id,version_number,created_by,snapshot,document_object_key,document_sha256,created_at) VALUES (?,?,1,?,json(?),?,?,?)").bind(versionId, contractId, session.accountId, JSON.stringify(snapshot), objectKey, sha, now),
      env.DB.prepare("INSERT INTO document_objects (id,contract_id,object_key,filename,content_type,byte_size,sha256,scan_status,uploaded_by,created_at) VALUES (?,?,?,?,?,?,?,'pending',?,?)").bind(documentId, contractId, objectKey, filename, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes.byteLength, sha, session.accountId, now),
    ]);
  } catch (error) { await env.DOCUMENTS.delete(objectKey); throw error; }
  return Response.json({ contract: { id: contractId, title, status: "draft", origin: "supplier_upload" } }, { status: 201 });
}
