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
  assert.match(page, /preferredId \|\| activeId \|\| nextContracts\[0\]\?\.id/);
  assert.match(page, /visibilitychange/);
  assert.match(demo, /Demo Master Services Agreement/);
  assert.match(page, /Upload your DOCX/);
  assert.match(page, /Download demo DOCX/);
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
  assert.match(createRoute, /15 \* 1024 \* 1024/);
  assert.match(uploadRoute, /contract_versions/);
  assert.doesNotMatch(uploadRoute, /file\.type !== DOCX_TYPE/);
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
  assert.match(page, /Counter propose/);
  assert.match(page, /Reject/);
  assert.match(page, /scrollIntoView/);
  assert.match(page, /openReviewQueue/);
  assert.match(clientPage, /Owner counterproposal/);
  assert.match(proposalRoute, /The document changed during your review/);
  assert.match(resolutionRoute, /contract_versions/);
  assert.match(resolutionRoute, /paragraph_proposal\.accepted/);
  assert.match(resolutionRoute, /paragraph_proposal\.countered/);
  assert.match(resolutionRoute, /counter_text/);
  assert.doesNotMatch(resolutionRoute, /p\.base_version=c\.current_version/);
  assert.match(resolutionRoute, /status='superseded'/);
  assert.match(resolutionRoute, /SET base_version=\?/);
});

test("rejects reviewer sessions at the owner API boundary", async () => {
  const [boundary, resolution, aiApply, ownerDownload] = await Promise.all([
    readFile(new URL("../lib/owner-boundary.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/contracts/[contractId]/paragraph-proposals/[proposalId]/resolve/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/contracts/[contractId]/ai-suggestions/apply/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/contracts/[contractId]/download/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(boundary, /getClientSession\(request\)/);
  assert.match(boundary, /Owner permission required/);
  assert.match(boundary, /status: 403/);
  for (const route of [resolution, aiApply, ownerDownload]) assert.match(route, /requireOwnerApi\(request\)/);
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
  assert.match(security, /100_000/);
  assert.match(clientAuth, /HttpOnly; Secure; SameSite=Strict/);
  assert.match(clientAuth, /failed_attempts < 8/);
  assert.match(accessRoute, /temporaryPassword/);
});

test("provides an owner-only, human-confirmed Groq contract assistant", async () => {
  const [page, assistant, applyRoute, provider, workflow, clientPage, assetHeaders] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/contracts/[contractId]/ai-assistant/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/contracts/[contractId]/ai-suggestions/apply/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/ai-assistant.ts", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/deploy-cloudflare.yml", import.meta.url), "utf8"),
    readFile(new URL("../app/review/[contractId]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../public/_headers", import.meta.url), "utf8"),
  ]);
  assert.match(page, /Contract assistant/);
  assert.match(page, /I understand and continue/);
  assert.match(page, /Apply as new version/);
  assert.match(page, /Nothing is applied automatically/);
  assert.match(assistant, /requireOwnerApi/);
  assert.match(assistant, /acknowledgedExternalProcessing/);
  assert.match(assistant, /20/);
  assert.match(assistant, /ai\.assistant_invoked/);
  assert.match(provider, /api\.groq\.com/);
  assert.match(provider, /json_schema/);
  assert.match(provider, /strict: true/);
  assert.match(provider, /openai\/gpt-oss-120b/);
  assert.match(applyRoute, /Resolve pending client proposals/);
  assert.match(applyRoute, /contract_versions/);
  assert.match(applyRoute, /ai\.paragraph_rewritten/);
  assert.match(applyRoute, /ai\.clause_inserted/);
  assert.match(workflow, /wrangler secret put GROQ_API_KEY/);
  assert.match(assetHeaders, /max-age=0, must-revalidate/);
  assert.doesNotMatch(clientPage, /Contract assistant|ai-assistant|Ask AI/);
  assert.doesNotMatch(page, />Insert after</);
  assert.match(page, />Place after</);
});

test("keeps the document grid and AI drawer contained at intermediate widths", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.document-workspace \.content-grid \{ grid-template-columns:minmax\(0,1fr\) minmax\(300px,390px\)/);
  assert.match(css, /\.ai-drawer \{[^}]*overflow:hidden;[^}]*overscroll-behavior:contain/);
  assert.match(css, /\.ai-conversation \{[^}]*min-height:0;[^}]*overflow-y:auto;[^}]*overscroll-behavior:contain/);
});
