import { expect, request as playwrightRequest, test } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { BASE_URL } from "../../../playwright.config";
import { DEMO_CONTRACT_ID, resetDemo, REVIEWER_PASSWORD, REVIEWER_USERNAME } from "../fixtures";

// The seeded v2 supplier-portal demo account (lib/v2.ts's DEMO_PORTAL_USERNAME /
// DEMO_PORTAL_PASSWORD). Not re-exported from fixtures.ts, so it is hardcoded
// here against the actual seed source rather than trusted from the brief.
const PORTAL_USERNAME = "supplier.reviewer";
const PORTAL_PASSWORD = "SupplierDemo!2026";

// A minimal, structurally valid .docx package built with the same zip library
// the server uses to parse uploads (fflate — see lib/docx-server.ts). Used to
// create a real, non-demo contract so the "malformed upload" test below can
// exercise the actual parseDocxBytes() failure path (400) instead of being
// short-circuited by the documents route's demo-contract guard (403).
function validDocxBuffer(): Buffer {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Sample paragraph text for edge case contract creation.</w:t></w:r></w:p></w:body></w:document>`,
    ),
  };
  return Buffer.from(zipSync(files, { level: 6 }));
}

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
    // Logging in on the same `request` context leaves the client-session
    // cookie attached to every subsequent call, including this one — that's
    // the point of this test: requireOwnerApi() (lib/owner-boundary.ts) denies
    // any request carrying a client-session cookie before it ever reaches
    // owner-route logic, regardless of the (absent) owner credential.
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
    const loginResponse = await request.post("/api/portal/login", { data: { username: PORTAL_USERNAME, password: PORTAL_PASSWORD } });
    expect(loginResponse.ok()).toBeTruthy();
    const response = await request.post("/api/portal/contracts/not-a-granted-contract/comments", { data: { blockId: "x", body: "test" } });
    expect(response.status()).toBe(404);
  });

  test("a malformed DOCX upload returns 400", async ({ request }) => {
    // Uploading to DEMO_CONTRACT_ID would hit the documents route's
    // demo-contract guard (app/api/contracts/[contractId]/documents/route.ts:
    // `if (contractId === DEMO_CONTRACT_ID) return ... 403`) before the parser
    // ever runs, so a malformed-DOCX assertion against the demo contract would
    // actually observe 403, not 400 — that guard, not the parser, would be
    // under test. Create a real, non-demo contract first (with a minimal valid
    // .docx) so the malformed upload below reaches parseDocxBytes() and
    // exercises the actual parse-failure 400 path.
    const createResponse = await request.post("/api/contracts", {
      multipart: {
        title: "Edge Case Contract",
        document: { name: "valid.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: validDocxBuffer() },
      },
    });
    expect(createResponse.status()).toBe(201);
    const { contract } = (await createResponse.json()) as { contract: { id: string } };

    const response = await request.post(`/api/contracts/${contract.id}/documents`, {
      multipart: { document: { name: "broken.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from("not a real docx zip") } },
    });
    expect(response.status()).toBe(400);
  });

  test("downloading a nonexistent portal document returns 404, not 500", async ({ request }) => {
    await request.post("/api/portal/login", { data: { username: PORTAL_USERNAME, password: PORTAL_PASSWORD } });
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
    // The proposal must be submitted by a reviewer (client-session cookie),
    // but the resolve endpoint is owner-only and requireOwnerApi() denies any
    // request carrying a client-session cookie (see the 403 test above). Doing
    // the login + propose on the shared `request` fixture would leave that
    // cookie attached to the resolve calls below and get a 403 "Owner
    // permission required" instead of ever reaching the accept logic — so the
    // reviewer steps run in a separate, disposable request context, exactly as
    // happy-path.spec.ts isolates the reviewer's browser context from the
    // owner's for the same reason.
    const reviewerContext = await playwrightRequest.newContext({ baseURL: BASE_URL });
    const loginResponse = await reviewerContext.post("/api/client/login", { data: { username: REVIEWER_USERNAME, password: REVIEWER_PASSWORD } });
    expect(loginResponse.ok()).toBeTruthy();
    const proposeResponse = await reviewerContext.post(`/api/client/contracts/${DEMO_CONTRACT_ID}/proposals`, { data: { baseVersion: 1, edits: [{ blockId: "sample-block-6", originalText: "Owner Company will perform the services in a professional and workmanlike manner using personnel with appropriate skills and experience.", proposedText: "Owner Company will perform the services in a professional and workmanlike manner using qualified personnel." }] } });
    expect(proposeResponse.status()).toBe(201);
    const proposalId = ((await proposeResponse.json()) as { proposals: Array<{ id: string }> }).proposals[0].id;
    await reviewerContext.dispose();

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
