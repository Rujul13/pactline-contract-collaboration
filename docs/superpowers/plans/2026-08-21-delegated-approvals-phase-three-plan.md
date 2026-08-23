# Phase 3 Delegated Approvals — Implementation Plan

This document outlines the planned rollout sequence for implementing Phase 3 (Delegated, Multi-Person Approvals).

> [!NOTE]
> This is a design/specification document. No application code, database migrations, or test files are implemented as part of this turn.

---

## 1. Rollout Sequence & Task Breakdown

```mermaid
graph TD
    T1[Task 1: Additive Schema & Drizzle Migrations] --> T2[Task 2: Token Hashing & Session Utilities]
    T2 --> T3[Task 3: Owner Assignment & Invite API Routes]
    T3 --> T4[Task 4: Two-Step Invite Landing & POST Consumption]
    T4 --> T5[Task 5: Approver Decision API & Gate Enforcement]
    T5 --> T6[Task 6: Owner Workflow Approval Matrix UI]
    T6 --> T7[Task 7: Dedicated Approver Portal UI]
    T7 --> T8[Task 8: Audit Logging & Telemetry Events]
    T8 --> T9[Task 9: Authorization & E2E Playwright Isolation Tests]
```

### Task 1: Additive Schema & Drizzle Migrations
- **Schema Additions (`db/schema.ts`)**: Add `delegatedApprovers` (organization-scoped), `approvalAssignments` (version-scoped), `approvalInvites` (24h TTL), and `approverSessions` (8h max / 30m sliding timeout). Keep `approval_requests` (`approver_id NOT NULL`) completely untouched.
- **Migration Generation**: Run `npm run db:generate` to produce forward-only SQL migration `0013_delegated_approvals.sql`.
- **Database Test Suite**: Update `tests/database.test.mjs` to assert the presence of new tables, foreign keys, and indexes.

### Task 2: Token Hashing & Session Utilities
- **Utility Module (`lib/approver-auth.ts`)**:
  - Implement 256-bit cryptographically secure token generation (`crypto.getRandomValues`).
  - Implement token hashing using `sha256Hex`.
  - Implement session creation and validation routines (checking 8-hour max TTL and 30-minute inactivity sliding timeout).
  - Implement cookie helper for `__Host-Pactline-Approver-Session` (HttpOnly, `SameSite=Strict`, `Path=/`).

### Task 3: Owner Assignment & Invite API Routes
- **Endpoints**:
  - `POST /api/owner/contracts/[contractId]/approvers`: Assign organization-scoped delegated approvers (`approval_assignments`).
  - `GET /api/owner/contracts/[contractId]/approvals`: Fetch approval matrix for owner.
  - `POST /api/owner/contracts/[contractId]/approvals/[id]/invite`: Generate fresh 24h invite token/URL.
  - `POST /api/owner/contracts/[contractId]/approvals/[id]/reassign`: Mark old assignment `superseded`/`revoked` and create new assignment.
  - `POST /api/owner/contracts/[contractId]/approvals/[id]/revoke`: Revoke active invite or assignment.

### Task 4: Two-Step Invite Landing & POST Consumption
- **Landing Page & Consumption**:
  - `GET /approve/invite?token=...`: Render landing page with `Referrer-Policy: no-referrer`. Do NOT consume token or set cookies on GET.
  - `POST /api/approver/invite/consume`: Validate token hash, mark `used_at`, issue session cookie (`__Host-Pactline-Approver-Session`), and return redirect URL.
  - `GET /api/approver/session`: Verify active session cookie and enforce 30-minute sliding inactivity timeout.
  - `POST /api/approver/logout`: Revoke session in DB and clear cookie.

### Task 5: Approver Decision API & Gate Enforcement
- **Endpoints**:
  - `GET /api/approver/contracts/[contractId]`: Fetch read-only version snapshot for assigned approver.
  - `POST /api/approver/contracts/[contractId]/decide`: Submit `approved` or `edits_requested` with mandatory rationale (`decisionReason`, min 5 chars).
- **Server Gate**:
  - Update agreement, locking, and execution endpoints (`/api/contracts/[contractId]/agree`, `/api/contracts/[contractId]/lifecycle`) to block when any active version-scoped required assignment is not `approved` (returns `409 Conflict`).

### Task 6: Owner Workflow Approval Matrix UI
- **UI Modifications (`app/workflow/[contractId]/page.tsx`)**:
  - Add "Delegated Approval Matrix" card displaying legal, finance, security, and business approval statuses.
  - Add "Assign Approver" modal.
  - Add "Copy Invite Link" action (copies local-stub URL `http://localhost:4319/approve/invite?token=...`).
  - Add "Reassign" and "Request Re-approval" buttons.

### Task 7: Dedicated Approver Portal UI
- **New Page (`app/approve/[contractId]/page.tsx`)**:
  - Isolated minimal decision interface.
  - Renders contract version snapshot, approval assignment metadata, and mandatory rationale textarea.
  - Renders decision buttons ("Approve", "Request Edits").
  - Stripped of all owner, reviewer, and supplier navigation or management controls.

### Task 8: Audit Logging & Telemetry Events
- Add structured audit logging in `audit_log_entries` for assignment, invite creation/consumption/revocation, reassignment, decision recording, and re-approval requests.

### Task 9: Authorization & E2E Playwright Isolation Tests
- **API Security Spec (`tests/e2e/api/edge-cases.spec.ts`)**: Add tests for 401 unauthenticated, 403 cross-role access, 410 expired invite consumption, 400 missing rationale (<5 chars), and 30-min session timeout.
- **E2E Integration Spec (`tests/e2e/operations.spec.ts`)**: Full flow from owner assignment to landing page view, POST consumption, decision submission, version increment, re-approval, and server gate verification.
