import { expect, test } from "@playwright/test";
import { request as playwrightRequest } from "@playwright/test";
import { BASE_URL } from "../../../playwright.config";
import { resetDemo, DEMO_CONTRACT_ID, REVIEWER_USERNAME, REVIEWER_PASSWORD } from "../fixtures";

async function createIsolatedContext() {
  return playwrightRequest.newContext({
    baseURL: BASE_URL,
    storageState: { cookies: [], origins: [] },
  });
}



test.describe("API authorization and edge cases", () => {
  test.beforeEach(async () => {
    await resetDemo();
  });

  test("no cookie on a client route returns 401", async () => {
    const context = await createIsolatedContext();
    const response = await context.get(`/api/client/contracts/${DEMO_CONTRACT_ID}/proposals`);
    expect(response.status()).toBe(401);
    await context.dispose();
  });

  test("no cookie on a portal route returns 401", async () => {
    const context = await createIsolatedContext();
    const response = await context.get("/api/portal/workspace");
    expect(response.status()).toBe(401);
    await context.dispose();
  });

  test("a garbage client cookie returns 401 (equivalent to an expired session)", async () => {
    const context = await createIsolatedContext();
    const response = await context.get(`/api/client/contracts/${DEMO_CONTRACT_ID}/proposals`, {
      headers: { cookie: "__Host-pactline_client=invalid-session-token-12345" },
    });
    expect(response.status()).toBe(401);
    await context.dispose();
  });

  test("a reviewer session on an owner-only comments action returns 403", async () => {
    const reviewerContext = await createIsolatedContext();
    const loginResponse = await reviewerContext.post("/api/client/login", { data: { username: REVIEWER_USERNAME, password: REVIEWER_PASSWORD } });
    expect(loginResponse.ok()).toBeTruthy();
    const response = await reviewerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "add", blockId: "sample-block-1", body: "Owner comment" } });
    expect(response.status()).toBe(403);
    await reviewerContext.dispose();
  });

  test("a client session against a contract it doesn't own returns 404", async () => {
    const reviewerContext = await createIsolatedContext();
    const loginResponse = await reviewerContext.post("/api/client/login", { data: { username: REVIEWER_USERNAME, password: REVIEWER_PASSWORD } });
    expect(loginResponse.ok()).toBeTruthy();
    const response = await reviewerContext.get("/api/client/contracts/some-other-contract-id/proposals");
    expect(response.status()).toBe(404);
    await reviewerContext.dispose();
  });

  test("a portal session with no active grant for a contract returns 404", async () => {
    const context = await createIsolatedContext();
    const loginRes = await context.post("/api/portal/login", { data: { username: "supplier.vendor", password: "VendorDemo!2026" } });
    expect(loginRes.ok()).toBeTruthy();
    const response = await context.get(`/api/portal/contracts/${DEMO_CONTRACT_ID}`);
    expect(response.status()).toBe(404);
    await context.dispose();
  });

  test("a malformed DOCX upload returns 400", async () => {
    const ownerContext = await createIsolatedContext();
    const response = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/documents`, {
      multipart: {
        file: {
          name: "corrupt.docx",
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          buffer: Buffer.from("not a zip file at all"),
        },
      },
    });
    expect(response.status()).toBe(400);
    await ownerContext.dispose();
  });

  test("downloading a nonexistent portal document returns 404, not 500", async () => {
    const context = await createIsolatedContext();
    const loginRes = await context.post("/api/portal/login", { data: { username: "supplier.vendor", password: "VendorDemo!2026" } });
    expect(loginRes.ok()).toBeTruthy();
    const response = await context.get("/api/portal/documents/nonexistent-doc-id/download");
    expect(response.status()).toBe(404);
    await context.dispose();
  });

  test.describe("comment thread edge cases", () => {
    test("reply targeting a nonexistent parent returns 400", async () => {
      const ownerContext = await createIsolatedContext();
      const response = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "reply", blockId: "sample-block-1", parentCommentId: "nonexistent-id", body: "Reply" } });
      expect(response.status()).toBe(400);
      await ownerContext.dispose();
    });

    test("reply targeting a different paragraph than its parent returns 400", async () => {
      const ownerContext = await createIsolatedContext();
      const createRes = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "add", blockId: "sample-block-1", body: "Parent comment" } });
      expect(createRes.status()).toBe(200);
      const workspaceRes = await ownerContext.get(`/api/contracts/${DEMO_CONTRACT_ID}/workspace`);
      const workspace = (await workspaceRes.json()) as { comments: Array<{ id: string }> };
      const parentId = workspace.comments[0].id;
      const replyRes = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "reply", blockId: "sample-block-2", parentCommentId: parentId, body: "Mismatched reply" } });
      expect(replyRes.status()).toBe(400);
      await ownerContext.dispose();
    });

    test("reply on a resolved thread returns 409", async () => {
      const ownerContext = await createIsolatedContext();
      await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "add", blockId: "sample-block-1", body: "Parent comment" } });
      const workspaceRes = await ownerContext.get(`/api/contracts/${DEMO_CONTRACT_ID}/workspace`);
      const workspace = (await workspaceRes.json()) as { comments: Array<{ id: string }> };
      const parentId = workspace.comments[0].id;
      await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "resolve", commentId: parentId, reason: "Resolved" } });
      const replyRes = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "reply", blockId: "sample-block-1", parentCommentId: parentId, body: "Reply to resolved" } });
      expect(replyRes.status()).toBe(409);
      await ownerContext.dispose();
    });

    test("resolve without a reason returns 400", async () => {
      const ownerContext = await createIsolatedContext();
      await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "add", blockId: "sample-block-1", body: "Parent comment" } });
      const workspaceRes = await ownerContext.get(`/api/contracts/${DEMO_CONTRACT_ID}/workspace`);
      const workspace = (await workspaceRes.json()) as { comments: Array<{ id: string }> };
      const parentId = workspace.comments[0].id;
      const resolveRes = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "resolve", commentId: parentId, reason: "   " } });
      expect(resolveRes.status()).toBe(400);
      await ownerContext.dispose();
    });

    test("replying to a reply (not a root) returns 400", async () => {
      const ownerContext = await createIsolatedContext();
      await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "add", blockId: "sample-block-1", body: "Parent comment" } });
      let workspaceRes = await ownerContext.get(`/api/contracts/${DEMO_CONTRACT_ID}/workspace`);
      let workspace = (await workspaceRes.json()) as { comments: Array<{ id: string }> };
      const rootId = workspace.comments[0].id;
      await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "reply", blockId: "sample-block-1", parentCommentId: rootId, body: "Reply 1" } });
      workspaceRes = await ownerContext.get(`/api/contracts/${DEMO_CONTRACT_ID}/workspace`);
      workspace = (await workspaceRes.json()) as { comments: Array<{ id: string }> };
      const replyId = workspace.comments.find((c) => c.id !== rootId)!.id;
      const nestedReplyRes = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "reply", blockId: "sample-block-1", parentCommentId: replyId, body: "Nested reply" } });
      expect(nestedReplyRes.status()).toBe(400);
      await ownerContext.dispose();
    });

    test("reply using a parent comment from a different contract returns 400", async () => {
      const ownerContext = await createIsolatedContext();
      await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "add", blockId: "sample-block-1", body: "Parent comment" } });
      const workspaceRes = await ownerContext.get(`/api/contracts/${DEMO_CONTRACT_ID}/workspace`);
      const workspace = (await workspaceRes.json()) as { comments: Array<{ id: string }> };
      const parentId = workspace.comments[0].id;
      const otherRes = await ownerContext.post("/api/contracts/sample-services-agreement-v2/comments", { data: { action: "reply", blockId: "sample-block-1", parentCommentId: parentId, body: "Cross-contract reply" } });
      expect(otherRes.status()).toBe(400);
      await ownerContext.dispose();
    });
  });

  test("resolving an already-resolved proposal returns 409", async () => {
    const reviewerContext = await createIsolatedContext();
    const loginResponse = await reviewerContext.post("/api/client/login", { data: { username: REVIEWER_USERNAME, password: REVIEWER_PASSWORD } });
    expect(loginResponse.ok()).toBeTruthy();
    const proposalRes = await reviewerContext.post(`/api/client/contracts/${DEMO_CONTRACT_ID}/proposals`, { data: { baseVersion: 1, edits: [{ blockId: "sample-block-6", originalText: "Owner Company will perform the services in a professional and workmanlike manner using personnel with appropriate skills and experience.", proposedText: "Different text." }] } });
    expect(proposalRes.status()).toBe(201);
    const proposalData = (await proposalRes.json()) as { proposals: Array<{ id: string }> };
    const proposalId = proposalData.proposals[0].id;
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
