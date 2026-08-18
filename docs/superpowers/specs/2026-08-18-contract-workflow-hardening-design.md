# Contract Workflow Hardening — Design Spec

Date: 2026-08-18
Repo: `pactline-contract-collaboration`
Base branch for implementation: `codex/version-two-expansion` (strict superset of `main`, contains the v2 org/portal/vault model that several items depend on)

## Background

This spec covers a 10-item handoff list for hardening the Pactline contract-collaboration app (Next.js 16 / React 19 / Cloudflare Workers / D1 via Drizzle). Delivery is split into three phases per product direction:

- **Phase 1** (this implementation pass): items 1, 2, 4, 8, 9 — workflow reliability, threaded comments, lifecycle enforcement, redline upgrade, automated verification.
- **Phase 2** (future, spec'd here at design level only, not implemented now): items 5, 6, 7, 10 — notification queue, monitoring coverage, amendment-chain UI, release dashboard.
- **Phase 3** (future, spec'd here at design level only, not implemented now): item 3 — multi-person delegated approvals. Isolated because it changes the auth/authorization model; reviewed only after Phase 1 is stable.

Hard rule carried through every phase: **queued or logged notifications are never represented as "sent" in UI or docs.** No real email provider credentials exist in this repo; item 5's pipeline will be provider-neutral with a logging/storage stub as the default implementation, clearly labeled as such everywhere it's surfaced.

---

## Phase 1 — detailed design

### 1. Real end-to-end tests

**Approach**: introduce Playwright (`@playwright/test` devDependency). New files: `playwright.config.ts`, `tests/e2e/fixtures.ts`, `tests/e2e/happy-path.spec.ts`, `tests/e2e/failure-cases.spec.ts`. New script `"test:e2e": "playwright test"` — kept separate from `npm test` (which stays the fast `node:test` suite with no browser dependency) rather than folded in, so the existing fast suite isn't slowed down or made to require a browser install; both are documented as required checks before merge.

**Server + auth for tests**: `playwright.config.ts` `webServer` runs `npm run dev` (vinext dev) and waits on its URL. Owner auth needs no login step in this mode — `app/chatgpt-auth.ts` auto-resolves a fixed local owner identity when the host is `localhost`/`127.0.0.1`. Reviewer auth uses the seeded `access_accounts` credential (`client.reviewer` / `ReviewDemo!2026`) created by `lib/demo.ts:ensureDemoWorkspace`, logged in via the existing client login route.

**Reset/seed step**: `tests/e2e/fixtures.ts` exposes a `resetDemo()` helper that calls the existing `POST /api/demo/reset` (already idempotent, scoped to `DEMO_CONTRACT_ID = "sample-services-agreement"`) before each spec file's tests run. Because reset mutates shared D1 state for a single well-known contract, the e2e project runs with `fullyParallel: false` / a single worker to avoid cross-file races — this is a deliberate trade-off (slower, but deterministic) rather than an oversight.

**Happy path** (`happy-path.spec.ts`), following the contract's actual state machine in order:
1. Reset demo.
2. Owner opens `/workflow/sample-services-agreement`, confirms an open review round (opens one if the seed didn't leave one open).
3. Owner adds a paragraph comment.
4. Reviewer logs in at `/review/sample-services-agreement`, proposes a paragraph change.
5. Owner counters the proposal (`paragraph-proposals/[id]/resolve`, action `counter`).
6. Owner requires and then approves an internal approval (`approvals` route, actions `require` then `decide`).
7. Owner and reviewer each record agreement (`agree` routes) until `contracts.status` flips to `locked` — this is how "lock" actually happens today; it is a side effect of mutual agreement, not a direct lifecycle-stage write.
8. Owner creates an amendment (`amendments` route, requires `status==='locked'`).
9. Owner exports the `.ics` calendar and the test asserts `content-type: text/calendar` and a well-formed `VCALENDAR` body.

**Failure cases in the e2e layer are deliberately minimal** — two high-value, UI-observable cases (an invalid lifecycle transition surfaces an error in the workflow UI; a reviewer session hitting an owner-only page/API is rejected). The full status-code matrix (401/403/404/409 across every boundary) is covered far more cheaply and thoroughly by item 9's API-level tests — duplicating that matrix through a browser would make the suite slow without adding confidence.

### 2. Comment threading

**Schema change** (new Drizzle migration, generated via `npm run db:generate`):
- `ALTER TABLE paragraph_comments ADD COLUMN resolution_reason text` (nullable — required only at the API layer for new resolutions; existing resolved rows keep `NULL`, no backfill).
- `ALTER TABLE paragraph_comments ADD COLUMN reopened_by text`, `ALTER TABLE paragraph_comments ADD COLUMN reopened_at text` (nullable, mirrors the existing `resolved_by`/`resolved_at` pattern).
- `CREATE INDEX idx_paragraph_comments_parent ON paragraph_comments (parent_comment_id)`.
- **No FK constraint added on `parent_comment_id`.** D1/SQLite can't add a foreign key to an existing table via `ALTER TABLE` without a full table rebuild (copy/drop/rename), which is a riskier migration than this feature needs. Referential integrity is instead enforced in the API layer (parent must exist, belong to the same `contract_id` and `block_id`) — consistent with how this codebase already validates relations elsewhere (e.g. `block_id` existence checks in the comments routes).

**Rollback**: all four changes are additive and nullable/non-unique. A revert migration would be `DROP INDEX idx_paragraph_comments_parent; ALTER TABLE paragraph_comments DROP COLUMN resolution_reason; ALTER TABLE paragraph_comments DROP COLUMN reopened_by; ALTER TABLE paragraph_comments DROP COLUMN reopened_at;` — safe because nothing else reads these columns and no data migration occurred.

**API changes**:
- `app/api/contracts/[contractId]/comments/route.ts` (owner): add `action: "reply"` (same insert path as `add`, but requires `parentCommentId` and validates the parent belongs to the same contract+block); `action: "resolve"` now requires `reason` (3–500 chars) and stores it in `resolution_reason`; new `action: "reopen"` (owner-only) clears `resolved_by`/`resolved_at`/`resolution_reason`, sets `reopened_by`/`reopened_at`, status back to `open`.
- `app/api/client/contracts/[contractId]/comments/route.ts` and `app/api/portal/contracts/[contractId]/comments/route.ts`: already accept `parentCommentId` on insert — add the same parent-validation (reject a `parentCommentId` from a different contract/block with 400); they gain no resolve/reopen capability (stays owner-only, matching the acceptance criterion "the owner can resolve it").

**UI**: nested rendering (reply indentation, resolve/reopen controls with a reason prompt) in `app/workflow/[contractId]/page.tsx` and `app/review/[contractId]/page.tsx`, replacing the current flat `.map()` lists. The supplier portal page's comment rendering will be checked and updated the same way if it duplicates this logic rather than sharing it.

### 4. Lifecycle transition rules

**Transition graph**, added as `LIFECYCLE_TRANSITIONS: Record<Stage, Stage[]>` in `lib/workflow.ts` next to the existing `LIFECYCLE_STAGES`:

```
draft            -> internal_review
internal_review  -> external_review, draft
external_review  -> approved, internal_review
approved         -> executed, external_review
executed         -> renewed, expired
expired          -> renewed
renewed          -> internal_review
```

Rationale: forward progression follows the stated `Draft → Internal Review → External Review → Approved → Executed` chain; each stage may step back exactly one stage (revision loop) rather than jumping arbitrarily; `executed` can only lead to the two stated exceptions (`expired`, `renewed`); a `renewed` contract re-enters the review cycle at `internal_review` rather than skipping straight to `approved`. Setting `lifecycleStage` to its current value (no-op, used when only other metadata like risk or renewal date changes) is always allowed.

**Guards** enforced server-side in `PATCH app/api/contracts/[contractId]/lifecycle/route.ts` (currently only checks enum membership plus the existing `executed` ⇒ `status==='locked'` rule, which is kept):
- The requested transition must be `current === next` or present in `LIFECYCLE_TRANSITIONS[current]` — otherwise `400 { error: "Invalid lifecycle transition from <current> to <next>" }`.
- Moving **to** `approved` additionally requires zero pending `paragraph_proposals` and zero `required=1` `approval_requests` at `current_version` with `status != 'approved'` (same predicate already used in `lib/agreements.ts`) — otherwise `409`.
- Moving **to** `executed` keeps the existing `status==='locked'` requirement (`409` if not locked) — locking itself is a side effect of mutual agreement (`lib/agreements.ts`), so this is already equivalent to "a final agreement exists," just phrased as a status check rather than a duplicate `agreements` query.

This makes the API — not just the UI — reject invalid jumps, which is the explicit acceptance criterion.

### 8. Redline / full-document diff upgrade

No changes to `lib/text-diff.ts`'s diff algorithm; `compareVersions()` in `lib/workflow.ts` already returns per-block `{ key, changed, diff, orderIndex }` plus version numbers/timestamps, which is enough to build the new UI on top of.

- **View mode toggle** (Unified / Side-by-side) as local UI state in the `redline-card` section of `app/workflow/[contractId]/page.tsx`. Unified keeps the current inline `<del>`/`<ins>` rendering. Side-by-side renders two columns (original | proposed) per paragraph, row-aligned by block key.
- **Version/date/author metadata**: header per compared version showing version number, `created_at`, and author — joining `contract_versions.created_by` to `users.display_name`. (`created_by` semantics — currently always an owner-side action per the workspace routes — will be confirmed against the actual insert sites during implementation, since if it later needs to represent a reviewer-triggered version, the author line should degrade to whatever id is present rather than crash.)
- **"Jump to change"**: a change list (block key + short excerpt) rendered above the diff; each entry is an in-page anchor (`#block-<key>`) to the corresponding paragraph, which gets a matching `id` attribute added to its rendered container.

### 9. Automated edge-case coverage

New `tests/edge-cases.test.ts` (Node's `node:test`, run via the existing `node --experimental-strip-types --test` invocation alongside `security.test.ts`/`docx.test.ts`/`ai-scope.test.ts`/`text-diff.test.ts`). Each case asserts an exact status code:

| # | Case | Mechanism under test | Expected |
|---|---|---|---|
| 1 | Reviewer (client) cookie on an owner-only route | `hasClientSessionCookie` short-circuit in `lib/owner-boundary.ts` | 403 |
| 2 | No/garbage owner cookie, non-localhost | `getChatGPTUser()` fallback path in `lib/owner-auth.ts` | 401 |
| 3 | Expired `access_sessions` token | `expires_at`/`session_expires_at` check in `lib/client-auth.ts:getClientSession` | 401 |
| 4 | Revoked/inactive `contract_access_grants` | `portalGrant()` status check in `lib/portal-auth.ts` | 403 |
| 5 | Cross-org isolation: portal account of org A against a contract only granted to org B | `portalGrant()` returns null | 403/404 (whichever the current handler already returns — test locks in existing behavior, doesn't change it) |
| 6 | Malformed upload (bad content-type / truncated body) at the upload route layer | request-parsing in the document upload route, distinct from `docx.test.ts`'s parser-level coverage | 400 |
| 7 | Download of a `document_objects` row whose R2 key is missing from the bucket | download route's R2 `get()` miss handling | 404 (not 500) |
| 8 | Concurrent paragraph-proposal resolution racing on the same version, driven through the HTTP route (not just the lower-level `mutationGuard` unit test already in `database.test.mjs`) | `lib/mutations.ts` guard via the `paragraph-proposals/[id]/resolve` route | 409 |
| 9 | Mutation attempt (new comment reply target validation aside, e.g. a paragraph proposal) against a `status='locked'` contract | route-level lock check | 409/403 (locked in to whatever the current handler does — test documents existing behavior) |

Cases 5 and 9 intentionally test *existing* behavior rather than asserting a new contract, since Phase 1 doesn't change authorization semantics there — the point is coverage, not new rules. If implementation reveals either currently returns an unexpected code (e.g. 500 on a code path with no explicit check), that's a bug to fix as part of this phase, not a rule to design around.

---

## API / permission matrix (Phase 1 scope)

| Action | Owner | Reviewer (legacy client) | Supplier (portal v2) | Approver (Phase 3, N/A here) |
|---|---|---|---|---|
| View comments | ✅ own contracts | ✅ if `permission ∈ {view,comment,propose_changes}` | ✅ if grant `permission ∈ {view,comment,propose_changes}` and grant active | — |
| Add top-level comment | ✅ | ✅ if `permission ∈ {comment,propose_changes}` | ✅ if grant `permission ∈ {comment,propose_changes}` | — |
| Reply to comment | ✅ | ✅ (same gate as add) | ✅ (same gate as add) | — |
| Resolve comment (+ reason) | ✅ only | ❌ 403 | ❌ 403 | — |
| Reopen comment | ✅ only | ❌ 403 | ❌ 403 | — |
| `PATCH` lifecycle | ✅ only | ❌ 403 (owner-boundary) | ❌ 403 | — |
| `GET` calendar (`.ics`) | ✅ own contracts only (route is `requireOwnerApi`-gated today; unchanged) | ❌ not exposed | ❌ not exposed | — |
| `GET` version compare (redline) | ✅ | out of Phase 1 scope (owner-console-only feature today; unchanged) | out of scope | — |
| Propose a change | via workflow UI, not a raw owner API | ✅ if `permission==='propose_changes'` | ✅ if grant `permission==='propose_changes'` | — |
| Counter / accept / reject a proposal | ✅ only | ❌ | ❌ | — |
| Record agreement | ✅ (initiator party) | ✅ (counterparty party, if the session's `partyId` matches) | ✅ (counterparty, via portal agree route) | — |

---

## Regression guardrails — existing behavior that must not change

1. Owner API boundary rejects reviewer sessions (`tests/rendered-html.test.mjs`) — unmodified assertion, must keep passing.
2. Approvals remain version-scoped (`tests/database.test.mjs`).
3. Controlled amendments preserve the locked source contract (`tests/database.test.mjs`) — item 4's new transition guards must not interfere with amendment creation, which already independently requires `status==='locked'`.
4. `mutationGuard` continues to abort stale writes exactly as today — item 9 adds route-level coverage but does not change `lib/mutations.ts` semantics.
5. The existing `executed` ⇒ `status==='locked'` rule in the lifecycle route is preserved, just now combined with the new adjacency check rather than replaced.
6. Demo reset (`POST /api/demo/reset`) remains idempotent and requires no manual DB intervention after the new migration lands — verified by running it post-migration.
7. `.ics` export format/content-type is unchanged for all existing reminder kinds (`calendarText()` untouched).
8. The full existing `npm test` suite (`rendered-html`, `database`, `version-two`, `security`, `docx`, `ai-scope`, `text-diff`) continues to pass unmodified, except where the new migration requires `database.test.mjs`'s "migrations apply cleanly" assertion to include the new migration file — that's an expected, additive update, not a behavior change.
9. Reviewer/supplier top-level comment insertion (`parentCommentId: null`) keeps working exactly as before — new parent validation only rejects a `parentCommentId` pointing at a different contract or block.
10. AI assistant / paragraph-proposal flows are untouched by the comment-threading and lifecycle changes (no shared code paths modified).

---

## Phase 2 — design-level only (not implemented in this pass)

- **5. Notifications**: `lib/notifications.ts` provider-neutral interface (`send(notification): Promise<DeliveryResult>`), new `notification_deliveries` queue table (kind, recipient, template, payload, status, attempts, next_attempt_at, last_error) and `notification_preferences` (unsubscribe). Default provider implementation logs to `notification_deliveries` and console only — **never** described as "sent" anywhere in UI/docs; swapping in a real provider (Resend/SendGrid/etc.) is a one-file change behind the same interface. `worker/index.ts`'s existing (currently opt-in) `scheduled()` cron is extended to sweep due `reminder_schedules`, enqueue, and drain the queue with retry/backoff.
- **6. Monitoring coverage**: `withMonitoring(handler, route)` wrapper applied to the ~38 currently-unwrapped route files; per-request `request_id` generation, echoed in error responses; optional `MONITORING_ALERT_WEBHOOK_URL` for critical severity, no-op if unset.
- **7. Amendment chain UI**: chain-walk helper over `contract_relationships` (already models `amends`/`renews`/`supersedes`), rendered as a full "Amends ← this → Amended by" chain with effective date and a computed "current governing version" badge.
- **10. Release dashboard**: owner-only `app/release/page.tsx` + API surfacing environment, migration count vs. applied, an R2 reachability probe, Vectorize binding presence, last-cron-run timestamp (new status row updated by `worker/index.ts`), and build version/commit.

## Phase 3 — design-level only (not implemented in this pass)

- **3. Multi-person approvals**: new `approvers` (contract-scoped identity) and `approval_assignees` tables; magic-link token auth (`approver_sessions`, cookie `__Host-pactline_approver`) so each approver authenticates as themselves rather than sharing owner credentials; `approval_requests` becomes assignment-driven so the owner can view all approvals on a contract but can only *decide* their own. Notifications for assignment reuse Phase 2's queue. This is deliberately deferred until Phase 1 is reviewed and stable, since it's the one item that changes the authentication/authorization model rather than extending existing routes.
