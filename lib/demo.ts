import { env } from "cloudflare:workers";
import type { ChatGPTUser } from "@/app/chatgpt-auth";
import { createDocumentDocx, type DocumentBlock } from "./docx";
import { hashPassword, sha256Hex } from "./security";
import { sha256BufferHex } from "./docx-server";

export const DEMO_CONTRACT_ID = "sample-services-agreement";
export const DEMO_USERNAME = "client.reviewer";
export const DEMO_PASSWORD = "ReviewDemo!2026";

export const demoBlocks: DocumentBlock[] = [
  { id: "sample-block-1", kind: "title", text: "MASTER SERVICES AGREEMENT" },
  { id: "sample-block-2", kind: "body", text: "This Master Services Agreement (the “Agreement”) is entered into between Owner Company and Client Company as of the effective date shown in the final signed copy." },
  { id: "sample-block-3", kind: "body", text: "The parties agree that the following terms govern the services described in each statement of work issued under this Agreement." },
  { id: "sample-block-4", kind: "heading", text: "1. Services" },
  { id: "sample-block-5", kind: "body", text: "Owner Company will provide the professional services described in each applicable statement of work, including the deliverables, schedule, fees, and acceptance criteria." },
  { id: "sample-block-6", kind: "body", text: "Owner Company will perform the services in a professional and workmanlike manner using personnel with appropriate skills and experience." },
  { id: "sample-block-7", kind: "heading", text: "2. Fees and payment" },
  { id: "sample-block-8", kind: "body", text: "Client Company will pay all undisputed invoices within thirty (30) days after receipt. Fees exclude applicable taxes and approved, reasonable out-of-pocket expenses." },
  { id: "sample-block-9", kind: "body", text: "If Client Company disputes an invoice in good faith, it will notify Owner Company promptly and the parties will work together to resolve the disputed amount." },
  { id: "sample-block-10", kind: "heading", text: "3. Confidentiality" },
  { id: "sample-block-11", kind: "body", text: "Each party will protect the other party’s Confidential Information using at least reasonable care and may use it only to perform or receive services under this Agreement." },
  { id: "sample-block-12", kind: "heading", text: "4. Term and termination" },
  { id: "sample-block-13", kind: "body", text: "This Agreement continues for twelve months. Either party may terminate for material breach if the breach remains uncured for fifteen (15) days after written notice." },
  { id: "sample-block-14", kind: "heading", text: "5. Limitation of liability" },
  { id: "sample-block-15", kind: "body", text: "Except for excluded claims, each party’s aggregate liability will not exceed the fees paid or payable during the twelve months preceding the event giving rise to the claim." },
  { id: "sample-block-16", kind: "heading", text: "6. General" },
  { id: "sample-block-17", kind: "body", text: "This Agreement and its statements of work constitute the entire agreement between the parties concerning their subject matter and may be amended only in a writing agreed by both parties." },
];

export async function ensureDemoWorkspace(user: ChatGPTUser) {
  const db = env.DB;
  const userId = `owner-${await sha256Hex(user.userId)}`;
  const existing = await db.prepare("SELECT id FROM users WHERE external_identity_id = ?").bind(user.userId).first<{ id: string }>();
  const ownerId = existing?.id ?? userId;
  const now = new Date().toISOString();
  if (!existing) {
    await db.prepare("INSERT INTO users (id, email, display_name, external_identity_id, status, created_at, updated_at) VALUES (?, ?, 'Contract Owner', ?, 'active', ?, ?)")
      .bind(ownerId, user.email, user.userId, now, now).run();
  }

  const contract = await db.prepare("SELECT id FROM contracts WHERE id = ? AND initiator_id = ?").bind(DEMO_CONTRACT_ID, ownerId).first();
  if (contract) return { ownerId, contractId: DEMO_CONTRACT_ID };

  const ownerPartyId = "sample-owner-party";
  const clientPartyId = "sample-client-party";
  const accountId = "sample-client-account";
  const versionId = "sample-version-1";
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const blockRows = await Promise.all(demoBlocks.map(async (block, index) => ({
    ...block,
    orderIndex: index,
    hash: await sha256Hex(block.text),
  })));
  const snapshot = blockRows.map((block) => ({ id: block.id, block_key: `paragraph-${block.orderIndex + 1}`, order_index: block.orderIndex, kind: block.kind, current_text: block.text }));

  await db.batch([
    db.prepare("INSERT INTO contracts (id, title, initiator_id, approver_id, status, current_version, created_at, updated_at) VALUES (?, 'Demo Master Services Agreement', ?, ?, 'negotiating', 1, ?, ?)").bind(DEMO_CONTRACT_ID, ownerId, ownerId, now, now),
    db.prepare("INSERT INTO parties (id, contract_id, role, name, company, email, created_at, updated_at) VALUES (?, ?, 'initiator', 'Contract Owner', 'Owner Company', 'owner@example.test', ?, ?)").bind(ownerPartyId, DEMO_CONTRACT_ID, now, now),
    db.prepare("INSERT INTO parties (id, contract_id, role, name, company, email, created_at, updated_at) VALUES (?, ?, 'counterparty', 'Client Reviewer', 'Client Company', 'reviewer@example.test', ?, ?)").bind(clientPartyId, DEMO_CONTRACT_ID, now, now),
    db.prepare("INSERT INTO access_accounts (id, contract_id, party_id, username, password_hash, permission, status, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'propose_changes', 'invited', '2099-12-31T23:59:59.000Z', ?, ?)").bind(accountId, DEMO_CONTRACT_ID, clientPartyId, DEMO_USERNAME, passwordHash, now, now),
    ...blockRows.map((block) => db.prepare("INSERT INTO document_blocks (id, contract_id, block_key, order_index, kind, current_text, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(block.id, DEMO_CONTRACT_ID, `paragraph-${block.orderIndex + 1}`, block.orderIndex, block.kind, block.text, block.hash, now, now)),
    db.prepare("INSERT INTO contract_versions (id, contract_id, version_number, created_by, snapshot, created_at) VALUES (?, ?, 1, ?, json(?), ?)").bind(versionId, DEMO_CONTRACT_ID, ownerId, JSON.stringify(snapshot), now),
    db.prepare("INSERT INTO audit_log_entries (id, contract_id, actor_id, actor_display, action, target_type, target_id, version_number, request_id, metadata, created_at) VALUES (?, ?, ?, 'Contract Owner', 'demo.created', 'contract', ?, 1, ?, json(?), ?)").bind(crypto.randomUUID(), DEMO_CONTRACT_ID, ownerId, DEMO_CONTRACT_ID, crypto.randomUUID(), JSON.stringify({ genericDemo: true }), now),
  ]);

  const blob = createDocumentDocx("Demo Master Services Agreement", 1, demoBlocks);
  const bytes = await blob.arrayBuffer();
  const sha256 = await sha256BufferHex(bytes);
  const objectKey = `contracts/${DEMO_CONTRACT_ID}/versions/1/demo-master-services-agreement.docx`;
  await env.DOCUMENTS.put(objectKey, bytes, { httpMetadata: { contentType: blob.type }, customMetadata: { contractId: DEMO_CONTRACT_ID, version: "1" } });
  await db.batch([
    db.prepare("INSERT INTO document_objects (id, contract_id, object_key, filename, content_type, byte_size, sha256, scan_status, uploaded_by, created_at) VALUES (?, ?, ?, 'Demo Master Services Agreement.docx', ?, ?, ?, 'pending', ?, ?)").bind("sample-document-1", DEMO_CONTRACT_ID, objectKey, blob.type, bytes.byteLength, sha256, ownerId, now),
    db.prepare("UPDATE contract_versions SET document_object_key = ?, document_sha256 = ? WHERE id = ?").bind(objectKey, sha256, versionId),
  ]);
  return { ownerId, contractId: DEMO_CONTRACT_ID };
}
