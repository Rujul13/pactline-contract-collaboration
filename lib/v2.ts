import { env } from "cloudflare:workers";
import type { ChatGPTUser } from "@/app/chatgpt-auth";
import { createDocumentDocx, type DocumentBlock } from "./docx";
import { sha256BufferHex } from "./docx-server";
import { hashPassword, sha256Hex } from "./security";

export const DEMO_OWNER_ORGANIZATION_ID = "demo-owner-organization";
export const DEMO_SUPPLIER_ORGANIZATION_ID = "demo-supplier-organization";
export const DEMO_SECOND_SUPPLIER_ORGANIZATION_ID = "demo-second-supplier-organization";
export const DEMO_SUPPLIER_RELATIONSHIP_ID = "demo-supplier-relationship";
export const DEMO_PORTAL_ACCOUNT_ID = "demo-portal-account";
export const DEMO_PORTAL_USERNAME = "supplier.reviewer";
export const DEMO_PORTAL_PASSWORD = "SupplierDemo!2026";
export const DEMO_EXPIRED_CONTRACT_ID = "sample-expired-nda";

function minimalPdf(title: string, lines: string[]) {
  const escape = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const content = ["BT", "/F1 18 Tf", "72 740 Td", `(${escape(title)}) Tj`, "/F1 11 Tf", ...lines.flatMap((line) => ["0 -26 Td", `(${escape(line)}) Tj`]), "ET"].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${new TextEncoder().encode(content).length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(new TextEncoder().encode(pdf).length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = new TextEncoder().encode(pdf).length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

async function ensureExpiredContract(ownerId: string, now: string) {
  const existing = await env.DB.prepare("SELECT id FROM contracts WHERE id=?").bind(DEMO_EXPIRED_CONTRACT_ID).first();
  if (existing) return;
  const blocks: DocumentBlock[] = [
    { id: "expired-nda-title", kind: "title", text: "MUTUAL NON-DISCLOSURE AGREEMENT" },
    { id: "expired-nda-body", kind: "body", text: "The parties will protect confidential information disclosed for the evaluation of a potential business relationship." },
    { id: "expired-nda-term", kind: "body", text: "This agreement expired on December 31, 2025." },
  ];
  const hashes = await Promise.all(blocks.map((block) => sha256Hex(block.text)));
  const ownerPartyId = "expired-owner-party";
  const supplierPartyId = "expired-supplier-party";
  await env.DB.batch([
    env.DB.prepare("INSERT INTO contracts (id,title,initiator_id,approver_id,status,current_version,owner_organization_id,counterparty_organization_id,origin,effective_date,expiration_date,created_at,updated_at) VALUES (?,?,?,?,'locked',1,?,?,'direct_upload','2025-01-01','2025-12-31',?,?)").bind(DEMO_EXPIRED_CONTRACT_ID, "Expired Mutual NDA", ownerId, ownerId, DEMO_OWNER_ORGANIZATION_ID, DEMO_SUPPLIER_ORGANIZATION_ID, now, now),
    env.DB.prepare("INSERT INTO parties (id,contract_id,role,name,company,email,created_at,updated_at) VALUES (?,?,'initiator','Contract Owner','Pactline Demo Company','owner@example.test',?,?)").bind(ownerPartyId, DEMO_EXPIRED_CONTRACT_ID, now, now),
    env.DB.prepare("INSERT INTO parties (id,contract_id,role,name,company,email,created_at,updated_at) VALUES (?,?,'counterparty','Supplier Reviewer','Demo Supplier','supplier@example.test',?,?)").bind(supplierPartyId, DEMO_EXPIRED_CONTRACT_ID, now, now),
    ...blocks.map((block, index) => env.DB.prepare("INSERT INTO document_blocks (id,contract_id,block_key,order_index,kind,current_text,content_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(block.id, DEMO_EXPIRED_CONTRACT_ID, `paragraph-${index + 1}`, index, block.kind, block.text, hashes[index], now, now)),
    env.DB.prepare("INSERT INTO contract_versions (id,contract_id,version_number,created_by,snapshot,created_at) VALUES (?,?,1,?,json(?),?)").bind("expired-nda-version", DEMO_EXPIRED_CONTRACT_ID, ownerId, JSON.stringify(blocks.map((block, index) => ({ id: block.id, block_key: `paragraph-${index + 1}`, order_index: index, kind: block.kind, current_text: block.text }))), now),
  ]);
  const blob = createDocumentDocx("Expired Mutual NDA", 1, blocks);
  const bytes = await blob.arrayBuffer();
  const sha = await sha256BufferHex(bytes);
  const objectKey = `contracts/${DEMO_EXPIRED_CONTRACT_ID}/versions/1/expired-mutual-nda.docx`;
  await env.DOCUMENTS.put(objectKey, bytes, { httpMetadata: { contentType: blob.type } });
  await env.DB.batch([
    env.DB.prepare("INSERT INTO document_objects (id,contract_id,object_key,filename,content_type,byte_size,sha256,scan_status,uploaded_by,created_at) VALUES ('expired-nda-document',?,?, 'Expired Mutual NDA.docx',?,?,?,'pending',?,?)").bind(DEMO_EXPIRED_CONTRACT_ID, objectKey, blob.type, bytes.byteLength, sha, ownerId, now),
    env.DB.prepare("UPDATE contract_versions SET document_object_key=?,document_sha256=? WHERE id='expired-nda-version'").bind(objectKey, sha),
  ]);
}

async function ensureVaultDemo(ownerId: string, now: string) {
  const records = [
    { id: "vault-demo-msa", title: "Demo Master Services Agreement", category: "msa", filename: "Demo Master Services Agreement.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", objectKey: "contracts/sample-services-agreement/versions/1/demo-master-services-agreement.docx", expiration: "2027-12-31", linked: "sample-services-agreement", bytes: null as Uint8Array | null },
    { id: "vault-demo-insurance", title: "Certificate of Insurance", category: "insurance_certificate", filename: "Certificate of Insurance.pdf", type: "application/pdf", objectKey: "orgs/demo-owner-organization/vault/vault-demo-insurance/versions/1/certificate-of-insurance.pdf", expiration: "2026-09-30", linked: null, bytes: minimalPdf("Certificate of Insurance", ["Named insured: Demo Supplier", "Commercial general liability: $2,000,000", "Expiration date: September 30, 2026"]) },
    { id: "vault-demo-invoice", title: "Professional Services Invoice 1042", category: "invoice", filename: "Invoice-1042.pdf", type: "application/pdf", objectKey: "orgs/demo-owner-organization/vault/vault-demo-invoice/versions/1/invoice-1042.pdf", expiration: null, linked: null, bytes: minimalPdf("Invoice 1042", ["Supplier: Demo Supplier", "Amount due: $8,000", "Payment terms: Net 30", "Due date: September 15, 2026"]) },
  ];
  for (const item of records) {
    const exists = await env.DB.prepare("SELECT id FROM vault_documents WHERE id=?").bind(item.id).first();
    if (exists) continue;
    let bytes = item.bytes;
    if (!bytes) {
      const source = await env.DOCUMENTS.get(item.objectKey);
      if (!source) continue;
      bytes = new Uint8Array(await source.arrayBuffer());
    } else {
      await env.DOCUMENTS.put(item.objectKey, bytes, { httpMetadata: { contentType: item.type } });
    }
    const sha = await sha256BufferHex(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    await env.DB.batch([
      env.DB.prepare("INSERT INTO vault_documents (id,owner_organization_id,supplier_organization_id,linked_contract_id,title,category,visibility,status,effective_date,expiration_date,current_version,extraction_status,created_at,updated_at) VALUES (?,?,?,?,?,?, 'shared','active',?,?,1,'not_started',?,?)").bind(item.id, DEMO_OWNER_ORGANIZATION_ID, DEMO_SUPPLIER_ORGANIZATION_ID, item.linked, item.title, item.category, "2026-01-01", item.expiration, now, now),
      env.DB.prepare("INSERT INTO vault_document_versions (id,document_id,version_number,object_key,filename,content_type,byte_size,sha256,scan_status,uploaded_by,created_at) VALUES (?,?,1,?,?,?,?,?,'pending',?,?)").bind(`${item.id}-v1`, item.id, item.objectKey, item.filename, item.type, bytes.byteLength, sha, ownerId, now),
    ]);
  }
}

async function ensureTemplateDemo(now: string) {
  const templateId = "demo-services-template";
  const existing = await env.DB.prepare("SELECT id FROM contract_templates WHERE id=?").bind(templateId).first();
  if (!existing) {
    const blocks: DocumentBlock[] = [
      { id: "template-title", kind: "title", text: "SERVICES AGREEMENT" },
      { id: "template-intro", kind: "body", text: "This Services Agreement is entered into between {{customer_name}} and {{supplier_name}}, effective {{effective_date}}." },
      { id: "template-services-heading", kind: "heading", text: "1. Services" },
      { id: "template-services", kind: "body", text: "The Supplier will provide {{services_description}} for a total fee of {{contract_value}}." },
      { id: "template-payment-heading", kind: "heading", text: "2. Payment" },
      { id: "template-payment", kind: "body", text: "Invoices are payable {{payment_terms}} from receipt." },
      { id: "template-clauses", kind: "body", text: "{{optional_clauses}}" },
    ];
    const blob = createDocumentDocx("Services Agreement Template", 1, blocks);
    const bytes = await blob.arrayBuffer();
    const objectKey = `orgs/${DEMO_OWNER_ORGANIZATION_ID}/templates/${templateId}/services-agreement-template.docx`;
    await env.DOCUMENTS.put(objectKey, bytes, { httpMetadata: { contentType: blob.type } });
    const fields = ["customer_name", "supplier_name", "effective_date", "services_description", "contract_value", "payment_terms"].map((key) => ({ key, label: key.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()), required: true }));
    await env.DB.prepare("INSERT INTO contract_templates (id,organization_id,name,contract_type,object_key,filename,fields,status,created_at,updated_at) VALUES (?,?, 'Services Agreement Template','services',?,?,json(?),'active',?,?)").bind(templateId, DEMO_OWNER_ORGANIZATION_ID, objectKey, "Services Agreement Template.docx", JSON.stringify(fields), now, now).run();
  }
  await env.DB.prepare("INSERT INTO clause_modules (id,organization_id,name,heading,body,status,created_at,updated_at) VALUES ('demo-data-security-clause',?,'Standard Data Security','Data Security','Supplier will maintain commercially reasonable administrative, technical, and physical safeguards for Customer data.','active',?,?) ON CONFLICT(id) DO NOTHING").bind(DEMO_OWNER_ORGANIZATION_ID, now, now).run();
}

export async function ensureV2Workspace(user: ChatGPTUser) {
  const now = new Date().toISOString();
  const owner = await env.DB.prepare("SELECT id FROM users WHERE external_identity_id=?").bind(user.userId).first<{ id: string }>();
  if (!owner) return;
  const ownerOrg = await env.DB.prepare("SELECT id FROM organizations WHERE id=?").bind(DEMO_OWNER_ORGANIZATION_ID).first();
  if (!ownerOrg) {
    const passwordHash = await hashPassword(DEMO_PORTAL_PASSWORD);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO organizations (id,name,kind,timezone,status,created_at,updated_at) VALUES (?, 'Pactline Demo Company','customer','America/Indianapolis','active',?,?)").bind(DEMO_OWNER_ORGANIZATION_ID, now, now),
      env.DB.prepare("INSERT INTO organizations (id,name,kind,timezone,status,created_at,updated_at) VALUES (?, 'Demo Supplier','supplier','America/Indianapolis','active',?,?)").bind(DEMO_SUPPLIER_ORGANIZATION_ID, now, now),
      env.DB.prepare("INSERT INTO organizations (id,name,kind,timezone,status,created_at,updated_at) VALUES (?, 'Secondary Supplier','supplier','America/Indianapolis','active',?,?)").bind(DEMO_SECOND_SUPPLIER_ORGANIZATION_ID, now, now),
      env.DB.prepare("INSERT INTO organization_memberships (id,organization_id,user_id,role,status,created_at,updated_at) VALUES ('demo-owner-membership',?,?, 'owner_admin','active',?,?)").bind(DEMO_OWNER_ORGANIZATION_ID, owner.id, now, now),
      env.DB.prepare("INSERT INTO supplier_relationships (id,customer_organization_id,supplier_organization_id,status,created_at,updated_at) VALUES (?,?,?,'active',?,?)").bind(DEMO_SUPPLIER_RELATIONSHIP_ID, DEMO_OWNER_ORGANIZATION_ID, DEMO_SUPPLIER_ORGANIZATION_ID, now, now),
      env.DB.prepare("INSERT INTO portal_accounts (id,organization_id,username,password_hash,display_name,email,status,failed_attempts,created_at,updated_at) VALUES (?,?,?,?,?,'supplier@example.test','active',0,?,?)").bind(DEMO_PORTAL_ACCOUNT_ID, DEMO_SUPPLIER_ORGANIZATION_ID, DEMO_PORTAL_USERNAME, passwordHash, "Supplier Reviewer", now, now),
    ]);
  }
  await env.DB.prepare("UPDATE contracts SET owner_organization_id=?,counterparty_organization_id=? WHERE id='sample-services-agreement' AND owner_organization_id IS NULL").bind(DEMO_OWNER_ORGANIZATION_ID, DEMO_SUPPLIER_ORGANIZATION_ID).run();
  const renewalDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  await env.DB.prepare("UPDATE contracts SET expiration_date=COALESCE(expiration_date,?) WHERE id='sample-services-agreement'").bind(renewalDate).run();
  await env.DB.prepare("INSERT INTO compliance_requirements (id,relationship_id,document_category,required,warning_days,created_at,updated_at) VALUES ('demo-insurance-requirement',?,'insurance_certificate',1,30,?,?) ON CONFLICT(relationship_id,document_category) DO NOTHING").bind(DEMO_SUPPLIER_RELATIONSHIP_ID, now, now).run();
  const grant = await env.DB.prepare("SELECT id FROM contract_access_grants WHERE contract_id='sample-services-agreement' AND portal_account_id=?").bind(DEMO_PORTAL_ACCOUNT_ID).first();
  if (!grant) await env.DB.prepare("INSERT INTO contract_access_grants (id,contract_id,portal_account_id,legacy_access_account_id,permission,status,created_at,updated_at) VALUES ('demo-primary-grant','sample-services-agreement',?,'sample-client-account','propose_changes','active',?,?)").bind(DEMO_PORTAL_ACCOUNT_ID, now, now).run();
  await ensureExpiredContract(owner.id, now);
  const expiredGrant = await env.DB.prepare("SELECT id FROM contract_access_grants WHERE contract_id=? AND portal_account_id=?").bind(DEMO_EXPIRED_CONTRACT_ID, DEMO_PORTAL_ACCOUNT_ID).first();
  if (!expiredGrant) await env.DB.prepare("INSERT INTO contract_access_grants (id,contract_id,portal_account_id,permission,status,created_at,updated_at) VALUES ('demo-expired-grant',?,?,'view','active',?,?)").bind(DEMO_EXPIRED_CONTRACT_ID, DEMO_PORTAL_ACCOUNT_ID, now, now).run();
  await ensureVaultDemo(owner.id, now);
  await ensureTemplateDemo(now);
  return { ownerOrganizationId: DEMO_OWNER_ORGANIZATION_ID };
}

export async function getOwnerOrganizationId(userId: string) {
  const row = await env.DB.prepare("SELECT m.organization_id FROM organization_memberships m JOIN users u ON u.id=m.user_id WHERE u.external_identity_id=? AND m.status='active' ORDER BY CASE m.role WHEN 'owner_admin' THEN 0 ELSE 1 END LIMIT 1").bind(userId).first<{ organization_id: string }>();
  return row?.organization_id ?? null;
}
