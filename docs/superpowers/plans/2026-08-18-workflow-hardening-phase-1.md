# Workflow Hardening Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Phase 1 of the contract-workflow-hardening spec (`docs/superpowers/specs/2026-08-18-contract-workflow-hardening-design.md`) — threaded comments, enforced lifecycle transitions, an upgraded redline viewer, and a real Playwright-based e2e/edge-case test suite — on branch `feature/workflow-hardening-phase-1`.

**Architecture:** Additive changes to the existing Next.js/Cloudflare Workers/D1 app. One new Drizzle migration (comment-thread columns/index only). Existing route files are edited in place, following their current compact single-line style. A new Playwright suite under `tests/e2e/` runs against a Miniflare-backed local dev server with isolated on-disk state, exercising the UI for the happy path and using Playwright's `request` fixture for API-level edge cases (the existing `node:test` files don't execute route code and are left untouched).

**Tech Stack:** Next.js 16 / React 19, Drizzle ORM (SQLite/D1), Cloudflare Workers + `@cloudflare/vite-plugin`, `@playwright/test` (new devDependency).

## Global Constraints

- Base branch for this work is `codex/version-two-expansion`; all work happens on `feature/workflow-hardening-phase-1` (already created and checked out).
- No FK constraint is added on `paragraph_comments.parent_comment_id` — validate parent linkage in the API layer only (D1/SQLite can't add a FK to an existing table without a full rebuild).
- The new migration is additive/forward-only — never write a "down" migration that drops `resolution_reason`/`reopened_by`/`reopened_at` (would discard real history).
- Threads are exactly two levels deep: one root comment (`parent_comment_id IS NULL`) plus flat replies. No reply-to-reply.
- Resolve/reopen are owner-only, root-comment-only, and cascade to all replies in the thread. Resolving requires a 3–500 character `reason`.
- Authorization contract: unauthenticated → 401; authenticated but insufficient permission → 403; no relationship to the resource at all (wrong contract/org, or no active grant for any reason) → 404; stale/locked-contract mutation conflict → 409; missing R2 object → 404.
- `npm test` (the existing `node:test` suite) is never modified in behavior, only extended with new assertions where a task explicitly says so. `npm run test:e2e` is a new, separate command.
- Playwright runs with `workers: 1`, isolated Miniflare state under `.wrangler/state-e2e` (never the developer's regular `.wrangler/state/v3`), and never against a remote D1/R2 binding.
- Every UI change follows the codebase's existing compact single-line JSX style — do not reformat surrounding code.
- **Local D1 in this repo does not auto-apply Drizzle migrations, ever** — confirmed by hands-on testing during Task 2: neither an existing `.wrangler/state` directory nor a brand-new one picks up `drizzle/*.sql` automatically on `npm run dev` startup (there is no `predev`/`postinstall` hook, and the only place this repo runs `wrangler d1 migrations apply` at all is `.github/workflows/deploy-cloudflare.yml`, and only with `--remote`). If a manual verification step in this plan returns a `D1_ERROR: no such table` or a generic 500 from a route that should work, this is almost always why — apply the migrations directly before assuming a code defect: stop any running dev server first (the sqlite files lock while it's up), then run
  ```bash
  node -e "
  const { DatabaseSync } = require('node:sqlite');
  const { readFileSync, readdirSync } = require('node:fs');
  const glob = require('node:fs').readdirSync('.wrangler/state/v3/d1/miniflare-D1DatabaseObject').find(f => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
  const db = new DatabaseSync('.wrangler/state/v3/d1/miniflare-D1DatabaseObject/' + glob);
  db.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync('drizzle').filter(n => /^\d{4}.*\.sql$/.test(n)).sort()) db.exec(readFileSync('drizzle/' + file, 'utf8').replaceAll('--> statement-breakpoint', ''));
  console.log('migrated', db.prepare(\"SELECT name FROM sqlite_schema WHERE type='table'\").all().length, 'tables');
  "
  ```
  then restart `npm run dev`. Task 9 builds this same bootstrap into the e2e fixtures so the isolated `.wrangler/state-e2e` database never hits this — see Task 9 Step 5.

---

### Task 1: Comment-thread schema migration

**Files:**
- Modify: `db/schema.ts:207-221` (`paragraphComments` table)
- Modify: `tests/database.test.mjs:17-30` (migration assertions)
- Create: a new file under `drizzle/` (auto-named by `drizzle-kit generate`)

**Interfaces:**
- Produces: `paragraph_comments.resolution_reason` (text, nullable), `paragraph_comments.reopened_by` (text, nullable), `paragraph_comments.reopened_at` (text, nullable), index `idx_paragraph_comments_parent` on `paragraph_comments(parent_comment_id)`. Tasks 2–5 depend on these columns existing.

- [ ] **Step 1: Write the failing assertions**

In `tests/database.test.mjs`, inside the existing `test("all migrations apply cleanly and match the active paragraph model", ...)` block, immediately before the final `database.close();` (currently line 29), add:

```js
  const commentColumns = database.prepare("PRAGMA table_info(paragraph_comments)").all().map((row) => row.name);
  for (const required of ["parent_comment_id", "resolution_reason", "reopened_by", "reopened_at"]) assert.ok(commentColumns.includes(required), required);
  const commentIndexes = database.prepare("PRAGMA index_list(paragraph_comments)").all().map((row) => row.name);
  assert.ok(commentIndexes.includes("idx_paragraph_comments_parent"));
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/database.test.mjs`
Expected: FAIL — `resolution_reason` (or a later assertion) is not in `commentColumns`.

- [ ] **Step 3: Update the schema**

In `db/schema.ts`, replace the `paragraphComments` definition (lines 207-221):

```ts
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
  ...timestamps,
}, (table) => [index("idx_paragraph_comments_block").on(table.contractId, table.blockId, table.createdAt), index("idx_paragraph_comments_status").on(table.contractId, table.status)]);
```

with:

```ts
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
```

- [ ] **Step 4: Generate the migration**

Run: `npm run db:generate`

This creates a new file `drizzle/00010_<auto-name>.sql`. Open it and confirm it contains exactly these statement shapes (order may differ):

```sql
ALTER TABLE `paragraph_comments` ADD `resolution_reason` text;
ALTER TABLE `paragraph_comments` ADD `reopened_by` text;
ALTER TABLE `paragraph_comments` ADD `reopened_at` text;
CREATE INDEX `idx_paragraph_comments_parent` ON `paragraph_comments` (`parent_comment_id`);
```

If drizzle-kit instead tries to rebuild the whole table (because it thinks something about the table shape changed beyond the new columns), stop and re-check Step 3 for an accidental edit to an existing column — it should not happen for a pure column-addition, but verify before proceeding.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/database.test.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add db/schema.ts drizzle/ tests/database.test.mjs
git commit -m "feat: add comment-thread resolution/reopen columns and parent index"
```

---

### Task 2: Owner comment-thread API (reply, resolve+reason, reopen)

**Files:**
- Modify: `app/api/contracts/[contractId]/comments/route.ts` (full rewrite)

**Interfaces:**
- Consumes: `paragraph_comments.resolution_reason/reopened_by/reopened_at` (Task 1).
- Produces: `POST /api/contracts/:id/comments` actions `add | reply | resolve | reopen`. `reply` requires `{ blockId, parentCommentId, body }`; `resolve` requires `{ commentId, reason }`; `reopen` requires `{ commentId }`. Tasks 4 (owner UI) and 12 (edge-case tests) depend on this exact action/field shape and the status codes below.

- [ ] **Step 1: Replace the route with the new action set**

Replace the entire contents of `app/api/contracts/[contractId]/comments/route.ts` with:

```ts
import { env } from "cloudflare:workers";
import { requireOwnerApi } from "@/lib/owner-boundary";
import { ownerContract } from "@/lib/workflow";
import { captureError } from "@/lib/monitoring";

type ParentRow = { id: string; block_id: string; status: string; parent_comment_id: string | null };

export async function POST(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const auth = await requireOwnerApi(request); if (auth.response) return auth.response;
  const { contractId } = await context.params; if (!await ownerContract(contractId, auth.user.userId)) return Response.json({ error: "Contract not found" }, { status: 404 });
  let body: { action?: "add" | "reply" | "resolve" | "reopen"; blockId?: string; body?: string; parentCommentId?: string; commentId?: string; reason?: string }; try { body = await request.json() as typeof body; } catch { return Response.json({ error: "Valid JSON is required" }, { status: 400 }); }
  const now = new Date().toISOString(); const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  try {
  if (body.action === "add") {
    if (body.parentCommentId) return Response.json({ error: "Use the reply action to respond to an existing comment" }, { status: 400 });
    const text = body.body?.trim(); if (!body.blockId || !text || text.length > 5000) return Response.json({ error: "Choose a paragraph and enter a comment up to 5,000 characters" }, { status: 400 });
    const block = await env.DB.prepare("SELECT id FROM document_blocks WHERE id=? AND contract_id=?").bind(body.blockId, contractId).first(); if (!block) return Response.json({ error: "Paragraph not found" }, { status: 404 });
    const round = await env.DB.prepare("SELECT id FROM review_rounds WHERE contract_id=? AND status='open' ORDER BY round_number DESC LIMIT 1").bind(contractId).first<{ id: string }>(); const id = crypto.randomUUID();
    await env.DB.batch([env.DB.prepare("INSERT INTO paragraph_comments (id,contract_id,block_id,review_round_id,parent_comment_id,author_kind,author_id,author_display,body,status,created_at,updated_at) VALUES (?,?,?,?,NULL,'owner',?,?,?,'open',?,?)").bind(id, contractId, body.blockId, round?.id ?? null, auth.user.userId, auth.user.displayName, text, now, now), env.DB.prepare("INSERT INTO audit_log_entries (id,contract_id,actor_id,actor_display,action,target_type,target_id,request_id,metadata,created_at) VALUES (?,?,?,?, 'paragraph_comment.added','paragraph_comment',?,?,json(?),?)").bind(crypto.randomUUID(), contractId, auth.user.userId, auth.user.displayName, id, requestId, JSON.stringify({ blockId: body.blockId }), now)]);
    return Response.json({ comment: { id, body: text, authorDisplay: auth.user.displayName } }, { status: 201 });
  }
  if (body.action === "reply") {
    const text = body.body?.trim(); if (!body.blockId || !body.parentCommentId || !text || text.length > 5000) return Response.json({ error: "Choose a paragraph, the comment you are replying to, and enter a reply up to 5,000 characters" }, { status: 400 });
    const parent = await env.DB.prepare("SELECT id, block_id, status, parent_comment_id FROM paragraph_comments WHERE id=? AND contract_id=?").bind(body.parentCommentId, contractId).first<ParentRow>();
    if (!parent) return Response.json({ error: "The comment you are replying to was not found on this contract" }, { status: 400 });
    if (parent.parent_comment_id !== null) return Response.json({ error: "Replies can only be added to the original comment, not to another reply" }, { status: 400 });
    if (parent.block_id !== body.blockId) return Response.json({ error: "The reply must target the same paragraph as the original comment" }, { status: 400 });
    if (parent.status === "resolved") return Response.json({ error: "This thread is resolved. Reopen it before replying." }, { status: 409 });
    const round = await env.DB.prepare("SELECT id FROM review_rounds WHERE contract_id=? AND status='open' ORDER BY round_number DESC LIMIT 1").bind(contractId).first<{ id: string }>(); const id = crypto.randomUUID();
    await env.DB.batch([env.DB.prepare("INSERT INTO paragraph_comments (id,contract_id,block_id,review_round_id,parent_comment_id,author_kind,author_id,author_display,body,status,created_at,updated_at) VALUES (?,?,?,?,?,'owner',?,?,?,'open',?,?)").bind(id, contractId, body.blockId, round?.id ?? null, body.parentCommentId, auth.user.userId, auth.user.displayName, text, now, now), env.DB.prepare("INSERT INTO audit_log_entries (id,contract_id,actor_id,actor_display,action,target_type,target_id,request_id,metadata,created_at) VALUES (?,?,?,?, 'paragraph_comment.replied','paragraph_comment',?,?,json(?),?)").bind(crypto.randomUUID(), contractId, auth.user.userId, auth.user.displayName, id, requestId, JSON.stringify({ blockId: body.blockId, parentCommentId: body.parentCommentId }), now)]);
    return Response.json({ comment: { id, body: text, authorDisplay: auth.user.displayName } }, { status: 201 });
  }
  if (body.action === "resolve" && body.commentId) {
    const reason = body.reason?.trim(); if (!reason || reason.length < 3 || reason.length > 500) return Response.json({ error: "A resolution reason between 3 and 500 characters is required" }, { status: 400 });
    const root = await env.DB.prepare("SELECT id FROM paragraph_comments WHERE id=? AND contract_id=? AND status='open' AND parent_comment_id IS NULL").bind(body.commentId, contractId).first();
    if (!root) return Response.json({ error: "Open comment thread not found" }, { status: 404 });
    await env.DB.batch([
      env.DB.prepare("UPDATE paragraph_comments SET status='resolved',resolved_by=?,resolved_at=?,resolution_reason=?,updated_at=? WHERE id=? AND contract_id=?").bind(auth.user.userId, now, reason, now, body.commentId, contractId),
      env.DB.prepare("UPDATE paragraph_comments SET status='resolved',resolved_by=?,resolved_at=?,updated_at=? WHERE parent_comment_id=? AND contract_id=? AND status='open'").bind(auth.user.userId, now, now, body.commentId, contractId),
      env.DB.prepare("INSERT INTO audit_log_entries (id,contract_id,actor_id,actor_display,action,target_type,target_id,request_id,metadata,created_at) VALUES (?,?,?,?, 'paragraph_comment.resolved','paragraph_comment',?,?,json(?),?)").bind(crypto.randomUUID(), contractId, auth.user.userId, auth.user.displayName, body.commentId, requestId, JSON.stringify({ reason }), now),
    ]);
    return Response.json({ resolved: true });
  }
  if (body.action === "reopen" && body.commentId) {
    const result = await env.DB.prepare("UPDATE paragraph_comments SET status='open',reopened_by=?,reopened_at=?,resolved_by=NULL,resolved_at=NULL,resolution_reason=NULL,updated_at=? WHERE id=? AND contract_id=? AND status='resolved' AND parent_comment_id IS NULL").bind(auth.user.userId, now, now, body.commentId, contractId).run();
    if (!result.meta.changes) return Response.json({ error: "Resolved comment thread not found" }, { status: 404 });
    await env.DB.batch([
      env.DB.prepare("UPDATE paragraph_comments SET status='open',updated_at=? WHERE parent_comment_id=? AND contract_id=? AND status='resolved'").bind(now, body.commentId, contractId),
      env.DB.prepare("INSERT INTO audit_log_entries (id,contract_id,actor_id,actor_display,action,target_type,target_id,request_id,metadata,created_at) VALUES (?,?,?,?, 'paragraph_comment.reopened','paragraph_comment',?,?,json('{}'),?)").bind(crypto.randomUUID(), contractId, auth.user.userId, auth.user.displayName, body.commentId, requestId, now),
    ]);
    return Response.json({ reopened: true });
  }
  return Response.json({ error: "Action must add, reply, resolve, or reopen a comment" }, { status: 400 });
  } catch (error) {
    await captureError(error, { requestId, route: "/api/contracts/:id/comments", method: "POST", actorScope: "owner", contractId });
    return Response.json({ error: "Unable to update the paragraph discussion", requestId }, { status: 500 });
  }
}
```

- [ ] **Step 2: Manually verify against the running dev server**

Run: `npm run dev`, then in a second terminal:

```bash
curl -s -X POST http://localhost:3000/api/demo/reset -H "Host: localhost:3000"
curl -s -X POST http://localhost:3000/api/contracts/sample-services-agreement/comments -H "Host: localhost:3000" -H "content-type: application/json" -d '{"action":"add","blockId":"sample-block-6","body":"Please confirm payment terms."}'
```

Expected: a `201` response with a `comment.id`. Note the returned `id`, then:

```bash
curl -s -X POST http://localhost:3000/api/contracts/sample-services-agreement/comments -H "Host: localhost:3000" -H "content-type: application/json" -d '{"action":"resolve","commentId":"<id-from-above>"}'
```

Expected: `400` (missing reason). Then re-run with `"reason":"Confirmed acceptable."` — expected `200 {"resolved":true}`. Stop the dev server (`Ctrl+C`) when done.

- [ ] **Step 3: Commit**

```bash
git add app/api/contracts/\[contractId\]/comments/route.ts
git commit -m "feat: add reply, reason-required resolve, and reopen to owner comment threads"
```

---

### Task 3: Client and portal comment-thread API (reply validation, 404/403 split)

**Files:**
- Modify: `app/api/client/contracts/[contractId]/comments/route.ts` (full rewrite)
- Modify: `app/api/portal/contracts/[contractId]/comments/route.ts` (full rewrite)

**Interfaces:**
- Consumes: same `paragraph_comments` columns as Task 2.
- Produces: both routes now return `404` (not `403`) when the session has no relationship to the requested contract at all, and validate `parentCommentId` the same way the owner route does (400 for a foreign/non-root/mismatched-block parent, 409 for replying to a resolved thread). Task 5 and Task 12 depend on this.

- [ ] **Step 1: Rewrite the client route**

Replace the entire contents of `app/api/client/contracts/[contractId]/comments/route.ts` with:

```ts
import { env } from "cloudflare:workers";
import { getClientSession } from "@/lib/client-auth";

type ParentRow = { id: string; block_id: string; status: string; parent_comment_id: string | null };

export async function POST(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const session = await getClientSession(request); if (!session) return Response.json({ error: "Authentication required" }, { status: 401 });
  const { contractId } = await context.params;
  if (session.contractId !== contractId) return Response.json({ error: "Contract not found" }, { status: 404 });
  if (!["comment", "propose_changes"].includes(session.permission)) return Response.json({ error: "You cannot comment on this contract" }, { status: 403 });
  let body: { blockId?: string; body?: string; parentCommentId?: string }; try { body = await request.json() as typeof body; } catch { return Response.json({ error: "Valid JSON is required" }, { status: 400 }); }
  const text = body.body?.trim(); if (!body.blockId || !text || text.length > 5000) return Response.json({ error: "Choose a paragraph and enter a comment up to 5,000 characters" }, { status: 400 });
  const block = await env.DB.prepare("SELECT id FROM document_blocks WHERE id=? AND contract_id=?").bind(body.blockId, contractId).first(); if (!block) return Response.json({ error: "Paragraph not found" }, { status: 404 });
  if (body.parentCommentId) {
    const parent = await env.DB.prepare("SELECT id, block_id, status, parent_comment_id FROM paragraph_comments WHERE id=? AND contract_id=?").bind(body.parentCommentId, contractId).first<ParentRow>();
    if (!parent) return Response.json({ error: "The comment you are replying to was not found on this contract" }, { status: 400 });
    if (parent.parent_comment_id !== null) return Response.json({ error: "Replies can only be added to the original comment, not to another reply" }, { status: 400 });
    if (parent.block_id !== body.blockId) return Response.json({ error: "The reply must target the same paragraph as the original comment" }, { status: 400 });
    if (parent.status === "resolved") return Response.json({ error: "This thread is resolved. Ask the contract owner to reopen it before replying." }, { status: 409 });
  }
  const round = await env.DB.prepare("SELECT id FROM review_rounds WHERE contract_id=? AND status='open' ORDER BY round_number DESC LIMIT 1").bind(contractId).first<{ id: string }>(); const now = new Date().toISOString(); const id = crypto.randomUUID(); const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  await env.DB.batch([env.DB.prepare("INSERT INTO paragraph_comments (id,contract_id,block_id,review_round_id,parent_comment_id,author_kind,author_id,author_display,body,status,created_at,updated_at) VALUES (?,?,?,?,?,'reviewer',?,?,?,'open',?,?)").bind(id, contractId, body.blockId, round?.id ?? null, body.parentCommentId ?? null, session.accountId, `${session.name} (${session.username})`, text, now, now), env.DB.prepare("INSERT INTO audit_log_entries (id,contract_id,actor_id,actor_display,action,target_type,target_id,request_id,metadata,created_at) VALUES (?,?,?,?, ?,'paragraph_comment',?,?,json(?),?)").bind(crypto.randomUUID(), contractId, session.accountId, `${session.name} (${session.username})`, body.parentCommentId ? "paragraph_comment.replied" : "paragraph_comment.added", id, requestId, JSON.stringify({ blockId: body.blockId }), now)]);
  return Response.json({ comment: { id, body: text, authorDisplay: session.name } }, { status: 201 });
}
```

- [ ] **Step 2: Rewrite the portal route**

Replace the entire contents of `app/api/portal/contracts/[contractId]/comments/route.ts` with:

```ts
import { env } from "cloudflare:workers";
import { portalGrant, requirePortalSession } from "@/lib/portal-auth";

type ParentRow = { id: string; block_id: string; status: string; parent_comment_id: string | null };

export async function POST(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const auth = await requirePortalSession(request); if (auth.response) return auth.response;
  const { contractId } = await context.params; const grant = await portalGrant(auth.session!, contractId);
  if (!grant) return Response.json({ error: "Contract not found" }, { status: 404 });
  if (!["comment", "propose_changes"].includes(grant.permission)) return Response.json({ error: "You cannot comment on this contract" }, { status: 403 });
  const body = await request.json().catch(() => null) as { blockId?: string; body?: string; parentCommentId?: string } | null; const text = body?.body?.trim();
  if (!body?.blockId || !text || text.length > 5000) return Response.json({ error: "Choose a paragraph and enter a comment up to 5,000 characters" }, { status: 400 });
  const block = await env.DB.prepare("SELECT id FROM document_blocks WHERE id=? AND contract_id=?").bind(body.blockId, contractId).first(); if (!block) return Response.json({ error: "Paragraph not found" }, { status: 404 });
  if (body.parentCommentId) {
    const parent = await env.DB.prepare("SELECT id, block_id, status, parent_comment_id FROM paragraph_comments WHERE id=? AND contract_id=?").bind(body.parentCommentId, contractId).first<ParentRow>();
    if (!parent) return Response.json({ error: "The comment you are replying to was not found on this contract" }, { status: 400 });
    if (parent.parent_comment_id !== null) return Response.json({ error: "Replies can only be added to the original comment, not to another reply" }, { status: 400 });
    if (parent.block_id !== body.blockId) return Response.json({ error: "The reply must target the same paragraph as the original comment" }, { status: 400 });
    if (parent.status === "resolved") return Response.json({ error: "This thread is resolved. Ask the contract owner to reopen it before replying." }, { status: 409 });
  }
  const round = await env.DB.prepare("SELECT id FROM review_rounds WHERE contract_id=? AND status='open' ORDER BY round_number DESC LIMIT 1").bind(contractId).first<{ id: string }>(); const now = new Date().toISOString(); const id = crypto.randomUUID(); const display = `${auth.session!.displayName} (${auth.session!.username})`;
  await env.DB.prepare("INSERT INTO paragraph_comments (id,contract_id,block_id,review_round_id,parent_comment_id,author_kind,author_id,author_display,body,status,created_at,updated_at) VALUES (?,?,?,?,?,'reviewer',?,?,?,'open',?,?)").bind(id, contractId, body.blockId, round?.id ?? null, body.parentCommentId ?? null, auth.session!.accountId, display, text, now, now).run();
  return Response.json({ comment: { id, body: text, authorDisplay: display } }, { status: 201 });
}
```

- [ ] **Step 2: Manually verify the 404 split**

With `npm run dev` running:

```bash
curl -s -X POST http://localhost:3000/api/client/login -H "Host: localhost:3000" -H "content-type: application/json" -d '{"username":"client.reviewer","password":"ReviewDemo!2026"}' -c /tmp/client-cookies.txt
curl -s -X POST http://localhost:3000/api/client/contracts/not-a-real-contract/comments -H "Host: localhost:3000" -H "content-type: application/json" -b /tmp/client-cookies.txt -d '{"blockId":"x","body":"test"}'
```

Expected: `404 {"error":"Contract not found"}` (previously this returned `403`).

- [ ] **Step 3: Commit**

```bash
git add app/api/client/contracts/\[contractId\]/comments/route.ts app/api/portal/contracts/\[contractId\]/comments/route.ts
git commit -m "fix: split cross-resource 404 from insufficient-permission 403 on comment routes"
```

---

### Task 4: Owner workflow page — nested comment threads

**Files:**
- Modify: `app/workflow/[contractId]/page.tsx`
- Modify: `app/globals.css` (append)

**Interfaces:**
- Consumes: Task 2's `reply`/`resolve`/`reopen` actions.
- Produces: no new interfaces (leaf UI task); exercised by Task 10's e2e happy path via clicking "Reply"/"Resolve thread".

- [ ] **Step 1: Update the `Comment` type and add a `threads` memo**

In `app/workflow/[contractId]/page.tsx`, replace line 10:

```ts
type Comment = { id: string; block_id: string; author_display: string; body: string; status: string; created_at: string };
```

with:

```ts
type Comment = { id: string; block_id: string; parent_comment_id: string | null; author_display: string; body: string; status: string; resolution_reason?: string; created_at: string };
type Thread = Comment & { replies: Comment[] };
```

Replace line 48:

```ts
  const blockMap = useMemo(() => new Map((workspace?.blocks ?? []).map((block, index) => [block.id, index + 1])), [workspace]); const openRound = workflow?.reviewRounds.find((item) => item.status === "open");
```

with:

```ts
  const blockMap = useMemo(() => new Map((workspace?.blocks ?? []).map((block, index) => [block.id, index + 1])), [workspace]); const openRound = workflow?.reviewRounds.find((item) => item.status === "open");
  const threads = useMemo<Thread[]>(() => {
    const all = workflow?.comments ?? [];
    return all.filter((comment) => !comment.parent_comment_id).map((root) => ({ ...root, replies: all.filter((comment) => comment.parent_comment_id === root.id) }));
  }, [workflow]);
```

- [ ] **Step 2: Add reply/resolve-reason state**

Replace line 36:

```ts
  const [commentBlock, setCommentBlock] = useState(""); const [commentBody, setCommentBody] = useState(""); const [fromVersion, setFromVersion] = useState(1); const [toVersion, setToVersion] = useState(1); const [comparison, setComparison] = useState<Comparison | null>(null); const [showAll, setShowAll] = useState(false);
```

with:

```ts
  const [commentBlock, setCommentBlock] = useState(""); const [commentBody, setCommentBody] = useState(""); const [fromVersion, setFromVersion] = useState(1); const [toVersion, setToVersion] = useState(1); const [comparison, setComparison] = useState<Comparison | null>(null); const [showAll, setShowAll] = useState(false);
  const [replyBody, setReplyBody] = useState<Record<string, string>>({}); const [resolveReason, setResolveReason] = useState<Record<string, string>>({});
```

- [ ] **Step 3: Replace the comments-card section**

Replace line 81-83 (the entire `<section className="workflow-card comments-card">...</section>` block) with:

```tsx
      <section className="workflow-card comments-card"><CardHead eyebrow="Paragraph discussion" heading="Comments and threads" badge={`${threads.filter((thread) => thread.status === "open").length} open`}/><label>Paragraph<select value={commentBlock} onChange={(event) => setCommentBlock(event.target.value)}>{workspace.blocks.map((block, index) => <option value={block.id} key={block.id}>{index + 1}. {block.current_text.slice(0, 80)}</option>)}</select></label><label>Comment<textarea value={commentBody} onChange={(event) => setCommentBody(event.target.value)} placeholder="Explain the business or legal concern…"/></label><button className="workflow-primary" disabled={busy || !commentBody.trim()} onClick={() => void mutate("comments", { action: "add", blockId: commentBlock, body: commentBody }, "Comment added.").then(() => setCommentBody(""))}>Add comment</button>
        <div className="comment-list">{threads.map((thread) => <article key={thread.id} className={`thread ${thread.status}`}><div><strong>Paragraph {blockMap.get(thread.block_id) ?? "—"} · {thread.author_display}</strong><span>{new Date(thread.created_at).toLocaleString()}</span></div><p>{thread.body}</p>
          {thread.replies.map((reply) => <div className="thread-reply" key={reply.id}><div><strong>{reply.author_display}</strong><span>{new Date(reply.created_at).toLocaleString()}</span></div><p>{reply.body}</p></div>)}
          {thread.status === "resolved" ? <><p className="thread-resolution"><small>Resolved: {thread.resolution_reason}</small></p><button onClick={() => void mutate("comments", { action: "reopen", commentId: thread.id }, "Thread reopened.")}>Reopen thread</button></> : <div className="thread-actions"><textarea value={replyBody[thread.id] ?? ""} onChange={(event) => setReplyBody((current) => ({ ...current, [thread.id]: event.target.value }))} placeholder="Reply to this thread…"/><button disabled={busy || !(replyBody[thread.id] ?? "").trim()} onClick={() => void mutate("comments", { action: "reply", blockId: thread.block_id, parentCommentId: thread.id, body: replyBody[thread.id] }, "Reply added.").then(() => setReplyBody((current) => ({ ...current, [thread.id]: "" })))}>Reply</button><input value={resolveReason[thread.id] ?? ""} onChange={(event) => setResolveReason((current) => ({ ...current, [thread.id]: event.target.value }))} placeholder="Resolution reason (required)"/><button disabled={busy || (resolveReason[thread.id] ?? "").trim().length < 3} onClick={() => void mutate("comments", { action: "resolve", commentId: thread.id, reason: resolveReason[thread.id] }, "Thread resolved.").then(() => setResolveReason((current) => ({ ...current, [thread.id]: "" })))}>Resolve thread</button></div>}
        </article>)}</div>
      </section>
```

- [ ] **Step 4: Append CSS for the new thread elements**

Append to the end of `app/globals.css`:

```css
.thread-reply{margin-left:24px;padding-left:12px;border-left:2px solid var(--line)}
.thread-actions{display:flex;flex-direction:column;gap:6px;margin-top:8px}
.thread-actions textarea{min-height:60px}
.thread-resolution{color:var(--muted);margin-top:6px}
```

- [ ] **Step 5: Manually verify in the browser**

Run `npm run dev`, open `http://localhost:3000/workflow/sample-services-agreement`, add a comment, reply to it, resolve it with a reason, then reopen it. Confirm the UI updates after each action and no console errors appear.

- [ ] **Step 6: Commit**

```bash
git add app/workflow/\[contractId\]/page.tsx app/globals.css
git commit -m "feat: render nested comment threads with reply/resolve/reopen in the owner console"
```

---

### Task 5: Reviewer (client) portal — nested comment threads

**Files:**
- Modify: `app/review/[contractId]/page.tsx`

**Interfaces:**
- Consumes: Task 3's client-route reply validation.
- Note: the v2 supplier portal page (`app/portal/page.tsx`) has **no existing comment UI at all** today (its `Review` type doesn't even include a `comments` field) — this was verified while planning, not assumed. Building comment UI there from scratch is out of scope for Phase 1 (it would be new UI surface, not an "upgrade" of an existing flat list, and wasn't budgeted in the approved spec). The portal comment **API** (Task 3) is fully correct and ready for a future UI addition. This is called out as a known limitation in the Task 13 PR description.

- [ ] **Step 1: Update the `Comment` type and reply state**

In `app/review/[contractId]/page.tsx`, replace line 7:

```ts
type Comment = { id: string; block_id: string; author_kind: "owner" | "reviewer"; author_display: string; body: string; status: string; created_at: string };
```

with:

```ts
type Comment = { id: string; block_id: string; parent_comment_id: string | null; author_kind: "owner" | "reviewer"; author_display: string; body: string; status: string; resolution_reason?: string; created_at: string };
```

Replace line 20:

```ts
  const [drafts, setDrafts] = useState<Record<string, string>>({}); const [editingId, setEditingId] = useState<string | null>(null); const [commentingId, setCommentingId] = useState<string | null>(null); const [commentDraft, setCommentDraft] = useState("");
```

with:

```ts
  const [drafts, setDrafts] = useState<Record<string, string>>({}); const [editingId, setEditingId] = useState<string | null>(null); const [commentingId, setCommentingId] = useState<string | null>(null); const [replyingId, setReplyingId] = useState<string | null>(null); const [commentDraft, setCommentDraft] = useState("");
```

- [ ] **Step 2: Update `addComment` to accept a parent id**

Replace lines 42-45:

```ts
  async function addComment(blockId: string) {
    const body = commentDraft.trim(); if (!body) return; setBusy(true); const response = await fetch(`/api/client/contracts/${contractId}/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ blockId, body }) }); const result = await response.json() as { error?: string }; setBusy(false);
    if (!response.ok) { setMessageType("error"); setMessage(result.error ?? "Unable to add comment"); return; } setCommentDraft(""); setCommentingId(null); setMessageType("success"); setMessage("Comment added to the paragraph discussion."); await loadWorkspace();
  }
```

with:

```ts
  async function addComment(blockId: string, parentCommentId: string | null) {
    const body = commentDraft.trim(); if (!body) return; setBusy(true); const response = await fetch(`/api/client/contracts/${contractId}/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ blockId, body, parentCommentId: parentCommentId ?? undefined }) }); const result = await response.json() as { error?: string }; setBusy(false);
    if (!response.ok) { setMessageType("error"); setMessage(result.error ?? "Unable to add comment"); return; } setCommentDraft(""); setCommentingId(null); setReplyingId(null); setMessageType("success"); setMessage(parentCommentId ? "Reply added to the thread." : "Comment added to the paragraph discussion."); await loadWorkspace();
  }
```

- [ ] **Step 3: Replace the thread rendering and composer**

Replace line 69-70:

```tsx
          {comments.length > 0 && <div className="paragraph-thread">{comments.map((comment) => <article key={comment.id} className={comment.status}><div><strong>{comment.author_display}</strong><span>{new Date(comment.created_at).toLocaleString()}</span></div><p>{comment.body}</p><small>{comment.status}</small></article>)}</div>}
          {commentingId === block.id && <div className="paragraph-comment-composer"><label htmlFor={`comment-${block.id}`}>Add to this paragraph discussion</label><textarea id={`comment-${block.id}`} value={commentDraft} maxLength={5000} onChange={(event) => setCommentDraft(event.target.value)} rows={3}/><div><button onClick={() => setCommentingId(null)}>Cancel</button><button disabled={busy || !commentDraft.trim()} onClick={() => void addComment(block.id)}>Post comment</button></div></div>}
```

with:

```tsx
          {comments.length > 0 && <div className="paragraph-thread">{comments.filter((comment) => !comment.parent_comment_id).map((root) => <article key={root.id} className={`thread ${root.status}`}><div><strong>{root.author_display}</strong><span>{new Date(root.created_at).toLocaleString()}</span></div><p>{root.body}</p>
            {comments.filter((reply) => reply.parent_comment_id === root.id).map((reply) => <div className="thread-reply" key={reply.id}><div><strong>{reply.author_display}</strong><span>{new Date(reply.created_at).toLocaleString()}</span></div><p>{reply.body}</p></div>)}
            {root.status === "resolved" ? <p className="thread-resolution"><small>Resolved{root.resolution_reason ? `: ${root.resolution_reason}` : ""}</small></p> : !locked && !clientAgreed && <button className="thread-reply-trigger" onClick={() => { setReplyingId(replyingId === root.id ? null : root.id); setCommentingId(null); setCommentDraft(""); }}>Reply</button>}
            {replyingId === root.id && <div className="paragraph-comment-composer"><textarea value={commentDraft} maxLength={5000} onChange={(event) => setCommentDraft(event.target.value)} rows={2}/><div><button onClick={() => setReplyingId(null)}>Cancel</button><button disabled={busy || !commentDraft.trim()} onClick={() => void addComment(block.id, root.id)}>Post reply</button></div></div>}
          </article>)}</div>}
          {commentingId === block.id && <div className="paragraph-comment-composer"><label htmlFor={`comment-${block.id}`}>Add to this paragraph discussion</label><textarea id={`comment-${block.id}`} value={commentDraft} maxLength={5000} onChange={(event) => setCommentDraft(event.target.value)} rows={3}/><div><button onClick={() => setCommentingId(null)}>Cancel</button><button disabled={busy || !commentDraft.trim()} onClick={() => void addComment(block.id, null)}>Post comment</button></div></div>}
```

- [ ] **Step 4: Update the comment-count trigger to count roots only**

Replace line 67's comment-trigger button:

```tsx
          {!locked && !clientAgreed && block.kind !== "title" && <button className="paragraph-comment-trigger" onClick={() => { setCommentingId(commentingId === block.id ? null : block.id); setCommentDraft(""); }}>Comment {comments.length ? `(${comments.length})` : ""}</button>}
```

with:

```tsx
          {!locked && !clientAgreed && block.kind !== "title" && <button className="paragraph-comment-trigger" onClick={() => { setCommentingId(commentingId === block.id ? null : block.id); setReplyingId(null); setCommentDraft(""); }}>Comment {comments.filter((comment) => !comment.parent_comment_id).length ? `(${comments.filter((comment) => !comment.parent_comment_id).length})` : ""}</button>}
```

- [ ] **Step 5: Manually verify in the browser**

Run `npm run dev`, open `http://localhost:3000/review/sample-services-agreement`, sign in with `client.reviewer` / `ReviewDemo!2026`, post a comment, then (from the owner console in another tab) reply to it as owner, refresh the reviewer page, and confirm the reply appears nested.

- [ ] **Step 6: Commit**

```bash
git add app/review/\[contractId\]/page.tsx
git commit -m "feat: render nested comment threads with replies in the reviewer portal"
```

---

### Task 6: Lifecycle transition rules

**Files:**
- Modify: `lib/workflow.ts:4` (add transition graphs)
- Modify: `app/api/contracts/[contractId]/lifecycle/route.ts`

**Interfaces:**
- Produces: `LIFECYCLE_TRANSITIONS`, `LIFECYCLE_FORWARD_TRANSITIONS`, `isValidLifecycleTransition(current, next, locked): boolean`, exported from `lib/workflow.ts`. The `PATCH` lifecycle route now returns `400` for any transition not in the applicable graph, and `409` for moving to `approved` with pending proposals/approvals. Task 11 (e2e lifecycle-failure spec) depends on these exact rules.

- [ ] **Step 1: Add the transition graphs to `lib/workflow.ts`**

Replace line 4:

```ts
export const LIFECYCLE_STAGES = ["draft", "internal_review", "external_review", "approved", "executed", "expired", "renewed"] as const;
```

with:

```ts
export const LIFECYCLE_STAGES = ["draft", "internal_review", "external_review", "approved", "executed", "expired", "renewed"] as const;
export type LifecycleStage = typeof LIFECYCLE_STAGES[number];

export const LIFECYCLE_TRANSITIONS: Record<LifecycleStage, LifecycleStage[]> = {
  draft: ["internal_review"],
  internal_review: ["external_review", "draft"],
  external_review: ["approved", "internal_review"],
  approved: ["executed", "external_review"],
  executed: ["renewed", "expired"],
  expired: ["renewed"],
  renewed: [],
};

export const LIFECYCLE_FORWARD_TRANSITIONS: Record<LifecycleStage, LifecycleStage[]> = {
  draft: ["internal_review"],
  internal_review: ["external_review"],
  external_review: ["approved"],
  approved: ["executed"],
  executed: ["renewed", "expired"],
  expired: ["renewed"],
  renewed: [],
};

export function isValidLifecycleTransition(current: LifecycleStage, next: LifecycleStage, locked: boolean): boolean {
  if (current === next) return true;
  const graph = locked ? LIFECYCLE_FORWARD_TRANSITIONS : LIFECYCLE_TRANSITIONS;
  return graph[current].includes(next);
}
```

- [ ] **Step 2: Enforce the graph in the lifecycle route**

In `app/api/contracts/[contractId]/lifecycle/route.ts`, replace line 3:

```ts
import { LIFECYCLE_STAGES, ownerContract, RISK_LEVELS } from "@/lib/workflow";
```

with:

```ts
import { isValidLifecycleTransition, LIFECYCLE_STAGES, type LifecycleStage, ownerContract, RISK_LEVELS } from "@/lib/workflow";
```

Replace lines 13-15:

```ts
  const stage = String(body.lifecycleStage ?? contract.lifecycle_stage); const risk = String(body.riskLevel ?? contract.risk_level);
  if (!LIFECYCLE_STAGES.includes(stage as never) || !RISK_LEVELS.includes(risk as never)) return Response.json({ error: "Invalid lifecycle stage or risk level" }, { status: 400 });
  if (stage === "executed" && contract.status !== "locked") return Response.json({ error: "Lock the agreed document before marking it executed" }, { status: 409 });
```

with:

```ts
  const stage = String(body.lifecycleStage ?? contract.lifecycle_stage); const risk = String(body.riskLevel ?? contract.risk_level);
  if (!LIFECYCLE_STAGES.includes(stage as never) || !RISK_LEVELS.includes(risk as never)) return Response.json({ error: "Invalid lifecycle stage or risk level" }, { status: 400 });
  const currentStage = String(contract.lifecycle_stage) as LifecycleStage; const nextStage = stage as LifecycleStage; const locked = contract.status === "locked";
  if (!isValidLifecycleTransition(currentStage, nextStage, locked)) return Response.json({ error: locked ? "Locked contracts can only move forward in the lifecycle" : `Invalid lifecycle transition from ${currentStage} to ${nextStage}` }, { status: 400 });
  if (nextStage === "approved" && currentStage !== "approved") {
    const pending = await env.DB.prepare("SELECT COUNT(*) AS total FROM paragraph_proposals WHERE contract_id=? AND status='pending'").bind(contractId).first<{ total: number }>();
    if ((pending?.total ?? 0) > 0) return Response.json({ error: "Resolve every pending proposal before marking the contract approved" }, { status: 409 });
    const incompleteApprovals = await env.DB.prepare("SELECT COUNT(*) AS total FROM approval_requests WHERE contract_id=? AND version_number=? AND required=1 AND status!='approved'").bind(contractId, contract.current_version).first<{ total: number }>();
    if ((incompleteApprovals?.total ?? 0) > 0) return Response.json({ error: "Complete every required approval before marking the contract approved" }, { status: 409 });
  }
  if (stage === "executed" && contract.status !== "locked") return Response.json({ error: "Lock the agreed document before marking it executed" }, { status: 409 });
```

- [ ] **Step 2: Manually verify with curl**

With `npm run dev` running and demo reset (`curl -X POST http://localhost:3000/api/demo/reset -H "Host: localhost:3000"`):

```bash
curl -s -X PATCH http://localhost:3000/api/contracts/sample-services-agreement/lifecycle -H "Host: localhost:3000" -H "content-type: application/json" -d '{"lifecycleStage":"approved"}'
```

Expected: `400` — the seeded stage is `external_review`, and jumping straight to `approved` while proposals/approvals guards aren't even reached is fine either way, but note the exact rejection reason should be the pending-approval one if `external_review → approved` is attempted directly (it's a valid *edge* in the graph, so this specific call tests the 409 guard, not the 400 graph check — that's expected and correct: `external_review → approved` is graph-valid, so the 400 case instead needs e.g. `{"lifecycleStage":"executed"}` which is not reachable from `external_review`). Try both and confirm each returns the expected status.

- [ ] **Step 3: Commit**

```bash
git add lib/workflow.ts app/api/contracts/\[contractId\]/lifecycle/route.ts
git commit -m "feat: enforce lifecycle transition graph and post-lock forward-only rule"
```

---

### Task 7: Redline — stable anchors and version metadata

**Files:**
- Modify: `lib/workflow.ts` (`compareVersions`)

**Interfaces:**
- Produces: `compareVersions()` now returns `{ from: { number, createdAt, author }, to: { number, createdAt, author }, blocks: [{ ..., anchorId }], changedCount }`. Task 8 (UI) depends on `anchorId` and `from.author`/`to.author`.

- [ ] **Step 1: Update `compareVersions` and add a `safeAnchorId` helper**

In `lib/workflow.ts`, replace the `compareVersions` function (originally lines 35-50):

```ts
export async function compareVersions(contractId: string, from: number, to: number) {
  const versions = await env.DB.prepare("SELECT version_number,snapshot,created_at FROM contract_versions WHERE contract_id=? AND version_number IN (?,?) ORDER BY version_number").bind(contractId, from, to).all<{ version_number: number; snapshot: unknown; created_at: string }>();
  const fromVersion = versions.results.find((item) => item.version_number === from);
  const toVersion = versions.results.find((item) => item.version_number === to);
  if (!fromVersion || !toVersion) return null;
  const oldBlocks = parseSnapshot(fromVersion.snapshot); const newBlocks = parseSnapshot(toVersion.snapshot);
  const oldByKey = new Map(oldBlocks.map((block) => [block.block_key || block.id, block]));
  const newByKey = new Map(newBlocks.map((block) => [block.block_key || block.id, block]));
  const keys = [...new Set([...oldByKey.keys(), ...newByKey.keys()])];
  const blocks = keys.map((key) => {
    const oldBlock = oldByKey.get(key); const newBlock = newByKey.get(key);
    const originalText = oldBlock?.current_text ?? ""; const proposedText = newBlock?.current_text ?? "";
    return { key, kind: newBlock?.kind ?? oldBlock?.kind ?? "body", orderIndex: newBlock?.order_index ?? oldBlock?.order_index ?? 0, originalText, proposedText, changed: originalText !== proposedText, diff: diffText(originalText, proposedText) };
  }).sort((a, b) => a.orderIndex - b.orderIndex);
  return { from: { number: fromVersion.version_number, createdAt: fromVersion.created_at }, to: { number: toVersion.version_number, createdAt: toVersion.created_at }, blocks, changedCount: blocks.filter((block) => block.changed).length };
}
```

with:

```ts
function safeAnchorId(value: string) {
  const slug = value.replace(/[^a-zA-Z0-9_-]/g, "-");
  return /^[0-9]/.test(slug) ? `b-${slug}` : slug;
}

export async function compareVersions(contractId: string, from: number, to: number) {
  const versions = await env.DB.prepare("SELECT version_number,snapshot,created_at,created_by FROM contract_versions WHERE contract_id=? AND version_number IN (?,?) ORDER BY version_number").bind(contractId, from, to).all<{ version_number: number; snapshot: unknown; created_at: string; created_by: string | null }>();
  const fromVersion = versions.results.find((item) => item.version_number === from);
  const toVersion = versions.results.find((item) => item.version_number === to);
  if (!fromVersion || !toVersion) return null;
  const authorIds = [fromVersion.created_by, toVersion.created_by].filter((id): id is string => Boolean(id));
  const authorRows = authorIds.length ? await env.DB.prepare(`SELECT id,display_name FROM users WHERE id IN (${authorIds.map(() => "?").join(",")})`).bind(...authorIds).all<{ id: string; display_name: string }>() : { results: [] as Array<{ id: string; display_name: string }> };
  const authorNames = new Map(authorRows.results.map((row) => [row.id, row.display_name]));
  const authorName = (id: string | null) => (id && authorNames.get(id)) || "Unknown author";
  const oldBlocks = parseSnapshot(fromVersion.snapshot); const newBlocks = parseSnapshot(toVersion.snapshot);
  const oldByKey = new Map(oldBlocks.map((block) => [block.block_key || block.id, block]));
  const newByKey = new Map(newBlocks.map((block) => [block.block_key || block.id, block]));
  const keys = [...new Set([...oldByKey.keys(), ...newByKey.keys()])];
  const blocks = keys.map((key) => {
    const oldBlock = oldByKey.get(key); const newBlock = newByKey.get(key);
    const originalText = oldBlock?.current_text ?? ""; const proposedText = newBlock?.current_text ?? "";
    return { key, anchorId: safeAnchorId(newBlock?.id ?? oldBlock?.id ?? key), kind: newBlock?.kind ?? oldBlock?.kind ?? "body", orderIndex: newBlock?.order_index ?? oldBlock?.order_index ?? 0, originalText, proposedText, changed: originalText !== proposedText, diff: diffText(originalText, proposedText) };
  }).sort((a, b) => a.orderIndex - b.orderIndex);
  return { from: { number: fromVersion.version_number, createdAt: fromVersion.created_at, author: authorName(fromVersion.created_by) }, to: { number: toVersion.version_number, createdAt: toVersion.created_at, author: authorName(toVersion.created_by) }, blocks, changedCount: blocks.filter((block) => block.changed).length };
}
```

- [ ] **Step 2: Manually verify with curl**

With `npm run dev` running and demo reset, there's only version 1 initially, so first accept a proposal to create version 2 (or just call compare with `from=1&to=1` to sanity-check the shape):

```bash
curl -s "http://localhost:3000/api/contracts/sample-services-agreement/versions/compare?from=1&to=1" -H "Host: localhost:3000"
```

Expected: `200` with `from.author` and `to.author` both present as strings (either a real display name or `"Unknown author"`), and every block having a non-empty `anchorId`.

- [ ] **Step 3: Commit**

```bash
git add lib/workflow.ts
git commit -m "feat: add stable anchor ids and author metadata to version comparison"
```

---

### Task 8: Redline UI — version picker metadata, side-by-side mode, jump-to-change

**Files:**
- Modify: `app/workflow/[contractId]/page.tsx`
- Modify: `app/globals.css` (append)

**Interfaces:**
- Consumes: Task 7's `anchorId`/`author` fields.
- Note: the version picker already lists *every* version in `workspace.versions` (not just the latest two) — this was verified while planning; "compare any two versions" required no change here, only the metadata/anchor/mode work below.

- [ ] **Step 1: Update the `Comparison` type and add mode state**

Replace line 19:

```ts
type Comparison = { changedCount: number; blocks: Array<{ key: string; kind: string; changed: boolean; diff: { original: Segment[]; proposed: Segment[] } }> };
```

with:

```ts
type Comparison = { changedCount: number; from: { number: number; createdAt: string; author: string }; to: { number: number; createdAt: string; author: string }; blocks: Array<{ key: string; anchorId: string; kind: string; changed: boolean; diff: { original: Segment[]; proposed: Segment[] } }> };
```

Add a new state line directly after line 36 (the `commentBlock`/`comparison`/`showAll` state line):

```ts
  const [redlineMode, setRedlineMode] = useState<"unified" | "side-by-side">("unified");
```

- [ ] **Step 2: Replace the redline-card section**

Replace lines 85-86 (the entire `<section className="workflow-card redline-card">...</section>` block) with:

```tsx
      <section className="workflow-card redline-card"><CardHead eyebrow="Immutable snapshots" heading="Full-document redline" badge={comparison ? `${comparison.changedCount} changed paragraphs` : "Choose versions"}/><div className="workflow-inline"><VersionSelect value={fromVersion} versions={workspace.versions} onChange={setFromVersion}/><span>→</span><VersionSelect value={toVersion} versions={workspace.versions} onChange={setToVersion}/><button disabled={busy || fromVersion === toVersion} onClick={() => void compare()}>Compare</button></div>
        {comparison && <>
          <div className="redline-meta"><span>Version {comparison.from.number} · {new Date(comparison.from.createdAt).toLocaleString()} · {comparison.from.author}</span><span>→</span><span>Version {comparison.to.number} · {new Date(comparison.to.createdAt).toLocaleString()} · {comparison.to.author}</span></div>
          <div className="workflow-inline redline-toolbar"><label className="workflow-check"><input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)}/> Show unchanged paragraphs</label><div className="redline-mode"><button className={redlineMode === "unified" ? "active" : ""} onClick={() => setRedlineMode("unified")}>Unified</button><button className={redlineMode === "side-by-side" ? "active" : ""} onClick={() => setRedlineMode("side-by-side")}>Side-by-side</button></div></div>
          {comparison.changedCount > 0 && <nav className="jump-to-change"><span>Jump to change:</span>{comparison.blocks.filter((block) => block.changed).map((block, index) => <a key={block.anchorId} href={`#${block.anchorId}`}>{index + 1}</a>)}</nav>}
          <div className={`redline-document ${redlineMode}`}>{redlineBlocks.map((block, index) => <article key={block.anchorId} id={block.anchorId} className={block.changed ? "changed" : "unchanged"}><small>{index + 1} · {title(block.kind)}</small><div>{redlineMode === "unified" ? <><p>{block.diff.original.map((segment, item) => segment.changed ? <del key={item}>{segment.text}</del> : <span key={item}>{segment.text}</span>)}</p><p>{block.diff.proposed.map((segment, item) => segment.changed ? <ins key={item}>{segment.text}</ins> : <span key={item}>{segment.text}</span>)}</p></> : <><p className="redline-original">{block.diff.original.map((segment, item) => segment.changed ? <del key={item}>{segment.text}</del> : <span key={item}>{segment.text}</span>)}</p><p className="redline-proposed">{block.diff.proposed.map((segment, item) => segment.changed ? <ins key={item}>{segment.text}</ins> : <span key={item}>{segment.text}</span>)}</p></>}</div></article>)}</div>
        </>}
      </section>
```

- [ ] **Step 3: Append CSS for the new redline elements**

Append to the end of `app/globals.css` (after Task 4's additions):

```css
.redline-meta{display:flex;justify-content:space-between;gap:12px;font-size:.85em;color:var(--muted);margin:8px 0}
.redline-toolbar{justify-content:space-between}
.redline-mode{display:flex;gap:4px}
.redline-mode button{border:1px solid var(--line);background:transparent;border-radius:6px;padding:4px 10px}
.redline-mode button.active{font-weight:600;background:var(--mint)}
.jump-to-change{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:8px 0;font-size:.85em}
.jump-to-change a{padding:2px 8px;border:1px solid var(--line);border-radius:999px;color:var(--forest)}
.redline-document.side-by-side article>div{display:grid;grid-template-columns:1fr 1fr;gap:12px}
```

- [ ] **Step 4: Manually verify in the browser**

Run `npm run dev`, open `http://localhost:3000/workflow/sample-services-agreement`, select version 1 for both From/To, click Compare, confirm the version/author metadata line renders, toggle Side-by-side, and (once a second version exists from an accepted proposal) confirm "Jump to change" links scroll to the right paragraph.

- [ ] **Step 5: Commit**

```bash
git add app/workflow/\[contractId\]/page.tsx app/globals.css
git commit -m "feat: add redline version metadata, side-by-side mode, and jump-to-change"
```

---

### Task 9: Playwright scaffolding

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/e2e/fixtures.ts`
- Modify: `vite.config.ts` (isolated e2e persistence path)
- Modify: `package.json` (add `test:e2e` script and devDependency)

**Interfaces:**
- Produces: `BASE_URL` (exported from `playwright.config.ts`), `resetDemo()`, `DEMO_CONTRACT_ID`, `REVIEWER_USERNAME`, `REVIEWER_PASSWORD` (exported from `tests/e2e/fixtures.ts`). Tasks 10–12 depend on these.

- [ ] **Step 1: Install Playwright**

```bash
npm install -D @playwright/test
npx playwright install chromium
```

Verify `package.json`'s `devDependencies` now includes `@playwright/test`.

- [ ] **Step 2: Add the `test:e2e` script**

In `package.json`, replace line 13 (`"lint": "eslint . --ignore-pattern dist --ignore-pattern .next",`) with:

```json
    "lint": "eslint . --ignore-pattern dist --ignore-pattern .next",
    "test:e2e": "playwright test",
```

- [ ] **Step 3: Isolate e2e Miniflare persistence**

In `vite.config.ts`, replace lines 62-65:

```ts
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
```

with:

```ts
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
        persistState: process.env.PACTLINE_E2E === "true" ? { path: ".wrangler/state-e2e" } : true,
      }),
```

(`.wrangler/` is already covered by the existing `/.wrangler/` entry in `.gitignore` — no gitignore change needed.)

- [ ] **Step 4: Create `playwright.config.ts`**

```ts
import { defineConfig, devices } from "@playwright/test";

const PORT = 4319;
export const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { PACTLINE_E2E: "true" },
  },
});
```

- [ ] **Step 5: Create `tests/e2e/fixtures.ts`**

This step also bootstraps the isolated local D1 database with all Drizzle migrations. This is required, not defensive: per the Global Constraints note on local D1, nothing in this repo auto-applies migrations to a Miniflare-local D1 instance — confirmed by hands-on testing during Task 2, where a completely fresh `.wrangler/state` directory produced `D1_ERROR: no such table` on the very first query. The isolated `.wrangler/state-e2e` directory this task's `vite.config.ts` change creates would hit the exact same error on every e2e run without this bootstrap.

```ts
import { request as playwrightRequest } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { BASE_URL } from "../../playwright.config";

export const DEMO_CONTRACT_ID = "sample-services-agreement";
export const REVIEWER_USERNAME = "client.reviewer";
export const REVIEWER_PASSWORD = "ReviewDemo!2026";

const D1_DIR = ".wrangler/state-e2e/v3/d1/miniflare-D1DatabaseObject";
let migrated = false;

function migrateLocalD1(): void {
  if (migrated) return;
  if (!existsSync(D1_DIR)) throw new Error(`Local D1 directory not found at ${D1_DIR} — the Playwright webServer should have created it by the time a test runs. Is PACTLINE_E2E=true reaching vite.config.ts?`);
  const dbFile = readdirSync(D1_DIR).find((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite");
  if (!dbFile) throw new Error(`No local D1 sqlite file found under ${D1_DIR}`);
  const db = new DatabaseSync(`${D1_DIR}/${dbFile}`);
  db.exec("PRAGMA foreign_keys=ON");
  const alreadyMigrated = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='contracts'").all().length > 0;
  if (!alreadyMigrated) {
    for (const file of readdirSync("drizzle").filter((name) => /^\d{4}.*\.sql$/.test(name)).sort()) {
      db.exec(readFileSync(`drizzle/${file}`, "utf8").replaceAll("--> statement-breakpoint", ""));
    }
  }
  db.close();
  migrated = true;
}

export async function resetDemo(): Promise<void> {
  migrateLocalD1();
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { host: `localhost:${new URL(BASE_URL).port}` } });
  const response = await context.post("/api/demo/reset");
  if (!response.ok()) throw new Error(`Demo reset failed: ${response.status()} ${await response.text()}`);
  await context.dispose();
}
```

Notes on this design:
- `migrateLocalD1()` is safe to call from every `resetDemo()` invocation across every spec file: a module-level `migrated` flag makes it a no-op after the first call within one Playwright worker process (this suite runs with `workers: 1`, so there is exactly one such process), and the `alreadyMigrated` table check makes it idempotent even if that assumption ever changes.
- The explicit `host` header on the request context is defensive — Playwright's `request.newContext` already sends a correct `Host` header derived from `baseURL` for a plain `localhost` URL, but setting it explicitly guarantees the owner-auth localhost fallback in `app/chatgpt-auth.ts` — which checks `host.startsWith("localhost:")` — matches regardless of how the request context resolves the header.
- `D1_DIR` assumes `getPersistenceRoot` (inside `@cloudflare/vite-plugin`, confirmed by reading its source during planning) resolves `persistState: { path: ".wrangler/state-e2e" }` to `<repo root>/.wrangler/state-e2e/v3`, with Miniflare's own `d1/miniflare-D1DatabaseObject/` subdirectory beneath that — this exact shape was confirmed against the default (non-e2e) `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/` path while diagnosing Task 2. If Step 6 below fails with "Local D1 directory not found," print `find .wrangler/state-e2e -iname "*.sqlite"` (after a first `webServer` boot) to see the actual path Miniflare chose and correct `D1_DIR`.

- [ ] **Step 6: Verify the scaffold boots**

Run: `npx playwright test --list`
Expected: exits without error (no spec files exist yet, so it should print "no tests found" rather than a config error — a config error here means Step 3/4 has a mistake to fix before continuing).

- [ ] **Step 7: Commit**

```bash
git add playwright.config.ts tests/e2e/fixtures.ts vite.config.ts package.json package-lock.json
git commit -m "feat: scaffold isolated Playwright e2e test environment"
```

---

### Task 10: E2E happy-path spec

**Files:**
- Create: `tests/e2e/happy-path.spec.ts`

**Interfaces:**
- Consumes: Tasks 1–9 (every Phase 1 feature) plus the pre-existing owner-editor page (`app/page.tsx`) for proposal counter/accept and owner agreement, which this task reads just enough of to script correctly.

- [ ] **Step 1: Confirm the two button/label facts this spec depends on**

Two facts from `app/page.tsx` were confirmed while planning via `tests/rendered-html.test.mjs`'s existing assertions (`assert.match(page, /Accept change/)`, `assert.match(page, /Counter propose/)`, `assert.match(page, /Reject/)`), so the proposal-resolution buttons are named exactly `"Accept change"`, `"Counter propose"`, `"Reject"`. The owner's agree button was not read in full during planning (the file is very large); its handler `agreeAsOwner()` shows a `window.confirm(...)` dialog before submitting. Before writing the spec, run:

```bash
grep -n "agreeAsOwner\|Approve version\|Agree to" app/page.tsx
```

and open the surrounding JSX to get the exact button text, then use that exact string in Step 3 below in place of the placeholder regex `/Approve|Agree/i`. If it's already an exact literal (not a template with dynamic text), use `getByRole('button', { name: 'Exact Text' })` instead of the regex — regex only if the button label is dynamic (e.g. changes based on `clientAgreed`).

- [ ] **Step 2: Write the spec**

```ts
import { expect, test } from "@playwright/test";
import { DEMO_CONTRACT_ID, resetDemo, REVIEWER_PASSWORD, REVIEWER_USERNAME } from "./fixtures";

test.describe.serial("owner and reviewer happy path", () => {
  test.beforeAll(async () => { await resetDemo(); });

  test("review round, comment, propose, counter, approve, lock, transition, amend, export calendar", async ({ page, context }) => {
    page.on("dialog", (dialog) => void dialog.accept());

    // Review round: close the seeded open round, then open a new one.
    await page.goto(`/workflow/${DEMO_CONTRACT_ID}`);
    await expect(page.getByRole("heading", { name: "Demo Master Services Agreement" })).toBeVisible();
    await page.getByPlaceholder("All requested changes have been addressed.").fill("Initial pass complete.");
    await page.getByRole("button", { name: "Close review round" }).click();
    await expect(page.getByRole("status")).toContainText("Review round closed.");
    await page.getByRole("button", { name: "Open next review round" }).click();
    await expect(page.getByRole("status")).toContainText("New review round opened.");

    // Owner adds a comment.
    await page.getByPlaceholder("Explain the business or legal concern…").fill("Please confirm the payment terms are acceptable.");
    await page.getByRole("button", { name: "Add comment" }).click();
    await expect(page.getByRole("status")).toContainText("Comment added.");

    // Reviewer signs in (second browser context) and proposes a change.
    const reviewerPage = await context.newPage();
    await reviewerPage.goto(`/review/${DEMO_CONTRACT_ID}`);
    await reviewerPage.locator("#review-username").fill(REVIEWER_USERNAME);
    await reviewerPage.locator("#review-password").fill(REVIEWER_PASSWORD);
    await reviewerPage.getByRole("button", { name: "Sign in securely" }).click();
    await expect(reviewerPage.getByText("Pactline client review")).toBeVisible();
    const feesParagraph = reviewerPage.locator(".paragraph-content", { hasText: "Owner Company will perform the services in a professional" });
    await feesParagraph.click();
    await reviewerPage.locator('textarea[id^="review-block-"]').fill("Owner Company will perform the services in a professional, workmanlike, and timely manner using qualified personnel.");
    await reviewerPage.getByRole("button", { name: "Submit proposed changes" }).click();
    await expect(reviewerPage.getByText(/proposed change.*sent to the contract owner/)).toBeVisible();

    // Owner counters the proposal from the main editor.
    await page.goto("/");
    await page.getByRole("button", { name: "Counter propose" }).first().click();
    const counterBox = page.locator("textarea").filter({ hasText: "" }).last();
    await counterBox.fill("Owner Company will perform the services in a professional and workmanlike manner using qualified, appropriately experienced personnel.");
    await page.getByRole("button", { name: "Counter propose" }).last().click();
    await expect(page.getByText("Counterproposal sent back to the reviewer.")).toBeVisible();

    // Owner requires and approves an internal approval.
    await page.goto(`/workflow/${DEMO_CONTRACT_ID}`);
    await page.getByRole("button", { name: "Add requirement" }).click();
    await expect(page.getByRole("status")).toContainText("approval required.");
    await page.getByPlaceholder("Approved because the position is within policy.").fill("Standard services terms, within policy.");
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByRole("status")).toContainText("Approval recorded.");

    // Move the lifecycle stage back to external_review (the approval requirement forced internal_review), then to approved.
    await page.getByLabel("Lifecycle stage").selectOption("external_review");
    await page.getByRole("button", { name: "Save lifecycle details" }).click();
    await expect(page.getByRole("status")).toContainText("Lifecycle details saved");
    await page.getByLabel("Lifecycle stage").selectOption("approved");
    await page.getByRole("button", { name: "Save lifecycle details" }).click();
    await expect(page.getByRole("status")).toContainText("Lifecycle details saved");

    // Mutual agreement locks the contract.
    await page.goto("/");
    await page.getByRole("button", { name: /Approve version|Agree/ }).click();
    await expect(page.getByText(/agreement is recorded|final document is locked/)).toBeVisible();
    await reviewerPage.reload();
    await reviewerPage.getByRole("button", { name: /Agree to this version|Review owner counter/ }).click();
    await expect(reviewerPage.getByText(/final document is locked/)).toBeVisible();

    // approved -> executed now that the contract is locked.
    await page.goto(`/workflow/${DEMO_CONTRACT_ID}`);
    await page.getByLabel("Lifecycle stage").selectOption("executed");
    await page.getByRole("button", { name: "Save lifecycle details" }).click();
    await expect(page.getByRole("status")).toContainText("Lifecycle details saved");

    // Amendment.
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Create amendment" }).click();
    await expect(page).toHaveURL(/\/workflow\/(?!sample-services-agreement)/);

    // Calendar export.
    await page.goto(`/workflow/${DEMO_CONTRACT_ID}`);
    const [download] = await Promise.all([
      page.waitForResponse((response) => response.url().includes("/calendar") && response.status() === 200),
      page.getByRole("link", { name: "Export .ics" }).click(),
    ]);
    expect(download.headers()["content-type"]).toContain("text/calendar");
    const body = await download.text();
    expect(body).toContain("BEGIN:VCALENDAR");
  });
});
```

- [ ] **Step 3: Run the spec and fix any selector mismatches**

Run: `npx playwright test tests/e2e/happy-path.spec.ts --headed`

This is a long, multi-stage flow — expect to iterate here. If a locator times out, Playwright's error names the exact locator and shows a screenshot; open `npx playwright show-trace` on the failed run's trace (written under `test-results/` because of `trace: "retain-on-failure"`) to see the actual DOM and correct the selector. In particular:
- The `agreeAsOwner()` button name regex (`/Approve version|Agree/`) should be tightened to the exact text found in Step 1 once confirmed.
- The counter-proposal textarea locator (`page.locator("textarea").filter(...).last()`) is a best-effort guess at the counter-proposal composer in `app/page.tsx`'s proposal review rail — replace it with a precise locator (e.g. by a `placeholder` or `id` attribute) once you've inspected that section of the file.

Expected once selectors are corrected: PASS, and the test log shows every stage's success message.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/happy-path.spec.ts
git commit -m "test: add e2e happy path covering the full contract workflow"
```

---

### Task 11: E2E lifecycle-failure spec

**Files:**
- Create: `tests/e2e/lifecycle-failures.spec.ts`

**Interfaces:**
- Consumes: Task 6's `isValidLifecycleTransition`/route guards.

- [ ] **Step 1: Write the spec**

```ts
import { expect, test } from "@playwright/test";
import { DEMO_CONTRACT_ID, resetDemo } from "./fixtures";

test.describe("lifecycle transition failures", () => {
  test.beforeEach(async () => { await resetDemo(); });

  test("rejects a jump that skips stages", async ({ page }) => {
    await page.goto(`/workflow/${DEMO_CONTRACT_ID}`);
    await page.getByLabel("Lifecycle stage").selectOption("executed");
    await page.getByRole("button", { name: "Save lifecycle details" }).click();
    await expect(page.getByRole("status")).toContainText(/Lock the agreed document/);
  });

  test("rejects moving to approved with a pending required approval", async ({ page }) => {
    await page.goto(`/workflow/${DEMO_CONTRACT_ID}`);
    await page.getByRole("button", { name: "Add requirement" }).click();
    await expect(page.getByRole("status")).toContainText("approval required.");
    await page.getByLabel("Lifecycle stage").selectOption("external_review");
    await page.getByRole("button", { name: "Save lifecycle details" }).click();
    await page.getByLabel("Lifecycle stage").selectOption("approved");
    await page.getByRole("button", { name: "Save lifecycle details" }).click();
    await expect(page.getByRole("status")).toContainText(/required approval/);
  });

  test("a reviewer session cannot open the owner lifecycle route", async ({ request }) => {
    const loginResponse = await request.post("/api/client/login", { data: { username: "client.reviewer", password: "ReviewDemo!2026" } });
    expect(loginResponse.ok()).toBeTruthy();
    const response = await request.patch(`/api/contracts/${DEMO_CONTRACT_ID}/lifecycle`, { data: { lifecycleStage: "approved" } });
    expect(response.status()).toBe(403);
  });
});
```

- [ ] **Step 2: Run and verify**

Run: `npx playwright test tests/e2e/lifecycle-failures.spec.ts`
Expected: 3 passed. If the first two UI assertions fail on the exact status message text, adjust the `toContainText` regex to match what the server actually returns (the server-side strings are defined in Task 6's route code and are authoritative — fix the test's expected text, not the route).

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/lifecycle-failures.spec.ts
git commit -m "test: add e2e coverage for rejected lifecycle transitions"
```

---

### Task 12: E2E API edge-case spec

**Files:**
- Create: `tests/e2e/api/edge-cases.spec.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, 6 (route behavior) plus the existing, unmodified `paragraph-proposals/[id]/resolve`, `agree`, and portal document download routes.

This task also fixes two real environment-driven scope corrections found during planning (documented here so the implementer doesn't "fix" them back):
- The owner-route 401 case ("no credential at all") is **not reachable** against this local dev server: `app/chatgpt-auth.ts` auto-resolves a fixed local owner whenever the request's `Host` header starts with `localhost:` or `127.0.0.1:`, with no way to disable that in local/e2e mode. 401 is instead exercised via the reviewer/portal routes (`getClientSession`/`getPortalSession` returning `null` for no cookie), which is the reachable, correct place to prove the 401 branch.
- "Expired session token" is tested with a syntactically-invalid cookie value rather than a genuinely time-expired one (waiting 8 hours, or fabricating a pre-expired DB row with no test-accessible tool to do so, isn't practical) — both hit the exact same `getClientSession`/`getPortalSession` null-return branch and produce the same 401, so this is representative coverage of the same code path and behavior, not a weaker substitute for a different one.

- [ ] **Step 1: Write the spec**

```ts
import { expect, test } from "@playwright/test";
import { DEMO_CONTRACT_ID, resetDemo, REVIEWER_PASSWORD, REVIEWER_USERNAME } from "../fixtures";

test.describe("API authorization and edge cases", () => {
  test.beforeEach(async () => { await resetDemo(); });

  test("no cookie on a client route returns 401", async ({ request }) => {
    const response = await request.post(`/api/client/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { blockId: "x", body: "test" } });
    expect(response.status()).toBe(401);
  });

  test("no cookie on a portal route returns 401", async ({ request }) => {
    const response = await request.get("/api/portal/workspace");
    expect(response.status()).toBe(401);
  });

  test("a garbage client cookie returns 401 (equivalent to an expired session)", async ({ request }) => {
    const response = await request.post(`/api/client/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { blockId: "x", body: "test" }, headers: { cookie: "__Host-pactline_client=not-a-real-token" } });
    expect(response.status()).toBe(401);
  });

  test("a reviewer session on an owner-only comments action returns 403", async ({ request }) => {
    await request.post("/api/client/login", { data: { username: REVIEWER_USERNAME, password: REVIEWER_PASSWORD } });
    const response = await request.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "reopen", commentId: "does-not-matter" } });
    expect(response.status()).toBe(403);
  });

  test("a client session against a contract it doesn't own returns 404", async ({ request }) => {
    await request.post("/api/client/login", { data: { username: REVIEWER_USERNAME, password: REVIEWER_PASSWORD } });
    const response = await request.post("/api/client/contracts/not-the-demo-contract/comments", { data: { blockId: "x", body: "test" } });
    expect(response.status()).toBe(404);
  });

  test("a portal session with no active grant for a contract returns 404", async ({ request }) => {
    const loginResponse = await request.post("/api/portal/login", { data: { username: "supplier.reviewer", password: "SupplierDemo!2026" } });
    expect(loginResponse.ok()).toBeTruthy();
    const response = await request.post("/api/portal/contracts/not-a-granted-contract/comments", { data: { blockId: "x", body: "test" } });
    expect(response.status()).toBe(404);
  });

  test("a malformed DOCX upload returns 400", async ({ request }) => {
    const response = await request.post(`/api/contracts/${DEMO_CONTRACT_ID}/documents`, {
      multipart: { document: { name: "broken.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from("not a real docx zip") } },
    });
    expect(response.status()).toBe(400);
  });

  test("downloading a nonexistent portal document returns 404, not 500", async ({ request }) => {
    await request.post("/api/portal/login", { data: { username: "supplier.reviewer", password: "SupplierDemo!2026" } });
    const response = await request.get("/api/portal/documents/00000000-0000-0000-0000-000000000000/download");
    expect(response.status()).toBe(404);
  });

  test.describe("comment thread edge cases", () => {
    async function addRootComment(request: import("@playwright/test").APIRequestContext, blockId: string, body: string) {
      const response = await request.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "add", blockId, body } });
      expect(response.status()).toBe(201);
      return ((await response.json()) as { comment: { id: string } }).comment.id;
    }

    test("reply targeting a nonexistent parent returns 400", async ({ request }) => {
      const response = await request.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "reply", blockId: "sample-block-6", parentCommentId: "00000000-0000-0000-0000-000000000000", body: "reply" } });
      expect(response.status()).toBe(400);
    });

    test("reply targeting a different paragraph than its parent returns 400", async ({ request }) => {
      const rootId = await addRootComment(request, "sample-block-6", "root on block 6");
      const response = await request.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "reply", blockId: "sample-block-8", parentCommentId: rootId, body: "wrong block" } });
      expect(response.status()).toBe(400);
    });

    test("reply on a resolved thread returns 409", async ({ request }) => {
      const rootId = await addRootComment(request, "sample-block-6", "root to resolve");
      const resolveResponse = await request.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "resolve", commentId: rootId, reason: "Addressed in v2." } });
      expect(resolveResponse.status()).toBe(200);
      const replyResponse = await request.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "reply", blockId: "sample-block-6", parentCommentId: rootId, body: "too late" } });
      expect(replyResponse.status()).toBe(409);
    });

    test("resolve without a reason returns 400", async ({ request }) => {
      const rootId = await addRootComment(request, "sample-block-6", "root needs a reason");
      const response = await request.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "resolve", commentId: rootId } });
      expect(response.status()).toBe(400);
    });

    test("replying to a reply (not a root) returns 400", async ({ request }) => {
      const rootId = await addRootComment(request, "sample-block-6", "root for nested reply test");
      const replyResponse = await request.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "reply", blockId: "sample-block-6", parentCommentId: rootId, body: "first reply" } });
      expect(replyResponse.status()).toBe(201);
      const replyId = ((await replyResponse.json()) as { comment: { id: string } }).comment.id;
      const nestedResponse = await request.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "reply", blockId: "sample-block-6", parentCommentId: replyId, body: "reply to a reply" } });
      expect(nestedResponse.status()).toBe(400);
    });
  });

  test("resolving an already-resolved proposal returns 409", async ({ request }) => {
    await request.post("/api/client/login", { data: { username: REVIEWER_USERNAME, password: REVIEWER_PASSWORD } });
    const proposeResponse = await request.post(`/api/client/contracts/${DEMO_CONTRACT_ID}/proposals`, { data: { baseVersion: 1, edits: [{ blockId: "sample-block-6", originalText: "Owner Company will perform the services in a professional and workmanlike manner using personnel with appropriate skills and experience.", proposedText: "Owner Company will perform the services in a professional and workmanlike manner using qualified personnel." }] } });
    expect(proposeResponse.status()).toBe(201);
    const proposalId = ((await proposeResponse.json()) as { proposals: Array<{ id: string }> }).proposals[0].id;
    const firstResolve = await request.post(`/api/contracts/${DEMO_CONTRACT_ID}/paragraph-proposals/${proposalId}/resolve`, { data: { action: "accept", reason: "Looks correct." } });
    expect(firstResolve.status()).toBe(200);
    const secondResolve = await request.post(`/api/contracts/${DEMO_CONTRACT_ID}/paragraph-proposals/${proposalId}/resolve`, { data: { action: "accept", reason: "Looks correct." } });
    expect(secondResolve.status()).toBe(409);
  });

  test("mutating a locked contract returns 409", async ({ request }) => {
    const ownerAgree = await request.post(`/api/contracts/${DEMO_CONTRACT_ID}/agree`);
    expect(ownerAgree.ok()).toBeTruthy();
    await request.post("/api/client/login", { data: { username: REVIEWER_USERNAME, password: REVIEWER_PASSWORD } });
    const reviewerAgree = await request.post(`/api/client/contracts/${DEMO_CONTRACT_ID}/agree`);
    const reviewerAgreeBody = (await reviewerAgree.json()) as { locked?: boolean };
    expect(reviewerAgreeBody.locked).toBe(true);
    const proposeResponse = await request.post(`/api/client/contracts/${DEMO_CONTRACT_ID}/proposals`, { data: { baseVersion: 1, edits: [{ blockId: "sample-block-6", originalText: "Owner Company will perform the services in a professional and workmanlike manner using personnel with appropriate skills and experience.", proposedText: "Different text." }] } });
    expect(proposeResponse.status()).toBe(409);
  });
});
```

- [ ] **Step 2: Run and fix any mismatches**

Run: `npx playwright test tests/e2e/api/edge-cases.spec.ts`
Expected: all tests pass. If the "malformed DOCX upload" test doesn't return exactly `400` (e.g. it returns `415` because the filename check runs first, or the parser error path returns a different code), adjust the assertion to match the route's actual, already-correct behavior from Task-untouched code (`app/api/contracts/[contractId]/documents/route.ts`) — do not change that route to force a particular code, since its existing validation order is out of Phase 1 scope.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/api/edge-cases.spec.ts
git commit -m "test: add e2e API edge-case coverage for the authorization contract"
```

---

### Task 13: Final verification and PR

**Files:** none (verification and PR only)

- [ ] **Step 1: Run the full existing suite**

```bash
npm test
```

Expected: PASS (all 7 existing test files, including Task 1's updated `database.test.mjs` assertions).

- [ ] **Step 2: Run the full e2e suite**

```bash
npm run test:e2e
```

Expected: PASS (happy path, lifecycle failures, edge cases). Capture the terminal summary (pass count, duration) to paste into the PR description.

- [ ] **Step 3: Run lint**

```bash
npm run lint
```

Fix any new lint errors introduced by Tasks 1–12 before proceeding.

- [ ] **Step 4: Push the branch**

```bash
git push -u origin feature/workflow-hardening-phase-1
```

- [ ] **Step 5: Open the PR (do not merge)**

```bash
gh pr create --base codex/version-two-expansion --head feature/workflow-hardening-phase-1 --title "Phase 1: workflow hardening (comment threads, lifecycle rules, redline, e2e)" --body "$(cat <<'EOF'
## Summary

Implements Phase 1 of the workflow-hardening handoff list (see `docs/superpowers/specs/2026-08-18-contract-workflow-hardening-design.md`):

- **Item 1 — Real e2e tests:** new Playwright suite (`tests/e2e/`) drives the owner and reviewer UI through review-round creation, commenting, proposing/countering, approving, mutual-agreement locking, forward lifecycle transitions, amendment creation, and `.ics` export — plus two UI-level lifecycle-rejection cases. Runs isolated from any developer's local dev state (`workers: 1`, dedicated `.wrangler/state-e2e` Miniflare persistence, never a remote binding).
- **Item 2 — Comment threading:** two-level threads (root + flat replies), owner-only reason-required resolve that cascades to replies, owner-only reopen that cascades back, and a committed 400/409 validation contract for replies (foreign/nonexistent parent, cross-paragraph parent, reply-to-reply, reply-on-resolved-thread).
- **Item 4 — Lifecycle transition rules:** an explicit transition graph enforced server-side (400 on invalid jumps), a separate forward-only graph once a contract is locked (no backward moves post-lock), and 409 guards requiring proposals/approvals resolved before `approved`.
- **Item 8 — Redline upgrade:** stable DOM anchor ids (paragraph id, not the human `block_key`), a unified/side-by-side view toggle, version/date/author metadata with an "Unknown author" fallback, and a "jump to change" list. (The any-two-version picker already existed.)
- **Item 9 — Edge-case coverage:** a committed HTTP status-code contract (401 unauthenticated, 403 insufficient permission, 404 no relationship to the resource — including a fix so the client/portal comment routes stop collapsing that into 403 — 409 stale/locked mutation, 404 missing R2 object), tested via Playwright's `request` fixture since the existing `node:test` files don't execute route code.

## Test plan

- [x] `npm test` — <PASTE PASS/FAIL SUMMARY FROM STEP 1 HERE>
- [x] `npm run test:e2e` — <PASTE PASS/FAIL SUMMARY FROM STEP 2 HERE>
- [x] `npm run lint` — clean

## Migrations

- One new migration (`drizzle/<generated-filename-from-task-1>`): adds `paragraph_comments.resolution_reason`, `.reopened_by`, `.reopened_at` (all nullable) and index `idx_paragraph_comments_parent`. Additive only — no FK, no backfill, no data loss on deploy. Treated as forward-only; a future correction would be a new migration, not a column drop (dropping would discard real resolution/reopen history).

## Known limitations / explicitly out of scope for Phase 1

- The v2 supplier portal (`app/portal/page.tsx`) has no comment UI at all yet (discovered during implementation — its `Review` type doesn't include `comments`). The portal comment API (reply validation, 404/403 contract) is fully implemented and ready; only the UI is deferred.
- Owner-side 401 (no credential at all) is not exercised by the e2e suite — the local dev server's owner auth always resolves a fixed local identity on `localhost`, so that branch is structurally unreachable in this environment; 401 coverage instead targets the reviewer/portal routes.
- Phase 2 (notifications, monitoring coverage, amendment-chain UI, release dashboard) and Phase 3 (multi-person approvals) are unimplemented, per the approved phased plan — see the spec doc.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Fill in the actual `npm test`/`npm run test:e2e` output summaries from Steps 1–2 before running this command. Confirm the PR was created and **do not merge it**.
