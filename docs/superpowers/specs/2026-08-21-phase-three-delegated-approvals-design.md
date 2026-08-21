# Phase 3 Delegated Approvals — Design Spec

Date: 2026-08-21
Repository: `pactline-contract-collaboration`
Base Branch: `codex/version-two-expansion`
Design Branch: `feature/phase-three-delegated-approvals-design`

---

## 1. Executive Summary & Goals

Phase 3 introduces **Delegated, Multi-Person Approvals** to Pactline. In Phase 1 and 2, approvals were scoped directly to internal contract owner user accounts. Phase 3 enables contract owners to assign specific, named domain approvers (Legal Counsel, Finance Officers, Chief Security Officers, Business Leads) to evaluate contract versions independently.

### Core Objectives
1. **Delegated Approver Identities**: Separate dedicated approver personas from Contract Owners, Reviewers (counterparty access accounts), and Suppliers (portal accounts).
2. **Secure One-Time Link Authentication**: A zero-trust, token-based invite mechanism issuing single-use invite tokens. Tokens are stored exclusively as SHA-256 hashes and exchanged for secure, scoped approver session cookies.
3. **Version-Scoped Approval Gating**: Approval decisions are bound to explicit contract version snapshots. Re-evaluations are strictly required when contract contents change or when counterproposals increment the version.
4. **Server-Side Enforcement**: Agreement, locking, and execution remain strictly gated by the server: all required approvals for the active version must be in `approved` state.
5. **Clear Persona Isolation**: Dedicated minimal approver interfaces (`/approve/...`) stripped of contract management, owner settings, reviewer counterproposals, or supplier vault controls.
6. **Provider-Neutral Delivery**: In the absence of an external SMTP email server, invite links are generated as local-stub copyable URLs presented directly to the owner.

---

## 2. Proposed Database Schema & Migrations

All Phase 3 database modifications are **forward-only and strictly additive**. Existing tables (`contracts`, `approval_requests`, `users`) will not undergo destructive schema changes (no `DROP COLUMN` or column type alterations).

### Schema Additions (`db/schema.ts`)

```typescript
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// 1. Delegated Approvers Directory
export const delegatedApprovers = sqliteTable("delegated_approvers", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  titleRole: text("title_role").notNull(), // e.g. "VP of Legal", "Finance Lead"
  organizationId: text("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lastSignedInAt: text("last_signed_in_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_delegated_approvers_email").on(table.email),
  index("idx_delegated_approvers_status").on(table.status),
]);

// 2. One-Time Expiring Approval Invites
export const approvalInvites = sqliteTable("approval_invites", {
  id: text("id").primaryKey(),
  approvalRequestId: text("approval_request_id").notNull().references(() => approvalRequests.id, { onDelete: "cascade" }),
  delegatedApproverId: text("delegated_approver_id").notNull().references(() => delegatedApprovers.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
  revokedAt: text("revoked_at"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_approval_invites_token_hash").on(table.tokenHash),
  index("idx_approval_invites_request_active").on(table.approvalRequestId, table.expiresAt, table.usedAt, table.revokedAt),
]);

// 3. Dedicated Approver Sessions
export const approverSessions = sqliteTable("approver_sessions", {
  id: text("id").primaryKey(),
  delegatedApproverId: text("delegated_approver_id").notNull().references(() => delegatedApprovers.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
  lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  ipHash: text("ip_hash"),
  userAgentHash: text("user_agent_hash"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_approver_sessions_token_hash").on(table.tokenHash),
  index("idx_approver_sessions_active").on(table.delegatedApproverId, table.expiresAt, table.revokedAt),
]);
```

### Updates to Existing Tables

To preserve existing Phase 1 approval records (`approver_id` referencing `users.id`), `approval_requests` is extended additively:

```typescript
// Additive fields on approvalRequests table:
export const approvalRequests = sqliteTable("approval_requests", {
  // Existing fields...
  id: text("id").primaryKey(),
  contractId: text("contract_id").notNull().references(() => contracts.id, { onDelete: "cascade" }),
  approverId: text("approver_id").references(() => users.id), // Made nullable for delegated-only assignments
  delegatedApproverId: text("delegated_approver_id").references(() => delegatedApprovers.id, { onDelete: "set null" }), // New
  versionNumber: integer("version_number").notNull().default(1),
  kind: text("kind", { enum: ["legal", "finance", "security", "business"] }).notNull().default("business"),
  required: integer("required", { mode: "boolean" }).notNull().default(true),
  status: text("status", { enum: ["pending", "approved", "rejected", "edits_requested"] }).notNull().default("pending"),
  comment: text("comment"),
  decisionReason: text("decision_reason"),
  resolvedAt: text("resolved_at"),
  assignedBy: text("assigned_by"), // Owner user ID who created assignment
  ...timestamps,
}, (table) => [
  index("idx_approval_requests_approver_status").on(table.approverId, table.status),
  index("idx_approval_requests_delegated").on(table.delegatedApproverId, table.status),
  index("idx_approval_requests_contract_version").on(table.contractId, table.versionNumber),
]);
```

### Proposed SQL Migration (`drizzle/0013_delegated_approvals.sql`)

```sql
CREATE TABLE `delegated_approvers` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`title_role` text NOT NULL,
	`organization_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`last_signed_in_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_delegated_approvers_email` ON `delegated_approvers` (`email`);--> statement-breakpoint
CREATE INDEX `idx_delegated_approvers_status` ON `delegated_approvers` (`status`);--> statement-breakpoint

CREATE TABLE `approval_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`approval_request_id` text NOT NULL,
	`delegated_approver_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`revoked_at` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`approval_request_id`) REFERENCES `approval_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`delegated_approver_id`) REFERENCES `delegated_approvers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_approval_invites_token_hash` ON `approval_invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_approval_invites_request_active` ON `approval_invites` (`approval_request_id`, `expires_at`, `used_at`, `revoked_at`);--> statement-breakpoint

CREATE TABLE `approver_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`delegated_approver_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`ip_hash` text,
	`user_agent_hash` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`delegated_approver_id`) REFERENCES `delegated_approvers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_approver_sessions_token_hash` ON `approver_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_approver_sessions_active` ON `approver_sessions` (`delegated_approver_id`, `expires_at`, `revoked_at`);--> statement-breakpoint

ALTER TABLE `approval_requests` ADD COLUMN `delegated_approver_id` text REFERENCES `delegated_approvers`(`id`) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `approval_requests` ADD COLUMN `assigned_by` text;--> statement-breakpoint
CREATE INDEX `idx_approval_requests_delegated` ON `approval_requests` (`delegated_approver_id`, `status`);--> statement-breakpoint
CREATE INDEX `idx_approval_requests_contract_version` ON `approval_requests` (`contract_id`, `version_number`);
```

---

## 3. Secure Approval Access Architecture

### Invite Token & Cookie Security Model

```
 ┌──────────────┐     1. Create Assignment & Invite      ┌──────────────────┐
 │ Contract     │ ─────────────────────────────────────> │ Generate Random  │
 │ Owner (UI)   │ <───────────────────────────────────── │ 256-bit Token    │
 └──────────────┘      2. Copyable Invite URL            └──────────────────┘
        │                 (local stub)                            │
        │                                                         │ Store SHA-256
        │ 3. Open Invite URL                                      ▼
        ▼                                                ┌──────────────────┐
 ┌──────────────┐     4. Validate Token & Consume        │ approval_invites │
 │ Delegated    │ ─────────────────────────────────────> │ (token_hash)     │
 │ Approver     │ <───────────────────────────────────── └──────────────────┘
 └──────────────┘     5. Set Secure Session Cookie                │
        │                __Host-Pactline-Approver-Session         │ Issue Session
        │                                                         ▼
        │ 6. Submit Decision (Approve / Request Edits)   ┌──────────────────┐
        └──────────────────────────────────────────────> │approver_sessions │
                                                         │ (token_hash)     │
                                                         └──────────────────┘
```

#### 1. Token Generation & Storage
- **Invite Tokens**: 256-bit cryptographically secure random values (hex-encoded string).
- **Zero Raw Tokens Stored**: Raw tokens are returned to the contract owner ONCE upon creation. Only `sha256Hex(rawToken)` is stored in `approval_invites.token_hash`.
- **Expiration**: Default invite token TTL is **72 hours**. Expired tokens are rejected automatically upon consumption.
- **Single-Use Enforcement**: Upon consumption, `used_at` is stamped. Subsequent requests with the same raw invite token return HTTP 410 Gone / 401 Unauthorized.

#### 2. Approver Session Cookie
- **Cookie Name**: `__Host-Pactline-Approver-Session`
- **Attributes**:
  - `HttpOnly`: true (JavaScript cannot read token)
  - `Secure`: true (HTTPS required in production)
  - `SameSite`: `Strict` (Prevents CSRF)
  - `Path`: `/`
- **Session Duration**: 8-hour rolling expiration.
- **Revocation & Logout**: Calling `/api/approver/logout` updates `revoked_at = CURRENT_TIMESTAMP` in `approver_sessions` and clears the cookie header.

#### 3. Provider-Neutral Delivery (Local-Stub Invite Link)
- Pactline has no external email sending infrastructure.
- When an owner assigns a delegated approver, the API creates an `approval_invites` record and enqueues a `reminder_approval` delivery to the `notification_deliveries` stub table.
- The UI presents a **"Copy Invite Link"** action to the owner:
  `http://localhost:4319/approve/invite?token=0f8a92b...`
- The documentation, UI, and log statements MUST NEVER state that an email was sent; it is strictly described as a generated invite link or local stub delivery.

---

## 4. Versioning & Contract Lifecycle Rules

### Version-Scoped Approvals Matrix

| Scenario | System Behavior | Audit Action |
| :--- | :--- | :--- |
| **New Contract Version Created** | All required approval requests for `version_number = N+1` are instantiated in `pending` state. Previous version `N` approval decisions remain preserved in immutable history. | `approval_requests.instantiated` |
| **Counterproposal Submitted** | Counterproposals update paragraph state. Upon owner acceptance or structural rebase incrementing `version_number`, required approvals for the new version reset to `pending`. | `contract_version.incremented` |
| **Amendment Created (`amends`)** | Amendments are distinct contracts linked via `contract_relationships`. The amendment has its own isolated approval matrix starting at `version_number = 1`. | `contract_relationship.created` |
| **Contract Locked (`locked`)** | Server validates `current_version`. All `required = true` approvals for `current_version` must be `status = 'approved'`. Once locked, no reassignments, invite generation, or decision modifications are accepted. | `contract_lifecycle.locked` |

### Reassignment, Withdrawal, & Re-approval
- **Reassignment**: Contract owner can reassign an active `pending` approval request to a different delegated approver. The original `approval_requests` row is updated with `delegated_approver_id = new_id`, existing pending invites are marked `revoked_at`, and a new invite is generated.
- **Withdrawal / Revocation**: Owner can revoke an invite or cancel a pending request. If an approver requested edits, owner can address the feedback and invoke **"Request Re-approval"**, creating a fresh pending request record for the current or incremented version.
- **Audit Preservation**: Decision history is never overwritten or deleted. Previous version decisions remain queryable via `/api/contracts/[contractId]/approvals?version=N`.

### Server-Side Approval Gate
Before allowing transition to `agreed`, `locked`, or executing final contract downloads, the server enforces:
```typescript
const pendingRequired = await db.prepare(`
  SELECT COUNT(*) as count FROM approval_requests
  WHERE contract_id = ? AND version_number = ? AND required = 1 AND status != 'approved'
`).bind(contractId, currentVersion).first<{ count: number }>();

if (pendingRequired.count > 0) {
  return Response.json(
    { error: "Cannot execute or lock contract: required version approvals are pending or rejected." },
    { status: 409 }
  );
}
```

---

## 5. API Endpoint Specification & Permission Matrix

### Permission Matrix

| Endpoint | Owner | Delegated Approver | Reviewer | Supplier |
| :--- | :---: | :---: | :---: | :---: |
| `POST /api/owner/contracts/[contractId]/approvers` | ✅ | ❌ (403) | ❌ (403) | ❌ (403) |
| `GET /api/owner/contracts/[contractId]/approvals` | ✅ | ❌ (403) | ❌ (403) | ❌ (403) |
| `POST /api/owner/contracts/[contractId]/approvals/[id]/invite` | ✅ | ❌ (403) | ❌ (403) | ❌ (403) |
| `POST /api/owner/contracts/[contractId]/approvals/[id]/revoke` | ✅ | ❌ (403) | ❌ (403) | ❌ (403) |
| `GET /api/approver/invite/consume` | ❌ (401) | ✅ (valid token) | ❌ (401) | ❌ (401) |
| `GET /api/approver/session` | ❌ (401) | ✅ (valid cookie) | ❌ (401) | ❌ (401) |
| `GET /api/approver/contracts/[contractId]` | ❌ (403) | ✅ (assigned only) | ❌ (403) | ❌ (403) |
| `POST /api/approver/contracts/[contractId]/decide` | ❌ (403) | ✅ (assigned only) | ❌ (403) | ❌ (403) |
| `POST /api/approver/logout` | ❌ (401) | ✅ (valid cookie) | ❌ (401) | ❌ (401) |

---

### Detailed Endpoint Models

#### 1. Assign Delegated Approver
- **`POST /api/owner/contracts/[contractId]/approvers`**
- **Auth**: Owner Boundary (`requireOwnerApi`)
- **Request Body**:
  ```json
  {
    "email": "legal.counsel@company.test",
    "displayName": "Sarah Jenkins",
    "titleRole": "VP of Legal",
    "kind": "legal",
    "required": true
  }
  ```
- **Response (201 Created)**:
  ```json
  {
    "approvalRequestId": "app-req-123",
    "delegatedApproverId": "del-app-456",
    "kind": "legal",
    "inviteUrl": "http://localhost:4319/approve/invite?token=a8f9c2d1...",
    "expiresAt": "2026-08-24T14:00:00Z"
  }
  ```

#### 2. Consume One-Time Invite Link
- **`GET /api/approver/invite/consume?token=a8f9c2d1...`**
- **Auth**: None (Token validated from URL)
- **Behavior**:
  1. Computes `hash = sha256Hex(token)`.
  2. Query `approval_invites` where `token_hash = hash AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW`.
  3. If invalid/expired: returns `401 Unauthorized` / `410 Gone` with clear error UI.
  4. If valid: updates `used_at = NOW`, creates `approver_sessions` row with fresh session token, sets `__Host-Pactline-Approver-Session` cookie.
  5. Redirects to `/approve/[contractId]`.

#### 3. Approver View Contract & Decision Screen
- **`GET /api/approver/contracts/[contractId]`**
- **Auth**: Delegated Approver Session Cookie
- **Response (200 OK)**:
  ```json
  {
    "contract": {
      "id": "sample-contract",
      "title": "Services Agreement",
      "currentVersion": 2,
      "status": "internal_review"
    },
    "approvalRequest": {
      "id": "app-req-123",
      "kind": "legal",
      "versionNumber": 2,
      "status": "pending",
      "required": true
    },
    "versionSnapshot": [
      { "orderIndex": 1, "kind": "title", "currentText": "Services Agreement" },
      { "orderIndex": 2, "kind": "body", "currentText": "Section 1. Terms..." }
    ]
  }
  ```

#### 4. Submit Decision (Approve or Request Edits)
- **`POST /api/approver/contracts/[contractId]/decide`**
- **Auth**: Delegated Approver Session Cookie
- **Request Body**:
  ```json
  {
    "approvalRequestId": "app-req-123",
    "decision": "approved", // or "edits_requested" or "rejected"
    "decisionReason": "Legal terms compliant with 2026 corporate policy."
  }
  ```
- **Validation**: `decisionReason` is **mandatory** (minimum 5 characters).
- **Response (200 OK)**:
  ```json
  {
    "success": true,
    "approvalRequestId": "app-req-123",
    "status": "approved",
    "resolvedAt": "2026-08-21T14:50:00Z"
  }
  ```

---

## 6. Product Surfaces & UI Specification

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ CONTRACT OWNER SURFACE: /workflow/[contractId]                                         │
│ ┌────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ DELEGATED APPROVAL MATRIX (Version 2)                                              │ │
│ │ ┌──────────┬─────────────────┬──────────────┬──────────────┬─────────────────────┐ │ │
│ │ │ Kind     │ Approver        │ Status       │ Decision     │ Actions             │ │ │
│ │ ├──────────┼─────────────────┼──────────────┼──────────────┼─────────────────────┤ │ │
│ │ │ Legal    │ Sarah Jenkins   │ ✓ Approved   │ Reason...    │ [Re-request]        │ │ │
│ │ │ Finance  │ Marcus Vance    │ ⏳ Pending    │ Invite Sent  │ [Copy Link] [Revoke]│ │ │
│ │ │ Security │ Elena Rostova   │ ⚠ Edits Req  │ Reason...    │ [Request Re-appr]   │ │ │
│ │ └──────────┴─────────────────┴──────────────┴──────────────┴─────────────────────┘ │ │
│ │ [+ Assign Delegated Approver]                                                      │ │
│ └────────────────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────────────────┐
│ DELEGATED APPROVER SURFACE: /approve/[contractId]                                       │
│ ┌────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ PACTLINE APPROVAL PORTAL                       Signed in as: Sarah Jenkins (Legal) │ │
│ ├────────────────────────────────────────────────────────────────────────────────────┤ │
│ │ Contract: Services Agreement (v2)              Approval Required: LEGAL REVIEW      │ │
│ │ ┌────────────────────────────────────────────────────────────────────────────────┐ │ │
│ │ │ CONTRACT READ-ONLY TEXT SNAPSHOT (Version 2)                                   │ │ │
│ │ │ 1. Scope of Work...                                                          │ │ │
│ │ │ 2. Indemnification & Liability...                                            │ │ │
│ │ └────────────────────────────────────────────────────────────────────────────────┘ │ │
│ │ DECISION & REASON (Mandatory):                                                     │ │
│ │ [ Textarea: Enter formal approval or edit rationale...                          ] │ │
│ │                                                                                    │ │
│ │ [ ✓ Approve Contract Version 2 ]       [ ⚠ Request Edits ]                         │ │
│ └────────────────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### Surface Isolation Safeguards
1. **Approver Screen Isolation**: The `/approve/[contractId]` interface MUST NOT render owner workflow controls (demo reset, lifecycle stage overrides, contract deletion, member management) or reviewer/supplier draft editing tools.
2. **Reviewer & Supplier Isolation**: Reviewer workspace (`/review/[contractId]`) and Supplier Portal (`/portal/...`) MUST NOT render approval assignment forms, copyable invite links, or approval decision controls.

---

## 7. Audit-Log & Telemetry Events

All Phase 3 approval actions generate structured audit log entries in `audit_log_entries`:

| Event Action | Trigger | Metadata Captured |
| :--- | :--- | :--- |
| `delegated_approver.assigned` | Owner assigns an approver to contract | `kind`, `delegatedApproverId`, `email`, `versionNumber` |
| `approval_invite.created` | Invite token generated | `approvalRequestId`, `expiresAt`, `inviteId` (no token!) |
| `approval_invite.consumed` | Approver opens invite link | `approvalRequestId`, `delegatedApproverId` |
| `approval_invite.revoked` | Owner revokes invite link | `approvalRequestId`, `inviteId` |
| `approval_decision.recorded` | Approver submits decision | `versionNumber`, `kind`, `decision`, `decisionReason` |
| `approval.rerequested` | Owner requests re-approval after edits | `approvalRequestId`, `previousVersion`, `newVersion` |

---

## 8. Rollout Strategy & Backward Compatibility

1. **Phase 1 Record Preservation**:
   - Existing `approval_requests` rows where `approver_id` references `users.id` remain valid.
   - The query engine handles both internal user approvers (`approver_id`) and delegated approvers (`delegated_approver_id`).
2. **Forward-Only Migrations**:
   - Applied cleanly via Drizzle migration runner (`0013_delegated_approvals.sql`).
   - Non-destructive additions guarantee zero downtime or data loss for existing contract versions.

---

## 9. Verification & Test Plan

### 1. Direct API Authorization & Security Tests
- `POST /api/owner/contracts/[contractId]/approvers` with invalid/missing owner session returns `401 Unauthorized`.
- Reviewer or Supplier session attempting to access `/api/owner/contracts/[contractId]/approvers` returns `403 Forbidden`.
- Consuming an expired or already-used invite token returns `410 Gone` / `401 Unauthorized`.
- Submitting an approval decision without a `decisionReason` returns `400 Bad Request`.
- Approver attempting to submit a decision for a contract version they were not assigned to returns `403 Forbidden`.

### 2. E2E Playwright Isolation Tests
- **Full Lifecycle E2E**:
  1. Owner creates contract and assigns Delegated Legal Approver.
  2. Owner copies local-stub invite link.
  3. Delegated Approver consumes invite link and accesses `/approve/[contractId]`.
  4. Approver submits `edits_requested` with mandatory rationale.
  5. Contract status remains blocked from `locked`/`agreed` (409 Conflict).
  6. Owner updates structured paragraph (incrementing version to `v2`).
  7. Owner requests re-approval for Legal.
  8. Delegated Approver opens v2, reviews snapshot, and submits `approved` with reason.
  9. All required version 2 approvals are now `approved`; server unlocks `locked` transition.

---

## 10. Key Decisions Requiring User Approval Before Coding

Before proceeding with application code implementation, the user must approve the following design decisions:

1. **Invite Link Expiration Duration**: Design specifies **72 hours** default TTL for invite tokens and **8 hours** for active approver session cookies.
2. **Mandatory Rationale Enforcement**: Requiring a non-empty `decisionReason` for both `approved` and `edits_requested` decisions.
3. **Automatic Version Invalidation**: Automatic reset of required approvals to `pending` whenever `current_version` is incremented.

---

## 11. Known System Limitations

1. **No External SMTP Email Provider**: Invites are generated as copyable HTTP URLs (`http://localhost:4319/approve/invite?token=...`) and logged in the local-stub notification queue (`notification_deliveries`). They are never described as delivered via email.
2. **Single Active Invite per Request**: Generating a new invite for an approval request automatically revokes any previous unconsumed invites for that specific request.
