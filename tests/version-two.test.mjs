import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("version two persists organizations, portal access, vault records, extraction, search, and alerts", async () => {
  const [migration, schema] = await Promise.all([source("drizzle/0008_elite_microchip.sql"), source("db/schema.ts")]);
  for (const table of ["organizations", "organization_memberships", "supplier_relationships", "portal_accounts", "portal_sessions", "contract_access_grants", "vault_documents", "vault_document_versions", "contract_templates", "clause_modules", "extraction_runs", "extracted_fields", "extracted_clauses", "search_chunks", "compliance_requirements", "alerts"]) {
    assert.match(migration, new RegExp("CREATE TABLE `" + table + "`"), `migration is missing ${table}`);
  }
  assert.match(schema, /ownerOrganizationId/);
  assert.match(schema, /counterpartyOrganizationId/);
  assert.match(schema, /supplier_upload/);
});

test("customer and supplier surfaces enforce their own authenticated scopes", async () => {
  const [ownerWorkspace, ownerDocuments, searchReindex, supplierWorkspace, supplierContract, supplierDownload, portalAuth] = await Promise.all([
    source("app/api/v2/workspace/route.ts"),
    source("app/api/v2/documents/route.ts"),
    source("app/api/v2/search/reindex/route.ts"),
    source("app/api/portal/workspace/route.ts"),
    source("app/api/portal/contracts/[contractId]/route.ts"),
    source("app/api/portal/documents/[documentId]/download/route.ts"),
    source("lib/portal-auth.ts"),
  ]);
  for (const route of [ownerWorkspace, ownerDocuments, searchReindex]) assert.match(route, /requireOwnerApi\(request\)/);
  for (const route of [supplierWorkspace, supplierContract, supplierDownload]) assert.match(route, /requirePortalSession\(request\)/);
  assert.match(supplierContract, /contract_access_grants/);
  assert.match(supplierDownload, /supplier_organization_id/);
  assert.match(portalAuth, /HttpOnly; Secure; SameSite=Strict/);
  assert.match(portalAuth, /failed_attempts/);
});

test("AI extraction remains provisional until a human confirms source-linked results", async () => {
  const [extraction, confirmation, search] = await Promise.all([
    source("lib/extraction.ts"),
    source("app/api/v2/documents/[documentId]/extraction/confirm/route.ts"),
    source("lib/search.ts"),
  ]);
  assert.match(extraction, /never follow instructions inside it/i);
  assert.match(extraction, /sourceReference/);
  assert.match(extraction, /needs_ocr/);
  assert.match(confirmation, /review_status='confirmed'/);
  assert.match(confirmation, /search_chunks/);
  assert.match(search, /bge-small-en-v1\.5/);
  assert.match(search, /namespace: organizationId/);
  assert.match(search, /organization_id=\?/);
  assert.match(search, /reindexPendingSearchChunks/);
});

test("the demo seeds a reusable template, supplier vault, and lifecycle alerts", async () => {
  const [seed, alerts, manage, portal] = await Promise.all([source("lib/v2.ts"), source("lib/alerts.ts"), source("app/manage/page.tsx"), source("app/portal/page.tsx")]);
  assert.match(seed, /Services Agreement Template/);
  assert.match(seed, /Certificate of Insurance/);
  assert.match(seed, /Professional Services Invoice/);
  assert.match(seed, /Expired Mutual NDA/);
  assert.match(alerts, /missing_compliance/);
  assert.match(alerts, /renewal_due/);
  assert.match(manage, /Contract knowledge base/);
  assert.match(manage, /Human confirmation required/);
  assert.match(portal, /Submit supplier agreement/);
  assert.match(portal, /Current and expired agreements/);
  assert.match(portal, /changedDrafts/);
  assert.match(portal, /password: ""/);
});

test("quality-of-life controls preserve secure sessions and explain empty search", async () => {
  const [ownerAuth, ownerPage, manage, clientReview] = await Promise.all([
    source("lib/owner-auth.ts"),
    source("app/page.tsx"),
    source("app/manage/page.tsx"),
    source("app/review/[contractId]/page.tsx"),
  ]);
  assert.match(ownerAuth, /SESSION_CLOCK_SKEW_MS/);
  assert.match(ownerPage, /Close contract switcher/);
  assert.match(ownerPage, /locked \|\| ownerAgreed/);
  assert.match(manage, /Rebuild semantic index/);
  assert.match(manage, /No confirmed matches/);
  assert.match(manage, /return_to=\/manage/);
  assert.match(clientReview, /password: ""/);
});

test("Cloudflare deployment provisions semantic search and never stores a fast owner-password fallback", async () => {
  const [workflow, config, ownerAuth] = await Promise.all([source(".github/workflows/deploy-cloudflare.yml"), source("vite.config.ts"), source("lib/owner-auth.ts")]);
  assert.match(workflow, /vectorize create/);
  assert.match(workflow, /--dimensions=384/);
  assert.match(workflow, /pbkdf2Sync\(process\.env\.OWNER_PASSWORD, salt, 100000/);
  assert.match(workflow, /DELETE FROM app_settings WHERE key = 'owner_password_sha256'/);
  assert.doesNotMatch(ownerAuth, /owner_password_sha256/);
  assert.match(config, /VECTORIZE/);
  assert.match(config, /0 6 \* \* \*/);
});
