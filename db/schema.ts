import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
};

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  externalIdentityId: text("external_identity_id").notNull(),
  managerId: text("manager_id"),
  status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
  ...timestamps,
}, (table) => [uniqueIndex("idx_users_email").on(table.email), uniqueIndex("idx_users_external_identity").on(table.externalIdentityId)]);

export const contracts = sqliteTable("contracts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  initiatorId: text("initiator_id").notNull().references(() => users.id),
  approverId: text("approver_id").notNull().references(() => users.id),
  status: text("status", { enum: ["draft", "pending_internal_approval", "approved", "shared", "negotiating", "agreed", "locked"] }).notNull().default("draft"),
  templateId: text("template_id"),
  crmRecordId: text("crm_record_id"),
  currentVersion: integer("current_version").notNull().default(1),
  lockedAt: text("locked_at"),
  ...timestamps,
}, (table) => [index("idx_contracts_initiator_status").on(table.initiatorId, table.status), index("idx_contracts_approver_status").on(table.approverId, table.status)]);

export const parties = sqliteTable("parties", {
  id: text("id").primaryKey(),
  contractId: text("contract_id").notNull().references(() => contracts.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["initiator", "counterparty"] }).notNull(),
  name: text("name").notNull(),
  company: text("company").notNull(),
  email: text("email").notNull(),
  ...timestamps,
}, (table) => [uniqueIndex("idx_parties_contract_role").on(table.contractId, table.role), index("idx_parties_email").on(table.email)]);

export const accessAccounts = sqliteTable("access_accounts", {
  id: text("id").primaryKey(),
  contractId: text("contract_id").notNull().references(() => contracts.id, { onDelete: "cascade" }),
  partyId: text("party_id").notNull().references(() => parties.id, { onDelete: "cascade" }),
  username: text("username").notNull(),
  passwordHash: text("password_hash").notNull(),
  permission: text("permission", { enum: ["view", "comment", "propose_changes"] }).notNull().default("view"),
  status: text("status", { enum: ["invited", "active", "locked", "revoked", "expired"] }).notNull().default("invited"),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  passwordChangedAt: text("password_changed_at"),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
  lastSignedInAt: text("last_signed_in_at"),
  ...timestamps,
}, (table) => [uniqueIndex("idx_access_accounts_username").on(table.username), index("idx_access_accounts_contract_status").on(table.contractId, table.status)]);

export const approvalRequests = sqliteTable("approval_requests", {
  id: text("id").primaryKey(),
  contractId: text("contract_id").notNull().references(() => contracts.id, { onDelete: "cascade" }),
  approverId: text("approver_id").notNull().references(() => users.id),
  status: text("status", { enum: ["pending", "approved", "rejected", "edits_requested"] }).notNull().default("pending"),
  comment: text("comment"),
  resolvedAt: text("resolved_at"),
  ...timestamps,
}, (table) => [index("idx_approval_requests_approver_status").on(table.approverId, table.status), index("idx_approval_requests_contract").on(table.contractId)]);

export const contractVersions = sqliteTable("contract_versions", {
  id: text("id").primaryKey(),
  contractId: text("contract_id").notNull().references(() => contracts.id, { onDelete: "cascade" }),
  versionNumber: integer("version_number").notNull(),
  createdBy: text("created_by").notNull(),
  snapshot: text("snapshot", { mode: "json" }).notNull().$type<Array<{ id: string; block_key: string; order_index: number; kind: "title" | "heading" | "body"; current_text: string }>>(),
  parentVersionId: text("parent_version_id"),
  documentObjectKey: text("document_object_key"),
  documentSha256: text("document_sha256"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("idx_contract_versions_number").on(table.contractId, table.versionNumber), index("idx_contract_versions_created").on(table.contractId, table.createdAt)]);

export const agreements = sqliteTable("agreements", {
  id: text("id").primaryKey(),
  contractId: text("contract_id").notNull().references(() => contracts.id, { onDelete: "cascade" }),
  partyId: text("party_id").notNull().references(() => parties.id),
  versionNumber: integer("version_number").notNull(),
  agreedBy: text("agreed_by").notNull(),
  agreedAt: text("agreed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("idx_agreements_party_version").on(table.contractId, table.partyId, table.versionNumber), index("idx_agreements_contract_version").on(table.contractId, table.versionNumber)]);

export const documentObjects = sqliteTable("document_objects", {
  id: text("id").primaryKey(),
  contractId: text("contract_id").notNull().references(() => contracts.id, { onDelete: "cascade" }),
  objectKey: text("object_key").notNull(),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  byteSize: integer("byte_size").notNull(),
  sha256: text("sha256").notNull(),
  scanStatus: text("scan_status", { enum: ["pending", "clean", "blocked"] }).notNull().default("pending"),
  uploadedBy: text("uploaded_by").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("idx_document_objects_key").on(table.objectKey), index("idx_document_objects_contract").on(table.contractId, table.createdAt)]);

export const auditLogEntries = sqliteTable("audit_log_entries", {
  id: text("id").primaryKey(),
  contractId: text("contract_id").notNull().references(() => contracts.id, { onDelete: "cascade" }),
  actorId: text("actor_id").notNull(),
  actorDisplay: text("actor_display").notNull(),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id"),
  clauseId: text("clause_id"),
  versionNumber: integer("version_number"),
  beforeHash: text("before_hash"),
  afterHash: text("after_hash"),
  requestId: text("request_id").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  metadata: text("metadata", { mode: "json" }).notNull().$type<Record<string, unknown>>().default({}),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_audit_log_contract_created").on(table.contractId, table.createdAt), index("idx_audit_log_actor_created").on(table.actorId, table.createdAt)]);

export const documentBlocks = sqliteTable("document_blocks", {
  id: text("id").primaryKey(),
  contractId: text("contract_id").notNull().references(() => contracts.id, { onDelete: "cascade" }),
  blockKey: text("block_key").notNull(),
  orderIndex: integer("order_index").notNull(),
  kind: text("kind", { enum: ["title", "heading", "body"] }).notNull().default("body"),
  currentText: text("current_text").notNull(),
  contentHash: text("content_hash").notNull(),
  ...timestamps,
}, (table) => [uniqueIndex("idx_document_blocks_contract_key").on(table.contractId, table.blockKey), uniqueIndex("idx_document_blocks_contract_order").on(table.contractId, table.orderIndex)]);

export const paragraphProposals = sqliteTable("paragraph_proposals", {
  id: text("id").primaryKey(),
  contractId: text("contract_id").notNull().references(() => contracts.id, { onDelete: "cascade" }),
  blockId: text("block_id").notNull().references(() => documentBlocks.id, { onDelete: "cascade" }),
  baseVersion: integer("base_version").notNull(),
  proposedByAccountId: text("proposed_by_account_id").notNull().references(() => accessAccounts.id),
  originalText: text("original_text").notNull(),
  proposedText: text("proposed_text").notNull(),
  rationale: text("rationale"),
  counterText: text("counter_text"),
  status: text("status", { enum: ["pending", "accepted", "rejected", "countered", "superseded", "withdrawn"] }).notNull().default("pending"),
  resolvedAt: text("resolved_at"),
  resolvedBy: text("resolved_by"),
  ...timestamps,
}, (table) => [index("idx_paragraph_proposals_queue").on(table.contractId, table.status, table.createdAt), index("idx_paragraph_proposals_block").on(table.blockId, table.createdAt)]);

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const mutationGuards = sqliteTable("mutation_guards", {
  id: text("id").primaryKey(),
  satisfied: integer("satisfied").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [check("mutation_guards_satisfied", sql`${table.satisfied} = 1`)]);

export const accessSessions = sqliteTable("access_sessions", {
  id: text("id").primaryKey(),
  accessAccountId: text("access_account_id").notNull().references(() => accessAccounts.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
  lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  ipHash: text("ip_hash"),
  userAgentHash: text("user_agent_hash"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("idx_access_sessions_token_hash").on(table.tokenHash), index("idx_access_sessions_account_active").on(table.accessAccountId, table.expiresAt, table.revokedAt)]);
