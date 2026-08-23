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

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["customer", "supplier"] }).notNull(),
  timezone: text("timezone").notNull().default("America/Indianapolis"),
  status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
  ...timestamps,
}, (table) => [index("idx_organizations_kind_status").on(table.kind, table.status)]);

export const organizationMemberships = sqliteTable("organization_memberships", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["owner_admin", "contract_manager"] }).notNull().default("contract_manager"),
  status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
  ...timestamps,
}, (table) => [uniqueIndex("idx_organization_memberships_unique").on(table.organizationId, table.userId), index("idx_organization_memberships_user_status").on(table.userId, table.status)]);

export const supplierRelationships = sqliteTable("supplier_relationships", {
  id: text("id").primaryKey(),
  customerOrganizationId: text("customer_organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  supplierOrganizationId: text("supplier_organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["active", "inactive"] }).notNull().default("active"),
  ...timestamps,
}, (table) => [uniqueIndex("idx_supplier_relationships_unique").on(table.customerOrganizationId, table.supplierOrganizationId), index("idx_supplier_relationships_supplier_status").on(table.supplierOrganizationId, table.status)]);

export const contracts = sqliteTable("contracts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  initiatorId: text("initiator_id").notNull().references(() => users.id),
  approverId: text("approver_id").notNull().references(() => users.id),
  status: text("status", { enum: ["draft", "pending_internal_approval", "approved", "shared", "negotiating", "agreed", "locked"] }).notNull().default("draft"),
  templateId: text("template_id"),
  crmRecordId: text("crm_record_id"),
  ownerOrganizationId: text("owner_organization_id").references(() => organizations.id),
  counterpartyOrganizationId: text("counterparty_organization_id").references(() => organizations.id),
  origin: text("origin", { enum: ["direct_upload", "customer_template", "supplier_upload"] }).notNull().default("direct_upload"),
  submittedByPortalAccountId: text("submitted_by_portal_account_id"),
  effectiveDate: text("effective_date"),
  expirationDate: text("expiration_date"),
  lifecycleStage: text("lifecycle_stage", { enum: ["draft", "internal_review", "external_review", "approved", "executed", "expired", "renewed"] }).notNull().default("draft"),
  renewalDate: text("renewal_date"),
  noticePeriodDays: integer("notice_period_days").notNull().default(30),
  responsibleOwnerId: text("responsible_owner_id").references(() => users.id),
  contractValueMinor: integer("contract_value_minor"),
  currency: text("currency").notNull().default("USD"),
  riskLevel: text("risk_level", { enum: ["low", "medium", "high", "critical"] }).notNull().default("medium"),
  reviewDeadlineAt: text("review_deadline_at"),
  executedAt: text("executed_at"),
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
  versionNumber: integer("version_number").notNull().default(1),
  kind: text("kind", { enum: ["legal", "finance", "security", "business"] }).notNull().default("business"),
  required: integer("required", { mode: "boolean" }).notNull().default(true),
  status: text("status", { enum: ["pending", "approved", "rejected", "edits_requested"] }).notNull().default("pending"),
  comment: text("comment"),
  decisionReason: text("decision_reason"),
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
  reviewRoundId: text("review_round_id"),
  resolutionReason: text("resolution_reason"),
  status: text("status", { enum: ["pending", "accepted", "rejected", "countered", "superseded", "withdrawn"] }).notNull().default("pending"),
  resolvedAt: text("resolved_at"),
  resolvedBy: text("resolved_by"),
  ...timestamps,
}, (table) => [index("idx_paragraph_proposals_queue").on(table.contractId, table.status, table.createdAt), index("idx_paragraph_proposals_block").on(table.blockId, table.createdAt)]);

export const reviewRounds = sqliteTable("review_rounds", {
  id: text("id").primaryKey(),
  contractId: text("contract_id").notNull().references(() => contracts.id, { onDelete: "cascade" }),
  roundNumber: integer("round_number").notNull(),
  status: text("status", { enum: ["open", "closed", "cancelled"] }).notNull().default("open"),
  deadlineAt: text("deadline_at"),
  openedBy: text("opened_by").notNull(),
  closedBy: text("closed_by"),
  closedAt: text("closed_at"),
  ...timestamps,
}, (table) => [uniqueIndex("idx_review_rounds_number").on(table.contractId, table.roundNumber), index("idx_review_rounds_status_deadline").on(table.contractId, table.status, table.deadlineAt)]);

export const paragraphComments = sqliteTable("paragraph_comments", {
  id: text("id").primaryKey(),
  contractId: text("contract_id").notNull().references(() => contracts.id, { onDelete: "cascade" }),
  blockId: text("block_id").notNull().references(() => documentBlocks.id, { onDelete: "cascade" }),
  reviewRoundId: text("review_round_id").references(() => reviewRounds.id, { onDelete: "set null" }),
  parentCommentId: text("parent_comment_id"),
  authorKind: text("author_kind", { enum: ["owner", "reviewer"] }).notNull(),
  authorId: text("author_id").notNull(),
  authorDisplay: text("author_display").notNull(),
  body: text("body").notNull(),
  status: text("status", { enum: ["open", "resolved"] }).notNull().default("open"),
  resolvedBy: text("resolved_by"),
  resolvedAt: text("resolved_at"),
  resolutionReason: text("resolution_reason"),
  reopenedBy: text("reopened_by"),
  reopenedAt: text("reopened_at"),
  ...timestamps,
}, (table) => [index("idx_paragraph_comments_block").on(table.contractId, table.blockId, table.createdAt), index("idx_paragraph_comments_status").on(table.contractId, table.status), index("idx_paragraph_comments_parent").on(table.parentCommentId)]);

export const contractRelationships = sqliteTable("contract_relationships", {
  id: text("id").primaryKey(),
  sourceContractId: text("source_contract_id").notNull().references(() => contracts.id, { onDelete: "cascade" }),
  targetContractId: text("target_contract_id").notNull().references(() => contracts.id, { onDelete: "cascade" }),
  relationshipType: text("relationship_type", { enum: ["amends", "renews", "supersedes", "related"] }).notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("idx_contract_relationship_unique").on(table.sourceContractId, table.targetContractId, table.relationshipType), index("idx_contract_relationship_target").on(table.targetContractId)]);

export const reminderSchedules = sqliteTable("reminder_schedules", {
  id: text("id").primaryKey(),
  contractId: text("contract_id").notNull().references(() => contracts.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["review_deadline", "notice_window", "renewal", "expiration"] }).notNull(),
  channel: text("channel", { enum: ["in_app", "email", "calendar"] }).notNull().default("in_app"),
  dueAt: text("due_at").notNull(),
  recipient: text("recipient"),
  status: text("status", { enum: ["scheduled", "sent", "failed", "cancelled"] }).notNull().default("scheduled"),
  providerMessageId: text("provider_message_id"),
  lastError: text("last_error"),
  ...timestamps,
}, (table) => [index("idx_reminder_due_status").on(table.status, table.dueAt), index("idx_reminder_contract").on(table.contractId, table.kind)]);

export const errorEvents = sqliteTable("error_events", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull(),
  route: text("route").notNull(),
  method: text("method").notNull(),
  actorScope: text("actor_scope").notNull(),
  contractId: text("contract_id").references(() => contracts.id, { onDelete: "set null" }),
  severity: text("severity", { enum: ["warning", "error", "critical"] }).notNull().default("error"),
  message: text("message").notNull(),
  fingerprint: text("fingerprint").notNull(),
  metadata: text("metadata", { mode: "json" }).notNull().$type<Record<string, unknown>>().default({}),
  occurrenceCount: integer("occurrence_count").notNull().default(1),
  firstSeenAt: text("first_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  resolvedAt: text("resolved_at"),
}, (table) => [index("idx_error_events_open").on(table.resolvedAt, table.lastSeenAt), index("idx_error_events_fingerprint").on(table.fingerprint)]);

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

export const portalAccounts = sqliteTable("portal_accounts", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  username: text("username").notNull(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  email: text("email").notNull(),
  status: text("status", { enum: ["active", "locked", "disabled"] }).notNull().default("active"),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  expiresAt: text("expires_at"),
  lastSignedInAt: text("last_signed_in_at"),
  ...timestamps,
}, (table) => [uniqueIndex("idx_portal_accounts_username").on(table.username), index("idx_portal_accounts_organization_status").on(table.organizationId, table.status)]);

export const portalSessions = sqliteTable("portal_sessions", {
  id: text("id").primaryKey(),
  portalAccountId: text("portal_account_id").notNull().references(() => portalAccounts.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
  lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("idx_portal_sessions_token_hash").on(table.tokenHash), index("idx_portal_sessions_account_active").on(table.portalAccountId, table.expiresAt, table.revokedAt)]);

export const contractAccessGrants = sqliteTable("contract_access_grants", {
  id: text("id").primaryKey(),
  contractId: text("contract_id").notNull().references(() => contracts.id, { onDelete: "cascade" }),
  portalAccountId: text("portal_account_id").notNull().references(() => portalAccounts.id, { onDelete: "cascade" }),
  legacyAccessAccountId: text("legacy_access_account_id").references(() => accessAccounts.id),
  permission: text("permission", { enum: ["view", "comment", "propose_changes"] }).notNull().default("view"),
  status: text("status", { enum: ["active", "revoked", "expired"] }).notNull().default("active"),
  expiresAt: text("expires_at"),
  ...timestamps,
}, (table) => [uniqueIndex("idx_contract_access_grants_unique").on(table.contractId, table.portalAccountId), index("idx_contract_access_grants_account_status").on(table.portalAccountId, table.status)]);

export const vaultDocuments = sqliteTable("vault_documents", {
  id: text("id").primaryKey(),
  ownerOrganizationId: text("owner_organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  supplierOrganizationId: text("supplier_organization_id").references(() => organizations.id),
  linkedContractId: text("linked_contract_id").references(() => contracts.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  category: text("category", { enum: ["msa", "nda", "sow", "cloud_agreement", "po", "invoice", "insurance_certificate", "minority_business_certificate", "other"] }).notNull(),
  visibility: text("visibility", { enum: ["customer_only", "supplier_only", "shared"] }).notNull().default("shared"),
  status: text("status", { enum: ["active", "expired", "archived"] }).notNull().default("active"),
  effectiveDate: text("effective_date"),
  expirationDate: text("expiration_date"),
  currentVersion: integer("current_version").notNull().default(1),
  extractionStatus: text("extraction_status", { enum: ["not_started", "processing", "needs_review", "confirmed", "failed", "needs_ocr"] }).notNull().default("not_started"),
  ...timestamps,
}, (table) => [index("idx_vault_documents_owner_status").on(table.ownerOrganizationId, table.status), index("idx_vault_documents_supplier_status").on(table.supplierOrganizationId, table.status), index("idx_vault_documents_expiration").on(table.expirationDate)]);

export const vaultDocumentVersions = sqliteTable("vault_document_versions", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull().references(() => vaultDocuments.id, { onDelete: "cascade" }),
  versionNumber: integer("version_number").notNull(),
  objectKey: text("object_key").notNull(),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  byteSize: integer("byte_size").notNull(),
  sha256: text("sha256").notNull(),
  scanStatus: text("scan_status", { enum: ["pending", "clean", "blocked"] }).notNull().default("pending"),
  uploadedBy: text("uploaded_by").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("idx_vault_document_versions_number").on(table.documentId, table.versionNumber), uniqueIndex("idx_vault_document_versions_key").on(table.objectKey)]);

export const contractTemplates = sqliteTable("contract_templates", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  contractType: text("contract_type").notNull(),
  objectKey: text("object_key").notNull(),
  filename: text("filename").notNull(),
  fields: text("fields", { mode: "json" }).notNull().$type<Array<{ key: string; label: string; required: boolean }>>().default([]),
  status: text("status", { enum: ["active", "archived"] }).notNull().default("active"),
  versionNumber: integer("version_number").notNull().default(1),
  ...timestamps,
}, (table) => [index("idx_contract_templates_organization_status").on(table.organizationId, table.status)]);

export const clauseModules = sqliteTable("clause_modules", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  heading: text("heading").notNull(),
  body: text("body").notNull(),
  status: text("status", { enum: ["active", "archived"] }).notNull().default("active"),
  ...timestamps,
}, (table) => [index("idx_clause_modules_organization_status").on(table.organizationId, table.status)]);

export const extractionRuns = sqliteTable("extraction_runs", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull().references(() => vaultDocuments.id, { onDelete: "cascade" }),
  documentVersionId: text("document_version_id").notNull().references(() => vaultDocumentVersions.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["pending", "processing", "needs_review", "confirmed", "failed", "needs_ocr"] }).notNull().default("pending"),
  model: text("model"),
  error: text("error"),
  completedAt: text("completed_at"),
  ...timestamps,
}, (table) => [index("idx_extraction_runs_document_status").on(table.documentId, table.status)]);

export const extractedFields = sqliteTable("extracted_fields", {
  id: text("id").primaryKey(),
  extractionRunId: text("extraction_run_id").notNull().references(() => extractionRuns.id, { onDelete: "cascade" }),
  fieldKey: text("field_key").notNull(),
  value: text("value").notNull(),
  confidence: integer("confidence").notNull().default(0),
  sourceReference: text("source_reference"),
  reviewStatus: text("review_status", { enum: ["pending", "confirmed", "rejected"] }).notNull().default("pending"),
  correctedValue: text("corrected_value"),
  ...timestamps,
}, (table) => [uniqueIndex("idx_extracted_fields_run_key").on(table.extractionRunId, table.fieldKey), index("idx_extracted_fields_review").on(table.reviewStatus)]);

export const extractedClauses = sqliteTable("extracted_clauses", {
  id: text("id").primaryKey(),
  extractionRunId: text("extraction_run_id").notNull().references(() => extractionRuns.id, { onDelete: "cascade" }),
  clauseType: text("clause_type").notNull(),
  heading: text("heading").notNull(),
  clauseText: text("clause_text").notNull(),
  confidence: integer("confidence").notNull().default(0),
  sourceReference: text("source_reference"),
  reviewStatus: text("review_status", { enum: ["pending", "confirmed", "rejected"] }).notNull().default("pending"),
  ...timestamps,
}, (table) => [index("idx_extracted_clauses_run_review").on(table.extractionRunId, table.reviewStatus), index("idx_extracted_clauses_type").on(table.clauseType)]);

export const searchChunks = sqliteTable("search_chunks", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  documentId: text("document_id").notNull().references(() => vaultDocuments.id, { onDelete: "cascade" }),
  documentVersion: integer("document_version").notNull(),
  clauseId: text("clause_id"),
  content: text("content").notNull(),
  vectorId: text("vector_id"),
  indexStatus: text("index_status", { enum: ["pending", "indexed", "failed", "superseded"] }).notNull().default("pending"),
  ...timestamps,
}, (table) => [index("idx_search_chunks_org_status").on(table.organizationId, table.indexStatus), index("idx_search_chunks_document_version").on(table.documentId, table.documentVersion)]);

export const complianceRequirements = sqliteTable("compliance_requirements", {
  id: text("id").primaryKey(),
  relationshipId: text("relationship_id").notNull().references(() => supplierRelationships.id, { onDelete: "cascade" }),
  documentCategory: text("document_category").notNull(),
  required: integer("required", { mode: "boolean" }).notNull().default(true),
  warningDays: integer("warning_days").notNull().default(30),
  ...timestamps,
}, (table) => [uniqueIndex("idx_compliance_requirements_unique").on(table.relationshipId, table.documentCategory)]);

export const alerts = sqliteTable("alerts", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  supplierOrganizationId: text("supplier_organization_id").references(() => organizations.id),
  contractId: text("contract_id").references(() => contracts.id, { onDelete: "cascade" }),
  documentId: text("document_id").references(() => vaultDocuments.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["renewal_due", "expiration_due", "expired", "missing_compliance"] }).notNull(),
  severity: text("severity", { enum: ["information", "attention", "urgent"] }).notNull().default("attention"),
  title: text("title").notNull(),
  message: text("message").notNull(),
  dueAt: text("due_at"),
  status: text("status", { enum: ["open", "acknowledged", "resolved", "snoozed"] }).notNull().default("open"),
  dedupeKey: text("dedupe_key").notNull(),
  snoozedUntil: text("snoozed_until"),
  acknowledgedAt: text("acknowledged_at"),
  resolvedAt: text("resolved_at"),
  ...timestamps,
}, (table) => [uniqueIndex("idx_alerts_dedupe").on(table.dedupeKey), index("idx_alerts_org_status_due").on(table.organizationId, table.status, table.dueAt)]);

export const notificationDeliveries = sqliteTable("notification_deliveries", {
  id: text("id").primaryKey(),
  recipientEmail: text("recipient_email").notNull(),
  templateName: text("template_name").notNull(),
  templatePayload: text("template_payload", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
  status: text("status", { enum: ["queued", "logged", "failed"] }).notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: text("next_attempt_at"),
  lastError: text("last_error"),
  idempotencyKey: text("idempotency_key"),
  ...timestamps,
}, (table) => [
  index("idx_notification_deliveries_status_next").on(table.status, table.nextAttemptAt),
  uniqueIndex("idx_notification_idempotency_key").on(table.idempotencyKey),
]);

export const notificationPreferences = sqliteTable("notification_preferences", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  portalAccountId: text("portal_account_id").references(() => portalAccounts.id, { onDelete: "cascade" }),
  notificationType: text("notification_type", { enum: ["renewal", "comment", "approval", "amendment"] }).notNull(),
  unsubscribed: integer("unsubscribed", { mode: "boolean" }).notNull().default(false),
  ...timestamps,
}, (table) => [
  uniqueIndex("idx_notification_pref_user_type").on(table.userId, table.notificationType),
  uniqueIndex("idx_notification_pref_portal_type").on(table.portalAccountId, table.notificationType),
]);

export const delegatedApprovers = sqliteTable("delegated_approvers", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  titleRole: text("title_role").notNull(),
  status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lastSignedInAt: text("last_signed_in_at"),
  ...timestamps,
}, (table) => [
  uniqueIndex("idx_delegated_approvers_org_email").on(table.organizationId, table.email),
  index("idx_delegated_approvers_status").on(table.status),
]);

export const approvalAssignments = sqliteTable("approval_assignments", {
  id: text("id").primaryKey(),
  contractId: text("contract_id").notNull().references(() => contracts.id, { onDelete: "cascade" }),
  delegatedApproverId: text("delegated_approver_id").notNull().references(() => delegatedApprovers.id, { onDelete: "cascade" }),
  versionNumber: integer("version_number").notNull(),
  kind: text("kind", { enum: ["legal", "finance", "security", "business"] }).notNull(),
  required: integer("required", { mode: "boolean" }).notNull().default(true),
  status: text("status", { enum: ["pending", "approved", "edits_requested", "revoked", "superseded"] }).notNull().default("pending"),
  decisionReason: text("decision_reason"),
  resolvedAt: text("resolved_at"),
  assignedBy: text("assigned_by").notNull(),
  ...timestamps,
}, (table) => [
  index("idx_approval_assignments_contract_version").on(table.contractId, table.versionNumber),
  index("idx_approval_assignments_approver_status").on(table.delegatedApproverId, table.status),
]);

export const approvalInvites = sqliteTable("approval_invites", {
  id: text("id").primaryKey(),
  assignmentId: text("assignment_id").notNull().references(() => approvalAssignments.id, { onDelete: "cascade" }),
  delegatedApproverId: text("delegated_approver_id").notNull().references(() => delegatedApprovers.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
  revokedAt: text("revoked_at"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_approval_invites_token_hash").on(table.tokenHash),
  index("idx_approval_invites_assignment_active").on(table.assignmentId, table.expiresAt, table.usedAt, table.revokedAt),
]);

export const approverSessions = sqliteTable("approver_sessions", {
  id: text("id").primaryKey(),
  delegatedApproverId: text("delegated_approver_id").notNull().references(() => delegatedApprovers.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: text("expires_at").notNull(),
  lastActiveAt: text("last_active_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  revokedAt: text("revoked_at"),
  ipHash: text("ip_hash"),
  userAgentHash: text("user_agent_hash"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_approver_sessions_token_hash").on(table.tokenHash),
  index("idx_approver_sessions_active").on(table.delegatedApproverId, table.expiresAt, table.revokedAt),
]);
