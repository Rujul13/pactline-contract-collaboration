# Phase 3 Delegated Approvals — Design Spec

Date: 2026-08-21
Repository: `pactline-contract-collaboration`
Base Branch: `codex/version-two-expansion`
Design Branch: `feature/phase-three-delegated-approvals-design`

---

## 1. Executive Summary & Goals

Phase 3 introduces **Delegated, Multi-Person Approvals** to Pactline. In Phase 1 and 2, approvals were scoped directly to internal contract owner user accounts. Phase 3 enables contract owners to assign specific, named domain approvers (Legal Counsel, Finance Officers, Chief Security Officers, Business Leads) to evaluate contract versions independently.

### Core Objectives
1. **Delegated Approver Identities**: Separate dedicated approver personas scoped by organization (`organization_id`), distinct from Contract Owners, Reviewers (counterparty access accounts), and Suppliers (portal accounts).
2. **Non-Destructive Table Preservation**: Keep existing `approval_requests` (`approver_id NOT NULL`) unchanged to avoid risky D1 table rebuilds. Introduce a dedicated `approval_assignments` table to model version-scoped delegated approver assignments.
3. **Secure Two-Step Link Authentication**:
   - Invite tokens expire in **24 hours**.
   - Raw tokens are never logged or stored (only SHA-256 hashes are persisted).
   - Tokens are **NEVER consumed on HTTP GET**. `GET /approve/invite?token=...` serves a landing page with `Referrer-Policy: no-referrer`. Consumption occurs exclusively via explicit `POST /api/approver/invite/consume`.
   - Approver sessions feature an **8-hour absolute maximum** TTL and a **30-minute inactivity sliding timeout**.
4. **Immutable Version History & Fresh Assignments**:
   - On contract version increment (`version_number = N+1`), prior version `N` approval assignment records remain preserved as immutable history.
   - Fresh version-scoped `approval_assignments` rows are created for active requirements in `pending` state.
5. **Reassignment Audit Trail**: Reassigning an approver revokes/supersedes the existing assignment record and produces a new assignment record rather than mutating in place.
6. **Scoped Decision Enum**: Decision scope is strictly limited to `approved` and `edits_requested` (`rejected` is excluded from Phase 3 to avoid contract cancellation ambiguity). Both decisions require a mandatory `decisionReason` (minimum 5 characters).
7. **Server-Side Gate**: Agreement, locking, and execution remain strictly gated on the server: all active version-scoped required assignments must be in `approved` state.
8. **Provider-Neutral Delivery**: In the absence of an external SMTP email server, invite links are generated using the configured canonical app URL (`PACTLINE_APP_URL` / `BASE_URL`) as local-stub copyable URLs presented to the owner.

---

## 2. Database Schema & Migrations

All Phase 3 database modifications are **forward-only and strictly additive**. Existing tables (`contracts`, `approval_requests`, `users`) will not undergo destructive schema changes (no `DROP COLUMN` or column type alterations).

### Schema Additions (`db/schema.ts`)

```typescript
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// 1. Delegated Approvers Directory (Scoped by Organization)
export const delegatedApprovers = sqliteTable("delegated_approvers", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  email: text("email").notNull(), // Normalized lowercase
  displayName: text("display_name").notNull(),
  titleRole: text("title_role").notNull(), // e.g. "VP of Legal", "Finance Director"
  status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lastSignedInAt: text("last_signed_in_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_delegated_approvers_org_email").on(table.organizationId, table.email),
  index("idx_delegated_approvers_status").on(table.status),
]);

// 2. Version-Scoped Delegated Approval Assignments
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
  assignedBy: text("assigned_by").notNull(), // Owner user ID
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_approval_assignments_contract_version").on(table.contractId, table.versionNumber),
  index("idx_approval_assignments_approver_status").on(table.delegatedApproverId, table.status),
]);

// 3. One-Time Expiring Approval Invites
export const approvalInvites = sqliteTable("approval_invites", {
  id: text("id").primaryKey(),
  assignmentId: text("assignment_id").notNull().references(() => approvalAssignments.id, { onDelete: "cascade" }),
  delegatedApproverId: text("delegated_approver_id").notNull().references(() => delegatedApprovers.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: text("expires_at").notNull(), // 24 hours TTL
  usedAt: text("used_at"),
  revokedAt: text("revoked_at"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_approval_invites_token_hash").on(table.tokenHash),
  index("idx_approval_invites_assignment_active").on(table.assignmentId, table.expiresAt, table.usedAt, table.revokedAt),
]);

// 4. Dedicated Approver Sessions
export const approverSessions = sqliteTable("approver_sessions", {
  id: text("id").primaryKey(),
  delegatedApproverId: text("delegated_approver_id").notNull().references(() => delegatedApprovers.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: text("expires_at").notNull(), // 8-hour absolute maximum
  lastActiveAt: text("last_active_at").notNull().default(sql`CURRENT_TIMESTAMP`), // 30-min inactivity check
  revokedAt: text("revoked_at"),
  ipHash: text("ip_hash"),
  userAgentHash: text("user_agent_hash"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_approver_sessions_token_hash").on(table.tokenHash),
  index("idx_approver_sessions_active").on(table.delegatedApproverId, table.expiresAt, table.revokedAt),
]);
```

### Proposed SQL Migration (`drizzle/0013_delegated_approvals.sql`)

```sql
CREATE TABLE `delegated_approvers` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`title_role` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`last_signed_in_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_delegated_approvers_org_email` ON `delegated_approvers` (`organization_id`, `email`);--> statement-breakpoint
CREATE INDEX `idx_delegated_approvers_status` ON `delegated_approvers` (`status`);--> statement-breakpoint

CREATE TABLE `approval_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_id` text NOT NULL,
	`delegated_approver_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`kind` text NOT NULL,
	`required` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decision_reason` text,
	`resolved_at` text,
	`assigned_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`delegated_approver_id`) REFERENCES `delegated_approvers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_approval_assignments_contract_version` ON `approval_assignments` (`contract_id`, `version_number`);--> statement-breakpoint
CREATE INDEX `idx_approval_assignments_approver_status` ON `approval_assignments` (`delegated_approver_id`, `status`);--> statement-breakpoint

CREATE TABLE `approval_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`assignment_id` text NOT NULL,
	`delegated_approver_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`revoked_at` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`assignment_id`) REFERENCES `approval_assignments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`delegated_approver_id`) REFERENCES `delegated_approvers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_approval_invites_token_hash` ON `approval_invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_approval_invites_assignment_active` ON `approval_invites` (`assignment_id`, `expires_at`, `used_at`, `revoked_at`);--> statement-breakpoint

CREATE TABLE `approver_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`delegated_approver_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_active_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revoked_at` text,
	`ip_hash` text,
	`user_agent_hash` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`delegated_approver_id`) REFERENCES `delegated_approvers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_approver_sessions_token_hash` ON `approver_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_approver_sessions_active` ON `approver_sessions` (`delegated_approver_id`, `expires_at`, `revoked_at`);
```

---

## 3. Secure Two-Step Authentication & Session Architecture

```
 ┌──────────────┐     1. Create Assignment & Invite      ┌──────────────────┐
 │ Contract     │ ─────────────────────────────────────> │ Generate Random  │
 │ Owner (UI)   │ <───────────────────────────────────── │ 256-bit Token    │
 └──────────────┘      2. Copyable Invite URL            └──────────────────┘
        │                 (local stub)                            │
        │                                                         │ Store SHA-256
        │ 3. GET /approve/invite?token=... (Landing Page)        ▼
        ▼ (Header: Referrer-Policy: no-referrer)         ┌──────────────────┐
 ┌──────────────┐                                        │ approval_invites │
 │ Delegated    │                                        │ (token_hash)     │
 │ Approver     │ 4. Click "Accept & Access"             └──────────────────┘
 └──────────────┘ ───────────────────────────────────┐            │
        │          POST /api/approver/invite/consume │            │ Consume & Issue
        │ <──────────────────────────────────────────┘            ▼
        │   5. Set Secure Session Cookie                 ┌──────────────────┐
        │      __Host-Pactline-Approver-Session          │approver_sessions │
        │                                                │ (8h max / 30m)   │
        │ 6. Submit Decision (Approve / Request Edits)   └──────────────────┘
        └──────────────────────────────────────────────>
```

#### 1. Token Generation, Storage & Logging Protections
- **Invite Tokens**: 256-bit cryptographically secure random values (hex-encoded string).
- **No Raw Tokens Stored or Logged**: Raw tokens are returned to the owner ONCE upon creation. Only `sha256Hex(rawToken)` is stored in `approval_invites.token_hash`. Server logs and application telemetry MUST redact token query parameters.
- **24-Hour Expiration**: Invite token TTL is set to exactly **24 hours**.
- **Single-Use Enforcement**: Tokens are consumed once via POST. Upon consumption, `used_at` is stamped.

#### 2. Two-Step Consumption Flow (GET Landing Page -> POST Consumption)
- **`GET /approve/invite?token=...`**:
  - Serves a read-only landing page displaying contract title, version, assigned approver name, role, and expiry timestamp.
  - Enforces `Referrer-Policy: no-referrer` header so the raw token in the URL query string is never leaked to external asset requests.
  - **Does NOT modify database state or consume the token**.
- **`POST /api/approver/invite/consume`**:
  - Accepts `{ token }` in JSON body.
  - Verifies hash against `approval_invites`. Checks `used_at IS NULL`, `revoked_at IS NULL`, and `expires_at > NOW`.
  - Marks `used_at = CURRENT_TIMESTAMP`.
  - Generates session token, stores hash in `approver_sessions`, and issues the cookie.

#### 3. Approver Session Cookie & Sliding Timeout
- **Cookie Name**: `__Host-Pactline-Approver-Session`
- **Attributes**: `HttpOnly`, `Secure` (production), `SameSite=Strict`, `Path=/`.
- **Absolute Maximum TTL**: **8 hours** (`expires_at`).
- **Inactivity Sliding Timeout**: **30 minutes**. Every API request updates `last_active_at = CURRENT_TIMESTAMP`. If `NOW - last_active_at > 30 minutes`, session is rejected (401) and cleared.

---

## 4. Versioning, Lifecycle, & Reassignment Rules

### Immutable Version History & Assignment Instantiation

| Scenario | System Behavior | Audit Action |
| :--- | :--- | :--- |
| **New Contract Version Created (`vN -> vN+1`)** | Prior version `vN` `approval_assignments` rows remain unchanged in DB with their final `status` (`approved` or `edits_requested`). New `approval_assignments` rows for `vN+1` are created in `pending` state for active requirements. | `approval_assignment.instantiated` |
| **Owner Reassigns Approver** | The existing `approval_assignments` row is marked `status = 'superseded'` (or `'revoked'`). Pending invites for that assignment receive `revoked_at = CURRENT_TIMESTAMP`. A fresh `approval_assignments` row is created for the new approver. | `approval_assignment.reassigned` |
| **Counterproposal Accepted** | Structural paragraph changes increment `version_number`. Required assignments for the new version instantiate in `pending` state. | `contract_version.incremented` |
| **Contract Locked (`locked`)** | Server validates `current_version`. All `required = true` assignments for `current_version` must be `status = 'approved'`. Locked contracts reject reassignments, invite creation, or decision edits. | `contract_lifecycle.locked` |

### Server-Side Approval Gate
Before allowing transition to `agreed`, `locked`, or executing final contract downloads, the server enforces:
```typescript
const pendingRequired = await db.prepare(`
  SELECT COUNT(*) as count FROM approval_assignments
  WHERE contract_id = ? AND version_number = ? AND required = 1 AND status != 'approved'
`).bind(contractId, currentVersion).first<{ count: number }>();

if (pendingRequired.count > 0) {
  return Response.json(
    { error: "Cannot execute or lock contract: required version approvals are pending or have requested edits." },
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
| `POST /api/owner/contracts/[contractId]/approvals/[id]/reassign` | ✅ | ❌ (403) | ❌ (403) | ❌ (403) |
| `POST /api/owner/contracts/[contractId]/approvals/[id]/revoke` | ✅ | ❌ (403) | ❌ (403) | ❌ (403) |
| `POST /api/approver/invite/consume` | ❌ (401) | ✅ (valid token) | ❌ (401) | ❌ (401) |
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
    "assignmentId": "app-assign-123",
    "delegatedApproverId": "del-app-456",
    "kind": "legal",
    "versionNumber": 2,
    "inviteUrl": "http://localhost:4319/approve/invite?token=a8f9c2d1...",
    "expiresAt": "2026-08-22T14:50:00Z"
  }
  ```

#### 2. Consume One-Time Invite Link (POST)
- **`POST /api/approver/invite/consume`**
- **Auth**: None (Token in Body)
- **Request Body**:
  ```json
  {
    "token": "a8f9c2d1..."
  }
  ```
- **Behavior**:
  1. Computes `hash = sha256Hex(token)`.
  2. Query `approval_invites` where `token_hash = hash AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW`.
  3. Updates `used_at = CURRENT_TIMESTAMP`.
  4. Creates `approver_sessions` row with fresh token hash, `expiresAt` (8h max), `lastActiveAt` (NOW).
  5. Sets `__Host-Pactline-Approver-Session` cookie.
  6. Returns `{ "success": true, "contractId": "sample-contract" }`.

#### 3. Submit Decision (`approved` or `edits_requested`)
- **`POST /api/approver/contracts/[contractId]/decide`**
- **Auth**: Delegated Approver Session Cookie
- **Request Body**:
  ```json
  {
    "assignmentId": "app-assign-123",
    "decision": "approved", // or "edits_requested"
    "decisionReason": "Legal terms compliant with 2026 corporate policy."
  }
  ```
- **Validation**: `decisionReason` is **mandatory** (minimum 5 characters) for both decisions. `rejected` is excluded from Phase 3 scope.
- **Response (200 OK)**:
  ```json
  {
    "success": true,
    "assignmentId": "app-assign-123",
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
│ │ │ Legal    │ Sarah Jenkins   │ ✓ Approved   │ Reason...    │ [Reassign]          │ │ │
│ │ │ Finance  │ Marcus Vance    │ ⏳ Pending    │ Invite Sent  │ [Copy Link] [Revoke]│ │ │
│ │ │ Security │ Elena Rostova   │ ⚠ Edits Req  │ Reason...    │ [Request Re-appr]   │ │ │
│ │ └──────────┴─────────────────┴──────────────┴──────────────┴─────────────────────┘ │ │
│ │ [+ Assign Delegated Approver]                                                      │ │
│ └────────────────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────────────────┐
│ DELEGATED APPROVER LANDING PAGE: /approve/invite?token=...                             │
│ Header: Referrer-Policy: no-referrer                                                   │
│ ┌────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ PACTLINE APPROVAL INVITATION                                                       │ │
│ │ You have been invited to review and approve: Services Agreement (v2)               │ │
│ │ Role: LEGAL COUNSEL | Assigned to: Sarah Jenkins                                   │ │
│ │ Invite Expires: 2026-08-22 14:50 UTC                                               │ │
│ │                                                                                    │ │
│ │ [ Form Submit POST /api/approver/invite/consume: "Accept & Access Portal" ]        │ │
│ └────────────────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────────────────┐
│ DELEGATED APPROVER DECISION PORTAL: /approve/[contractId]                              │
│ ┌────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ PACTLINE APPROVAL PORTAL                       Signed in as: Sarah Jenkins (Legal) │ │
│ ├────────────────────────────────────────────────────────────────────────────────────┤ │
│ │ Contract: Services Agreement (v2)              Approval Required: LEGAL REVIEW      │ │
│ │ ┌────────────────────────────────────────────────────────────────────────────────┐ │ │
│ │ │ CONTRACT READ-ONLY TEXT SNAPSHOT (Version 2)                                   │ │ │
│ │ │ 1. Scope of Work...                                                          │ │ │
│ │ │ 2. Indemnification & Liability...                                            │ │ │
│ │ └────────────────────────────────────────────────────────────────────────────────┘ │ │
│ │ DECISION REASON (Mandatory, min 5 chars):                                          │ │
│ │ [ Textarea: Enter formal approval or requested edit rationale...                ] │ │
│ │                                                                                    │ │
│ │ [ ✓ Approve Contract Version 2 ]       [ ⚠ Request Edits ]                         │ │
│ └────────────────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 7. Audit-Log & Telemetry Events

All Phase 3 approval actions generate structured audit log entries in `audit_log_entries`:

| Event Action | Trigger | Metadata Captured |
| :--- | :--- | :--- |
| `delegated_approver.assigned` | Owner assigns an approver to contract | `kind`, `delegatedApproverId`, `email`, `versionNumber` |
| `approval_invite.created` | Invite token generated | `assignmentId`, `expiresAt`, `inviteId` (no token!) |
| `approval_invite.consumed` | Approver clicks Accept on landing page | `assignmentId`, `delegatedApproverId` |
| `approval_invite.revoked` | Owner revokes invite link | `assignmentId`, `inviteId` |
| `approval_assignment.reassigned` | Owner reassigns approver | `oldAssignmentId`, `newAssignmentId`, `newApproverId` |
| `approval_decision.recorded` | Approver submits decision | `versionNumber`, `kind`, `decision`, `decisionReason` |

---

## 8. Rollout Strategy & Backward Compatibility

1. **Table Preservation & Schema Safety**:
   - `approval_requests` (`approver_id NOT NULL`) remains completely untouched.
   - New delegated assignments utilize `approval_assignments` linked to `delegated_approvers` (`organization_id NOT NULL`).
2. **Forward-Only Migrations**:
   - Applied cleanly via Drizzle migration runner (`0013_delegated_approvals.sql`).
   - Additive tables guarantee zero disruption to existing Phase 1/2 workflow records.

---

## 9. Verification & Test Plan

### 1. Direct API Authorization & Security Tests
- `POST /api/owner/contracts/[contractId]/approvers` with invalid/missing owner session returns `401 Unauthorized`.
- Reviewer or Supplier session attempting owner assignment routes returns `403 Forbidden`.
- `GET /approve/invite?token=...` renders landing page without consuming token or setting cookies.
- Consuming an expired (over 24 hours) or already-used invite token via `POST /api/approver/invite/consume` returns `410 Gone` / `401 Unauthorized`.
- Submitting a decision without `decisionReason` or under 5 characters returns `400 Bad Request`.
- Approver with inactive session (>30 min) returns `401 Unauthorized`.

### 2. E2E Playwright Isolation Tests
- **Full Lifecycle E2E**:
  1. Owner assigns Delegated Legal Approver.
  2. Owner copies local-stub invite link.
  3. Delegated Approver opens landing page, clicks "Accept & Access", and lands on `/approve/[contractId]`.
  4. Approver submits `edits_requested` with mandatory rationale.
  5. Contract status remains blocked from `locked`/`agreed` (409 Conflict).
  6. Owner updates paragraph (incrementing version to `v2`). Prior version `v1` assignment remains `edits_requested` in history; new `v2` assignment instantiates in `pending` state.
  7. Delegated Approver reviews `v2` snapshot and submits `approved` with reason.
  8. All required version 2 assignments are `approved`; server unlocks `locked` transition.

---

## 10. Summary of Revisions Incorporated in Design

1. **Invite & Session Expiry**: Invite tokens expire in **24 hours**. Approver session cookies expire in **8 hours max** with a **30-minute inactivity sliding timeout**.
2. **Mandatory Rationale**: Minimum 5 characters required for both `approved` and `edits_requested`. `rejected` is excluded from Phase 3 scope.
3. **Immutable Version History**: Prior version approval assignment records are preserved as immutable history (`version_number = N`). Fresh assignment rows are created for new versions (`version_number = N+1`).
4. **Preserved Schema Safety**: `approval_requests.approver_id` remains `NOT NULL`. New `approval_assignments` table introduced for delegated approvers.
5. **Organization-Scoped Approvers**: `delegated_approvers` includes `organization_id NOT NULL` with unique constraint on `(organization_id, email)`.
6. **Two-Step GET/POST Invite Consumption**: GET renders landing page with `Referrer-Policy: no-referrer`. Consumption occurs via explicit `POST /api/approver/invite/consume`.
7. **Reassignment History**: Reassignment supersedes/revokes the old assignment row and creates a new assignment row.
8. **Scoped Decision Enum**: Decision options strictly limited to `approved` and `edits_requested`.
