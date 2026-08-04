import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("defines the Pactline contract workspace", async () => {
  const [page, layout] = await Promise.all([readFile(new URL("../app/page.tsx", import.meta.url), "utf8"), readFile(new URL("../app/layout.tsx", import.meta.url), "utf8")]);
  assert.match(layout, /Pactline — Contract collaboration/);
  assert.match(page, /Master Services Agreement/);
  assert.match(page, /Share access/);
  assert.match(page, /Stable clause controls/);
  assert.match(page, /AI-structured proposal/);
  assert.match(page, /Paragraph-level editing/);
  assert.match(page, /Preview client view/);
  assert.match(page, /submitClientChanges/);
  assert.match(page, /Use this document/);
  assert.doesNotMatch(page, /Your site is taking shape|react-loading-skeleton|codex-preview/);
});

test("uses natural Word paragraphs and client-proposed edits", async () => {
  const [page, docx] = await Promise.all([readFile(new URL("../app/page.tsx", import.meta.url), "utf8"), readFile(new URL("../lib/docx.ts", import.meta.url), "utf8")]);
  assert.match(docx, /createDocumentDocx/);
  assert.match(docx, /DocumentBlock/);
  assert.match(docx, /w:pStyle/);
  assert.match(page, /Stage proposal/);
  assert.match(page, /before: blocks\.find/);
  assert.match(page, /The original stays unchanged until Northstar accepts/);
});

test("keeps security-sensitive credentials out of static source", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const envExample = await readFile(new URL("../.env.example", import.meta.url), "utf8");
  assert.doesNotMatch(page, /Pact-BL2048|sk-[A-Za-z0-9]/);
  assert.match(page, /crypto\.getRandomValues/);
  assert.match(page, /navigator\.clipboard\.writeText/);
  assert.match(page, /aria-modal="true"/);
  assert.match(page, /event\.key === "Escape"/);
  assert.doesNotMatch(envExample, /NEXT_PUBLIC_(AI|CRM|NOTIFICATIONS|ONLYOFFICE)/);
});

test("migration enforces stable clauses, versions, accounts, and audit storage", async () => {
  const migration = await readFile(new URL("../drizzle/0000_worthless_tombstone.sql", import.meta.url), "utf8");
  for (const table of ["contracts", "clauses", "contract_versions", "proposed_changes", "access_accounts", "agreements", "document_objects", "audit_log_entries"]) assert.ok(migration.includes(`CREATE TABLE \`${table}\``), `missing ${table} table`);
  assert.match(migration, /CREATE UNIQUE INDEX `idx_clauses_contract_key`/);
  assert.match(migration, /CREATE UNIQUE INDEX `idx_contract_versions_number`/);
  assert.match(migration, /`password_hash` text NOT NULL/);
  assert.match(migration, /`before_hash` text/);
  assert.match(migration, /`after_hash` text/);
});

test("production hardening includes durable paragraph review and client sessions", async () => {
  const [migration, security, clientAuth, proposalRoute] = await Promise.all([
    readFile(new URL("../drizzle/0002_even_captain_britain.sql", import.meta.url), "utf8"),
    readFile(new URL("../lib/security.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/client-auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/client/contracts/[contractId]/proposals/route.ts", import.meta.url), "utf8"),
  ]);
  for (const table of ["document_blocks", "paragraph_proposals", "access_sessions"]) assert.ok(migration.includes(`CREATE TABLE \`${table}\``), `missing ${table} table`);
  assert.match(security, /PBKDF2/);
  assert.match(security, /210_000/);
  assert.match(clientAuth, /HttpOnly; Secure; SameSite=Strict/);
  assert.match(clientAuth, /failed_attempts < 8/);
  assert.match(proposalRoute, /The document changed during your review/);
  assert.match(proposalRoute, /paragraph changed during your review/);
});
