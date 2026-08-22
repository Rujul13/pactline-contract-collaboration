import { expect, request as playwrightRequest, test } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { BASE_URL } from "../../../playwright.config";
import { DEMO_CONTRACT_ID, resetDemo, REVIEWER_PASSWORD, REVIEWER_USERNAME } from "../fixtures";

const PORTAL_USERNAME = "supplier.reviewer";
const PORTAL_PASSWORD = "SupplierDemo!2026";

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

async function createIsolatedContext() {
  return playwrightRequest.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });
}

test.describe("API authorization and edge cases", () => {
  test.beforeEach(async () => { await resetDemo(); });

  test("no cookie on a client route returns 401", async () => {
    const unauthContext = await createIsolatedContext();
    const response = await unauthContext.post(`/api/client/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { blockId: "x", body: "test" } });
    expect(response.status()).toBe(401);
    await unauthContext.dispose();
  });

  test("no cookie on a portal route returns 401", async () => {
    const unauthContext = await createIsolatedContext();
    const response = await unauthContext.get("/api/portal/workspace");
    expect(response.status()).toBe(401);
    await unauthContext.dispose();
  });

  test("a garbage client cookie returns 401 (equivalent to an expired session)", async () => {
    const unauthContext = await createIsolatedContext();
    const response = await unauthContext.post(`/api/client/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { blockId: "x", body: "test" }, headers: { cookie: "__Host-pactline_client=not-a-real-token" } });
    expect(response.status()).toBe(401);
    await unauthContext.dispose();
  });

  test("a reviewer session on an owner-only comments action returns 403", async () => {
    const reviewerContext = await createIsolatedContext();
    await reviewerContext.post("/api/client/login", { data: { username: REVIEWER_USERNAME, password: REVIEWER_PASSWORD } });
    const response = await reviewerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "reopen", commentId: "does-not-matter" } });
    expect(response.status()).toBe(403);
    await reviewerContext.dispose();
  });

  test("a client session against a contract it doesn't own returns 404", async () => {
    const clientContext = await createIsolatedContext();
    await clientContext.post("/api/client/login", { data: { username: REVIEWER_USERNAME, password: REVIEWER_PASSWORD } });
    const response = await clientContext.post("/api/client/contracts/not-the-demo-contract/comments", { data: { blockId: "x", body: "test" } });
    expect(response.status()).toBe(404);
    await clientContext.dispose();
  });

  test("a portal session with no active grant for a contract returns 404", async () => {
    const portalContext = await createIsolatedContext();
    const loginResponse = await portalContext.post("/api/portal/login", { data: { username: PORTAL_USERNAME, password: PORTAL_PASSWORD } });
    expect(loginResponse.ok()).toBeTruthy();
    const response = await portalContext.post("/api/portal/contracts/not-a-granted-contract/comments", { data: { blockId: "x", body: "test" } });
    expect(response.status()).toBe(404);
    await portalContext.dispose();
  });

  test("a malformed DOCX upload returns 400", async () => {
    const ownerContext = await createIsolatedContext();
    const createResponse = await ownerContext.post("/api/contracts", {
      multipart: {
        title: "Edge Case Contract",
        document: { name: "valid.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: validDocxBuffer() },
      },
    });
    expect(createResponse.status()).toBe(201);
    const { contract } = (await createResponse.json()) as { contract: { id: string } };

    const response = await ownerContext.post(`/api/contracts/${contract.id}/documents`, {
      multipart: { document: { name: "broken.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from("not a real docx zip") } },
    });
    expect(response.status()).toBe(400);
    await ownerContext.dispose();
  });

  test("downloading a nonexistent portal document returns 404, not 500", async () => {
    const portalContext = await createIsolatedContext();
    await portalContext.post("/api/portal/login", { data: { username: PORTAL_USERNAME, password: PORTAL_PASSWORD } });
    const response = await portalContext.get("/api/portal/documents/00000000-0000-0000-0000-000000000000/download");
    expect(response.status()).toBe(404);
    await portalContext.dispose();
  });

  test.describe("comment thread edge cases", () => {
    async function addRootComment(ctx: import("@playwright/test").APIRequestContext, blockId: string, body: string) {
      const response = await ctx.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "add", blockId, body } });
      expect(response.status()).toBe(201);
      return ((await response.json()) as { comment: { id: string } }).comment.id;
    }

    test("reply targeting a nonexistent parent returns 400", async () => {
      const ownerContext = await createIsolatedContext();
      const response = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "reply", blockId: "sample-block-6", parentCommentId: "00000000-0000-0000-0000-000000000000", body: "reply" } });
      expect(response.status()).toBe(400);
      await ownerContext.dispose();
    });

    test("reply targeting a different paragraph than its parent returns 400", async () => {
      const ownerContext = await createIsolatedContext();
      const rootId = await addRootComment(ownerContext, "sample-block-6", "root on block 6");
      const response = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "reply", blockId: "sample-block-8", parentCommentId: rootId, body: "wrong block" } });
      expect(response.status()).toBe(400);
      await ownerContext.dispose();
    });

    test("reply on a resolved thread returns 409", async () => {
      const ownerContext = await createIsolatedContext();
      const rootId = await addRootComment(ownerContext, "sample-block-6", "root to resolve");
      const resolveResponse = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "resolve", commentId: rootId, reason: "Addressed in v2." } });
      expect(resolveResponse.status()).toBe(200);
      const replyResponse = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "reply", blockId: "sample-block-6", parentCommentId: rootId, body: "too late" } });
      expect(replyResponse.status()).toBe(409);
      await ownerContext.dispose();
    });

    test("resolve without a reason returns 400", async () => {
      const ownerContext = await createIsolatedContext();
      const rootId = await addRootComment(ownerContext, "sample-block-6", "root needs a reason");
      const response = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "resolve", commentId: rootId } });
      expect(response.status()).toBe(400);
      await ownerContext.dispose();
    });

    test("replying to a reply (not a root) returns 400", async () => {
      const ownerContext = await createIsolatedContext();
      const rootId = await addRootComment(ownerContext, "sample-block-6", "root for nested reply test");
      const replyResponse = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "reply", blockId: "sample-block-6", parentCommentId: rootId, body: "first reply" } });
      expect(replyResponse.status()).toBe(201);
      const replyId = ((await replyResponse.json()) as { comment: { id: string } }).comment.id;
      const nestedResponse = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "reply", blockId: "sample-block-6", parentCommentId: replyId, body: "reply to a reply" } });
      expect(nestedResponse.status()).toBe(400);
      await ownerContext.dispose();
    });

    test("reply using a parent comment from a different contract returns 400", async () => {
      const ownerContext = await createIsolatedContext();
      const createResponse = await ownerContext.post("/api/contracts", {
        multipart: {
          title: "Cross-Contract Parent Isolation Test",
          document: { name: "valid.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: validDocxBuffer() },
        },
      });
      expect(createResponse.status()).toBe(201);
      const { contract: contractB } = (await createResponse.json()) as { contract: { id: string } };

      const rootIdOnContractA = await addRootComment(ownerContext, "sample-block-6", "root on contract A");

      const response = await ownerContext.post(`/api/contracts/${contractB.id}/comments`, {
        data: { action: "reply", blockId: "sample-block-6", parentCommentId: rootIdOnContractA, body: "cross-contract reply attempt" },
      });
      expect(response.status()).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("not found on this contract");
      await ownerContext.dispose();
    });
  });

  test("resolving an already-resolved proposal returns 409", async () => {
    const reviewerContext = await createIsolatedContext();
    const loginResponse = await reviewerContext.post("/api/client/login", { data: { username: REVIEWER_USERNAME, password: REVIEWER_PASSWORD } });
    expect(loginResponse.ok()).toBeTruthy();
    const proposeResponse = await reviewerContext.post(`/api/client/contracts/${DEMO_CONTRACT_ID}/proposals`, { data: { baseVersion: 1, edits: [{ blockId: "sample-block-6", originalText: "Owner Company will perform the services in a professional and workmanlike manner using personnel with appropriate skills and experience.", proposedText: "Owner Company will perform the services in a professional and workmanlike manner using qualified personnel." }] } });
    expect(proposeResponse.status()).toBe(201);
    const proposalId = ((await proposeResponse.json()) as { proposals: Array<{ id: string }> }).proposals[0].id;
    await reviewerContext.dispose();

    const ownerContext = await createIsolatedContext();
    const firstResolve = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/paragraph-proposals/${proposalId}/resolve`, { data: { action: "accept", reason: "Looks correct." } });
    expect(firstResolve.status()).toBe(200);
    const secondResolve = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/paragraph-proposals/${proposalId}/resolve`, { data: { action: "accept", reason: "Looks correct." } });
    expect(secondResolve.status()).toBe(409);
    await ownerContext.dispose();
  });

  test("mutating a locked contract returns 409", async () => {
    const ownerContext = await createIsolatedContext();
    const ownerAgree = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/agree`);
    expect(ownerAgree.ok()).toBeTruthy();

    const reviewerContext = await createIsolatedContext();
    const loginResponse = await reviewerContext.post("/api/client/login", { data: { username: REVIEWER_USERNAME, password: REVIEWER_PASSWORD } });
    expect(loginResponse.ok()).toBeTruthy();
    const reviewerAgree = await reviewerContext.post(`/api/client/contracts/${DEMO_CONTRACT_ID}/agree`);
    const reviewerAgreeBody = (await reviewerAgree.json()) as { locked?: boolean };
    expect(reviewerAgreeBody.locked).toBe(true);

    const proposeResponse = await reviewerContext.post(`/api/client/contracts/${DEMO_CONTRACT_ID}/proposals`, { data: { baseVersion: 1, edits: [{ blockId: "sample-block-6", originalText: "Owner Company will perform the services in a professional and workmanlike manner using personnel with appropriate skills and experience.", proposedText: "Different text." }] } });
    expect(proposeResponse.status()).toBe(409);
    await reviewerContext.dispose();
    await ownerContext.dispose();
  });
});
