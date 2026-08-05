import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("defines the persistent generic Pactline workspace", async () => {
  const [page, layout, demo] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/demo.ts", import.meta.url), "utf8"),
  ]);
  assert.match(layout, /Pactline/);
  assert.match(page, /Private Word document/);
  assert.match(page, /Share access/);
  assert.match(page, /Reset generic demo/);
  assert.match(page, /\/api\/workspace/);
  assert.match(demo, /Sample Services Agreement/);
  for (const removedName of ["Alex Kim", "Maya Chen", "Brightline", "Northstar"]) assert.doesNotMatch(page + demo, new RegExp(removedName));
  assert.doesNotMatch(page, /react-loading-skeleton|codex-preview/);
});

test("stores Word uploads separately from structured contract data", async () => {
  const [createRoute, uploadRoute, parser, hosting] = await Promise.all([
    readFile(new URL("../app/api/contracts/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/contracts/[contractId]/documents/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/docx-server.ts", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
  ]);
  assert.match(hosting, /"d1": "DB"/);
  assert.match(hosting, /"r2": "DOCUMENTS"/);
  assert.match(createRoute, /env\.DOCUMENTS\.put/);
  assert.match(uploadRoute, /contract_versions/);
  assert.match(parser, /word\/vbaProject\.bin/);
  assert.match(parser, /valid DOCX package/);
});

test("supports durable paragraph proposals and immutable owner decisions", async () => {
  const [page, clientPage, proposalRoute, resolutionRoute] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/review/[contractId]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/client/contracts/[contractId]/proposals/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/contracts/[contractId]/paragraph-proposals/[proposalId]/resolve/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(clientPage, /Submit proposed changes/);
  assert.match(page, /Accept change/);
  assert.match(page, /Reject/);
  assert.match(proposalRoute, /The document changed during your review/);
  assert.match(resolutionRoute, /contract_versions/);
  assert.match(resolutionRoute, /paragraph_proposal\.accepted/);
});

test("locks only the version agreed by both parties and supports final downloads", async () => {
  const [agreements, ownerAgree, clientAgree, ownerDownload, clientDownload] = await Promise.all([
    readFile(new URL("../lib/agreements.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/contracts/[contractId]/agree/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/client/contracts/[contractId]/agree/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/contracts/[contractId]/download/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/client/contracts/[contractId]/download/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(agreements, /COUNT\(DISTINCT party_id\)/);
  assert.match(agreements, /status='locked'/);
  assert.match(ownerAgree, /ensureFinalDocument/);
  assert.match(clientAgree, /recordCounterpartyAgreement/);
  assert.match(ownerDownload, /document\.downloaded/);
  assert.match(clientDownload, /final document is available after both parties agree/i);
});

test("retains the security controls for reviewer sessions", async () => {
  const [migration, security, clientAuth, accessRoute] = await Promise.all([
    readFile(new URL("../drizzle/0002_even_captain_britain.sql", import.meta.url), "utf8"),
    readFile(new URL("../lib/security.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/client-auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/contracts/[contractId]/access/route.ts", import.meta.url), "utf8"),
  ]);
  for (const table of ["document_blocks", "paragraph_proposals", "access_sessions"]) assert.ok(migration.includes(`CREATE TABLE \`${table}\``), `missing ${table} table`);
  assert.match(security, /PBKDF2/);
  assert.match(security, /210_000/);
  assert.match(clientAuth, /HttpOnly; Secure; SameSite=Strict/);
  assert.match(clientAuth, /failed_attempts < 8/);
  assert.match(accessRoute, /temporaryPassword/);
});
