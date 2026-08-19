# Contract Workflow Hardening — Design Spec

Date: 2026-08-18 (revised after first review round)
Repo: `pactline-contract-collaboration`
Base branch for implementation: `codex/version-two-expansion` (strict superset of `main`, contains the v2 org/portal/vault model that several items depend on)

## Background

This spec covers a 10-item handoff list for hardening the Pactline contract-collaboration app (Next.js 16 / React 19 / Cloudflare Workers / D1 via Drizzle). Delivery is split into three phases per product direction:

- **Phase 1** (this implementation pass): items 1, 2, 4, 8, 9 — workflow reliability, threaded comments, lifecycle enforcement, redline upgrade, automated verification.
- **Phase 2** (future, spec'd here at design level only, not implemented now): items 5, 6, 7, 10 — notification queue, monitoring coverage, amendment-chain UI, release dashboard.
- **Phase 3** (future, spec'd here at design level only, not implemented now): item 3 — multi-person delegated approvals. Isolated because it changes the auth/authorization model; reviewed only after Phase 1 is stable.

Hard rule carried through every phase: **queued or logged notifications are never represented as "sent" in UI or docs.** No real email provider credentials exist in this repo; item 5's pipeline will be provider-neutral with a logging/storage stub as the default implementation, clearly labeled as such everywhere it's surfaced.

### Revision note (this pass)

The first draft of this spec was reviewed and returned with nine required refinements, all incorporated below: explicit test-environment isolation, a full lifecycle success path with a post-lock backward-move ban, a committed authorization status-code contract (no "whichever happens today"), a Workers-capable runner for API-level edge cases, a precise thread-resolution model, no promise of reversible schema rollback, UI-driven (not API-driven) e2e steps, redline anchor/version-picker/author-fallback details, and additional thread-specific edge cases. Where implementing a refinement required verifying something concrete in the codebase (e.g. how local D1/R2 persistence actually works), that verification was done before writing the design below — nothing here is a placeholder.

---

## Phase 1 — detailed design

### 1. Real end-to-end tests

**Approach**: introduce Playwright (`@playwright/test` devDependency). New files: `playwright.config.ts`, `tests/e2e/fixtures.ts`, `tests/e2e/happy-path.spec.ts`, `tests/e2e/lifecycle-failures.spec.ts`, `tests/e2e/api/edge-cases.spec.ts` (see item 9 — these ride in the same Playwright run). New script `"test:e2e": "playwright test"` — kept separate from `npm test` (the existing fast `node:test` suite, unmodified) rather than folded in, so the existing suite stays fast and browser-independent; both are documented as required checks before merge. This single command satisfies item 1's "a single command validates the complete happy path and key failure cases" acceptance criterion, and item 9's edge cases ride along in it too since they need the same environment (see below).

**Test-environment isolation (refinement 1)**. Verified in `vite.config.ts`: the `@cloudflare/vite-plugin`'s `cloudflare({...})` call currently passes no `persistState` option, so Miniflare's local D1/R2 persistence defaults to `<repo root>/.wrangler/state/v3` — the same directory a developer's ordinary `npm run dev` session uses. There is no remote-binding configuration anywhere in this file (no `experimental.remoteBindings`, no account/API-token wiring) — local bindings are structurally the only option today, so "never staging or production" already holds by construction. What's missing is isolation from a developer's *own* local dev state, which this spec closes explicitly:
- `vite.config.ts` gains: `persistState: process.env.PACTLINE_E2E === "true" ? { path: ".wrangler/state-e2e" } : true`.
- `playwright.config.ts`'s `webServer.env` sets `PACTLINE_E2E: "true"` (plus a dedicated port), so every e2e run gets its own on-disk Miniflare state directory, never touching `.wrangler/state/v3` or any real Cloudflare account.
- `.wrangler/state-e2e/` is added to `.gitignore` alongside the existing `.wrangler/` ignore.
- `playwright.config.ts` sets **`workers: 1` explicitly** (not just `fullyParallel: false` — the user's point that the latter alone doesn't guarantee single-process execution is correct; `workers: 1` is what actually pins Playwright to one worker process, which matters because all specs mutate the same shared local D1 state via the single well-known demo contract).

**Reset/seed step**: `tests/e2e/fixtures.ts` exposes a `resetDemo()` helper that calls the existing `POST /api/demo/reset` (already idempotent, scoped to `DEMO_CONTRACT_ID = "sample-services-agreement"`) before each spec file's tests run. This is one of the two allowed non-UI steps (see refinement 7 below).

**Happy path** (`happy-path.spec.ts`), **driven through the actual UI** (refinement 7) — every step below is a real Playwright `page` interaction (click/fill/select), not a direct `request.post()` to the API, except step 1 (reset, explicitly a setup step) and the calendar assertion in step 10 (the response body is validated directly after triggering it via a UI click, since ".ics content" isn't something you can assert by looking at the page):

1. Reset demo via API call (setup, not a UI action).
2. Owner opens `/workflow/sample-services-agreement` in the browser (owner auth is automatic on `localhost` per `app/chatgpt-auth.ts`, so no login UI to drive here).
3. Owner clicks "Open round" (or confirms the seeded round is already open) in the review-rounds card.
4. Owner fills the comment box and clicks "Add comment".
5. In a second browser context, reviewer fills the login form at `/review/sample-services-agreement` with the seeded `client.reviewer` / `ReviewDemo!2026` credential, then edits a paragraph and clicks "Propose change".
6. Owner clicks "Counter" on the pending proposal and submits counter text.
7. Owner clicks "Require approval", selects a kind, then clicks "Approve" and enters a decision reason.
8. Owner clicks "Agree" (initiator agreement); reviewer clicks "Agree" (counterparty agreement) — this is how "lock" actually happens (`contracts.status` flips to `locked` as a side effect of both parties agreeing, per `lib/agreements.ts`; there is no direct "lock" button). The test asserts the UI reflects the locked state after both clicks.
9. Owner transitions the lifecycle stage forward through the UI (`external_review → approved` once the pending-proposal/approval guards are satisfied, then `approved → executed` now that `status==='locked'`) using the lifecycle form's stage selector and "Save" button — exercising the new server-side transition guards from item 4 through real UI submission, not just the API.
10. Owner clicks "Create amendment" (enabled because the contract is now `locked`).
11. Owner clicks "Export calendar"; the test captures the resulting response (via Playwright's `page.waitForResponse` on the click) and asserts `content-type: text/calendar` and a well-formed `VCALENDAR` body — the one place a raw response is inspected directly rather than page content, per the allowed exception.

**Lifecycle failure cases** (`lifecycle-failures.spec.ts`, refinement 2): a second UI-driven spec confirms invalid transitions are rejected both in the UI and (via the same click, since the UI calls the real API) at the API:
- Attempting `draft → approved` (skipping stages) from the lifecycle form shows the server's rejection message and does not change the stage.
- Attempting `external_review → approved` while a required approval is still pending is rejected with a clear message.
- **Once locked, backward stage moves are rejected**: after the happy path locks the contract, attempting to move the lifecycle stage backward (e.g. `approved → external_review`) is rejected even though that edge exists in the graph for *pre-lock* revision — see item 4's updated design for the exact rule. Only forward completion (`→ executed`) and the terminal `expired`/`renewal` exceptions remain reachable post-lock.
- A reviewer session driving the browser to an owner-only page/API (e.g. attempting to open the lifecycle form directly) is rejected per the authorization contract in the new "Authorization status-code contract" section below.

### 2. Comment threading

**Thread model (refinement 5) — stated precisely, not left implicit**:
- Threads are exactly **two levels deep**: one root comment (`parent_comment_id IS NULL`) plus a flat list of replies under it (`parent_comment_id = root.id`). A reply's `parentCommentId` must reference a *root* comment — replying to a reply is rejected (400), keeping the model simple and matching the acceptance criterion's "reply to a paragraph comment" (singular level).
- **Resolving is thread-level, not row-level.** Only a root comment can be targeted by `action: "resolve"`; resolving cascades `status='resolved'` to the root and all its direct replies in one statement. `resolution_reason` is required (3–500 chars) and stored on the root row; reply rows get `status='resolved'` but no independent reason (the thread has one reason).
- **No new replies on a resolved thread.** The reply path checks the target root's `status`; if `resolved`, the request is rejected with `409` (a state-conflict, not a malformed request — consistent with how this codebase already uses 409 for "the document changed" conditions).
- **Reopening reopens the whole thread.** `action: "reopen"` targets a root comment, requires it to currently be `resolved`, and cascades `status='open'` back to the root and all its replies, clearing `resolved_by`/`resolved_at`/`resolution_reason` and setting `reopened_by`/`reopened_at` on the root. Reopen is owner-only (same authority as resolve, per the acceptance criterion "the owner can resolve it").

**Schema change** (new Drizzle migration, generated via `npm run db:generate`):
- `ALTER TABLE paragraph_comments ADD COLUMN resolution_reason text` (nullable — required only at the API layer for new resolutions; existing resolved rows keep `NULL`).
- `ALTER TABLE paragraph_comments ADD COLUMN reopened_by text`, `ALTER TABLE paragraph_comments ADD COLUMN reopened_at text` (nullable, mirrors the existing `resolved_by`/`resolved_at` pattern).
- `CREATE INDEX idx_paragraph_comments_parent ON paragraph_comments (parent_comment_id)`.
- **No FK constraint on `parent_comment_id`** — D1/SQLite can't add one to an existing table without a full rebuild; referential validity (parent exists, same contract, same block, and is itself a root) is enforced in the API layer instead.

**On rollback (refinement 6)**: this migration is additive and safe to deploy forward. It is **not** treated as reversible in practice — a later migration that dropped these columns would discard real resolution/reopen history, which is user data, not scaffolding. If Phase 1 ever needs to be walked back, that would be done with a forward corrective migration (e.g. a follow-up change to logic/columns), not a "down" migration that deletes this history. D1 migrations are treated as forward-only from this point on.

**API changes**:
- `app/api/contracts/[contractId]/comments/route.ts` (owner): `action: "reply"` (insert requiring `parentCommentId` to reference a root comment in the same contract+block, 400 otherwise; 409 if that root is resolved); `action: "resolve"` requires `reason` (400 if missing/too short/too long) and now requires the target to be a root comment (400 if it's a reply), cascades to replies; new `action: "reopen"` (owner-only, 403 for non-owner callers, 400 if the target isn't currently resolved), cascades to replies.
- `app/api/client/contracts/[contractId]/comments/route.ts` and `app/api/portal/contracts/[contractId]/comments/route.ts`: gain the same reply-target validation (root-only parent, 400 on cross-contract/cross-block/non-root parent; 409 on a resolved thread). They gain no resolve/reopen capability — that stays owner-only.

**UI**: nested rendering (root + indented replies, resolve/reopen controls with a reason prompt, replies disabled with an explanatory note once a thread is resolved) in `app/workflow/[contractId]/page.tsx` and `app/review/[contractId]/page.tsx`, replacing the current flat `.map()` lists. The supplier portal page's comment rendering is checked and updated the same way if it duplicates this logic rather than sharing it.

### 4. Lifecycle transition rules

**Two transition maps** in `lib/workflow.ts`, next to the existing `LIFECYCLE_STAGES` — a full graph (used while the contract is not yet locked, allowing one-step-back revision loops) and a forward-only subset (used once `status==='locked'`, per refinement 2's explicit ban on post-lock backward moves):

```
Full graph (contract not locked):
draft            -> internal_review
internal_review  -> external_review, draft
external_review  -> approved, internal_review
approved         -> executed, external_review
executed         -> renewed, expired
expired          -> renewed
renewed          -> (terminal for this contract record — see note)

Forward-only graph (contract locked):
draft            -> internal_review        (unreachable in practice once locked, kept for symmetry)
internal_review  -> external_review
external_review  -> approved
approved         -> executed
executed         -> renewed, expired
expired          -> renewed
renewed          -> (terminal)
```

Note on `renewed`: it does not loop back to `internal_review`. Renewal is realized today by the existing `amendments` route creating a **new** contract row with a `renews` relationship (`contract_relationships`), not by cycling the same locked contract back through review — so `renewed` is a terminal marker on the original record. (This corrects the first draft, which had erroneously included a `renewed → internal_review` edge that contradicts how locking/renewal actually works in this codebase — there is no "unlock" path anywhere in `lib/agreements.ts` or elsewhere.)

**Guards** enforced server-side in `PATCH app/api/contracts/[contractId]/lifecycle/route.ts` (currently only checks enum membership plus the existing `executed` ⇒ `status==='locked'` rule, which is kept):
- Setting `lifecycleStage` to its current value is always allowed (no-op stage change, used when only other metadata like risk or renewal date changes).
- Otherwise: if `contract.status === 'locked'`, the requested next stage must be in the **forward-only** map for the current stage, else `400 { error: "Locked contracts can only move forward in the lifecycle" }`. If not locked, the next stage must be in the **full** map, else `400 { error: "Invalid lifecycle transition from <current> to <next>" }`.
- Moving **to** `approved` additionally requires zero pending `paragraph_proposals` and zero `required=1` `approval_requests` at `current_version` with `status != 'approved'` (same predicate already used in `lib/agreements.ts`) — otherwise `409`.
- Moving **to** `executed` keeps the existing `status==='locked'` requirement (`409` if not locked).

### 8. Redline / full-document diff upgrade

`compareVersions()` in `lib/workflow.ts` already returns per-block `{ key, changed, diff, orderIndex }` plus version numbers/timestamps; this gets extended, not replaced.

- **Version picker for any two versions (refinement 8)**: the redline card gets two `<select>` controls (From / To) populated from *all* of the contract's `contract_versions` (via a new lightweight `GET` of version numbers + timestamps, or reusing data already loaded into the workflow page), not just "latest vs. previous." Selecting any pair calls the existing `GET .../versions/compare?from=&to=` route, which already accepts arbitrary version numbers — no API change needed, only the UI gains the picker.
- **Stable, encoded anchor IDs (refinement 8)**: `compareVersions()`'s returned block objects gain an `anchorId` field computed as `newBlock?.id ?? oldBlock?.id ?? safeSlug(key)`, where `safeSlug` strips anything outside `[A-Za-z0-9_-]` and prefixes with `b-` if the result would start with a digit. Using the paragraph's stable `document_blocks.id` (a UUID, present on essentially every real block) instead of the human-authored `block_key` avoids DOM-id collisions and invalid characters; `safeSlug(key)` is only a last-resort fallback for the rare case neither block has an `id` (e.g. a fully deleted-then-reinserted key with no surviving id on either side).
- **View mode toggle** (Unified / Side-by-side) as local UI state in the `redline-card` section of `app/workflow/[contractId]/page.tsx`. Unified keeps the current inline `<del>`/`<ins>` rendering. Side-by-side renders two columns (original | proposed) per paragraph, row-aligned by `anchorId`.
- **Version/date/author metadata with graceful fallback (refinement 8)**: header per compared version showing version number, `created_at`, and author — joining `contract_versions.created_by` to `users.display_name`. Older/seeded versions may have no resolvable author; the UI renders "Unknown author" rather than an empty string or a crash, and a test in `tests/e2e/happy-path.spec.ts` (or a dedicated small e2e spec) exercises comparing against a version whose `created_by` doesn't resolve to a display name, asserting the fallback text appears and the page doesn't error.
- **"Jump to change"**: a change list (excerpt + link) rendered above the diff; each entry is an in-page anchor (`#<anchorId>`) to the corresponding paragraph, which gets a matching `id="${anchorId}"` on its rendered container.

### 9. Automated edge-case coverage

**Environment (refinement 4)**: the existing `node:test` files in this repo do **not** actually execute Cloudflare route handlers — `tests/database.test.mjs` replays the raw migration SQL into an in-process `node:sqlite` `DatabaseSync` and tests query predicates directly (no `cloudflare:workers` import, no route code), and `tests/rendered-html.test.mjs` does static source-text assertions (`assert.match(fileContents, /pattern/)`) rather than invoking anything at runtime. Neither pattern can produce a real HTTP status code from a real route handler with real D1/R2 bindings — confirming the reviewer's concern was correct for this codebase specifically, not just in general.

Rather than introduce a second test framework (e.g. `@cloudflare/vitest-pool-workers`) alongside Playwright, edge-case tests live in **`tests/e2e/api/edge-cases.spec.ts`**, using Playwright's built-in `request` fixture (pure HTTP, no browser page needed) against the same Miniflare-backed local dev server (`webServer`) and isolated `.wrangler/state-e2e` persistence as the rest of the e2e suite. This satisfies "Workers-capable route-test environment" directly, runs under the same single `npm run test:e2e` command, and keeps all genuinely parser/unit-level tests (`security.test.ts`, `docx.test.ts`, `ai-scope.test.ts`, `text-diff.test.ts`) exactly where they are in `node:test` — unchanged, per the instruction to keep unit tests there. `package.json`'s existing `npm test` script is **not modified**.

**Authorization status-code contract (refinement 3)** — committed to explicitly, applied to every route touched by Phase 1 (comments: owner/client/portal; lifecycle; the download routes exercised by edge-case tests) rather than left as "whichever the current handler returns":

| Situation | Status | Notes |
|---|---|---|
| No credential / cookie at all, or a credential that fails to resolve to any valid session (including an **expired session token**, since an expired session is, functionally, no session) | **401** | e.g. `getClientSession`/`getPortalSession` returning `null` because the session or account row is expired/revoked/inactive |
| A valid session exists, but its permission tier is insufficient for the action (e.g. `permission='view'` attempting to comment; a non-owner attempting `resolve`/`reopen`) | **403** | The caller is who they say they are and the resource is theirs to see; they just can't do this specific thing |
| The caller has no relationship to the requested resource at all — wrong contract, wrong organization, or (for the portal) no active `contract_access_grants` row linking this account to this contract for **any** reason (never granted, revoked, or expired — the query cannot and should not distinguish these, to avoid leaking which case applies) | **404** | Chosen over 403 specifically to avoid confirming a contract exists to a caller with no legitimate claim to it |
| Stale write racing another mutation (`mutationGuard` conflict), or any mutation attempted against a `status='locked'` contract that the guard rejects | **409** | Unchanged from existing behavior — already implemented via `lib/mutations.ts` and explicit `status==='locked'` checks |
| A `document_objects`/vault document row exists but its R2 key is missing from the bucket | **404** | Not 500 — the route must check the R2 `get()` result for null before touching `.body` |

This requires two small, in-scope code changes beyond what items 2/4 already touch, both confined to the routes Phase 1 modifies or edge-case-tests directly:
- `app/api/client/contracts/[contractId]/comments/route.ts` (and any other Phase-1-touched client route using the same pattern): split `session.contractId !== contractId` (→ **404**, cross-resource) from `!["comment","propose_changes"].includes(session.permission)` (→ **403**, insufficient permission) — today both collapse into a single 403.
- `app/api/portal/contracts/[contractId]/comments/route.ts` (and any other Phase-1-touched portal route): split `!grant` (→ **404** — `portalGrant()` already returns `null` uniformly for never-granted/revoked/expired, which is the correct 404 bucket per the table above) from `!["comment","propose_changes"].includes(grant.permission)` (→ **403**) — today both collapse into a single 403.

This is a deliberate, scoped correction to authorization responses on the specific routes Phase 1 touches — **not** a blanket rewrite of all ~44 route files' error codes (that's out of scope for Phase 1; Phase 2's monitoring-coverage item touches route count at that scale for a different reason).

**Test cases** (each asserts the exact code from the table above):

| # | Case | Expected |
|---|---|---|
| 1 | Reviewer (client) cookie on an owner-only route (e.g. `PATCH` lifecycle) | 403 (owner-boundary rejects by cookie namespace before any resource lookup — this is "wrong credential type for this API," a 403, not a 404, since it's not a resource-existence question) |
| 2 | No/garbage owner cookie, non-localhost | 401 |
| 3 | Expired `access_sessions` token | 401 |
| 4 | Revoked/inactive `contract_access_grants`, or a grant that never existed | 404 |
| 5 | Cross-organization: portal account of org A against a contract only granted to org B | 404 |
| 6 | Malformed upload (bad content-type / truncated body) at the upload route layer | 400 |
| 7 | Download of a `document_objects`/vault document row whose R2 key is missing from the bucket | 404 |
| 8 | Concurrent paragraph-proposal resolution racing on the same version, driven through the HTTP route | 409 |
| 9 | Mutation attempt against a `status='locked'` contract | 409 |
| 10 | Reply with `parentCommentId` from another contract | 400 |
| 11 | Reply with `parentCommentId` from a different paragraph (block) in the same contract | 400 |
| 12 | Reply attempt on an already-resolved thread | 409 |
| 13 | Resolve without a `reason` (or with one under 3 / over 500 chars) | 400 |
| 14 | Reopen attempted by a non-owner (reviewer/supplier session) | 403 |
| 15 | Reply targeting a reply instead of a root comment | 400 |

Cases 1–9 were reviewed against actual handler code (`lib/owner-boundary.ts`, `lib/client-auth.ts`, `lib/portal-auth.ts`, `lib/mutations.ts`, the download route) while writing this spec; where current behavior didn't yet match the committed contract (cases 4 and 5, both currently 403), that's the two in-scope code changes listed above — a deliberate fix, not a discovered surprise to react to later. Case 7's route will be confirmed against whichever download route does a direct R2 `get()` by stored key (`app/api/portal/documents/[documentId]/download/route.ts` or `app/api/v2/documents/[documentId]/download/route.ts`) during implementation; if it currently 500s on a miss, returning 404 is an in-scope bug fix.

---

## API / permission matrix (Phase 1 scope)

| Action | Owner | Reviewer (legacy client) | Supplier (portal v2) | Approver (Phase 3, N/A here) |
|---|---|---|---|---|
| View comments | ✅ own contracts | ✅ if `permission ∈ {view,comment,propose_changes}` | ✅ if grant `permission ∈ {view,comment,propose_changes}` and grant active | — |
| Add root comment | ✅ | ✅ if `permission ∈ {comment,propose_changes}` | ✅ if grant `permission ∈ {comment,propose_changes}` | — |
| Reply to a root comment | ✅ (own contracts) | ✅ (same gate as add); 400 if parent isn't a root or isn't this contract/block; 409 if thread resolved | ✅ (same gate as add); same 400/409 rules | — |
| Resolve a thread (+ reason) | ✅ only, root comment only, reason required | ❌ 403 | ❌ 403 | — |
| Reopen a thread | ✅ only, root comment only, must currently be resolved | ❌ 403 | ❌ 403 | — |
| `PATCH` lifecycle | ✅ only | ❌ 403 (owner-boundary) | ❌ 403 | — |
| `GET` calendar (`.ics`) | ✅ own contracts only (route is `requireOwnerApi`-gated today; unchanged) | ❌ not exposed | ❌ not exposed | — |
| `GET` version compare (redline) | ✅ | out of Phase 1 scope (owner-console-only feature today; unchanged) | out of scope | — |
| Propose a change | via workflow UI, not a raw owner API | ✅ if `permission==='propose_changes'` | ✅ if grant `permission==='propose_changes'` | — |
| Counter / accept / reject a proposal | ✅ only | ❌ | ❌ | — |
| Record agreement | ✅ (initiator party) | ✅ (counterparty party, if the session's `partyId` matches; else 404 per the new contract, not 403) | ✅ (counterparty, via portal agree route) | — |

---

## Regression guardrails — existing behavior that must not change

1. Owner API boundary rejects reviewer sessions (`tests/rendered-html.test.mjs`) — unmodified assertion, must keep passing.
2. Approvals remain version-scoped (`tests/database.test.mjs`).
3. Controlled amendments preserve the locked source contract (`tests/database.test.mjs`) — item 4's new transition guards must not interfere with amendment creation, which already independently requires `status==='locked'`.
4. `mutationGuard` continues to abort stale writes exactly as today — item 9 adds route-level coverage but does not change `lib/mutations.ts` semantics.
5. The existing `executed` ⇒ `status==='locked'` rule in the lifecycle route is preserved, just now combined with the new adjacency/forward-only checks rather than replaced.
6. Demo reset (`POST /api/demo/reset`) remains idempotent and requires no manual DB intervention after the new migration lands — verified by running it post-migration, and again as the reset step in every e2e run.
7. `.ics` export format/content-type is unchanged for all existing reminder kinds (`calendarText()` untouched).
8. The full existing `npm test` suite (`rendered-html`, `database`, `version-two`, `security`, `docx`, `ai-scope`, `text-diff`) continues to pass unmodified, except where the new migration requires `database.test.mjs`'s "migrations apply cleanly" assertion to include the new migration file — that's an expected, additive update, not a behavior change. `package.json`'s `test` script itself is not modified; `test:e2e` is added alongside it.
9. Reviewer/supplier top-level comment insertion (`parentCommentId: null`) keeps working exactly as before — new parent validation only rejects a `parentCommentId` pointing at a different contract/block or at a non-root comment.
10. AI assistant / paragraph-proposal flows are untouched by the comment-threading and lifecycle changes (no shared code paths modified).
11. A developer's ordinary local `npm run dev` session and its `.wrangler/state/v3` data are never touched by an e2e run (isolated under `.wrangler/state-e2e` instead) — verified by running `npm run dev` and `npm run test:e2e` back-to-back and confirming the dev session's demo data is unaffected.
12. The two authorization-response code changes (client/portal comment routes splitting 404-vs-403) do not change behavior for any *authorized* caller — only the status code returned to callers who were already being rejected, and only in the specific two "collapsed" cases identified above.

---

## Phase 2 — design-level only (not implemented in this pass)

- **5. Notifications**: `lib/notifications.ts` provider-neutral interface (`send(notification): Promise<DeliveryResult>`), new `notification_deliveries` queue table (kind, recipient, template, payload, status, attempts, next_attempt_at, last_error) and `notification_preferences` (unsubscribe). Default provider implementation logs to `notification_deliveries` and console only — **never** described as "sent" anywhere in UI/docs; swapping in a real provider (Resend/SendGrid/etc.) is a one-file change behind the same interface. `worker/index.ts`'s existing (currently opt-in) `scheduled()` cron is extended to sweep due `reminder_schedules`, enqueue, and drain the queue with retry/backoff.
- **6. Monitoring coverage**: `withMonitoring(handler, route)` wrapper applied to the ~38 currently-unwrapped route files; per-request `request_id` generation, echoed in error responses; optional `MONITORING_ALERT_WEBHOOK_URL` for critical severity, no-op if unset.
- **7. Amendment chain UI**: chain-walk helper over `contract_relationships` (already models `amends`/`renews`/`supersedes`), rendered as a full "Amends ← this → Amended by" chain with effective date and a computed "current governing version" badge.
- **10. Release dashboard**: owner-only `app/release/page.tsx` + API surfacing environment, migration count vs. applied, an R2 reachability probe, Vectorize binding presence, last-cron-run timestamp (new status row updated by `worker/index.ts`), and build version/commit.

## Phase 3 — design-level only (not implemented in this pass)

- **3. Multi-person approvals**: new `approvers` (contract-scoped identity) and `approval_assignees` tables; magic-link token auth (`approver_sessions`, cookie `__Host-pactline_approver`) so each approver authenticates as themselves rather than sharing owner credentials; `approval_requests` becomes assignment-driven so the owner can view all approvals on a contract but can only *decide* their own. Notifications for assignment reuse Phase 2's queue. This is deliberately deferred until Phase 1 is reviewed and stable, since it's the one item that changes the authentication/authorization model rather than extending existing routes.
