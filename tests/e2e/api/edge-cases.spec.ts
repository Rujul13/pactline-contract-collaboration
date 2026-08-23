import { expect, test } from "@playwright/test";
import { request as playwrightRequest } from "@playwright/test";
import { BASE_URL } from "../../../playwright.config";
import { resetDemo, DEMO_CONTRACT_ID, REVIEWER_USERNAME, REVIEWER_PASSWORD } from "../fixtures";

async function createIsolatedContext() {
  const port = new URL(BASE_URL).port || "4319";
  return playwrightRequest.newContext({
    baseURL: BASE_URL,
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { host: `localhost:${port}` },
  });
}

test.describe("API authorization and edge cases", () => {
  test.beforeEach(async () => {
    await resetDemo();
  });

  test("no cookie on a client route returns 401", async () => {
    const context = await playwrightRequest.newContext({
      baseURL: BASE_URL,
      storageState: { cookies: [], origins: [] },
    });
    const response = await context.get(`/api/client/contracts/${DEMO_CONTRACT_ID}/proposals`);
    expect(response.status()).toBe(401);
    await context.dispose();
  });

  test("no cookie on a portal route returns 401", async () => {
    const context = await playwrightRequest.newContext({
      baseURL: BASE_URL,
      storageState: { cookies: [], origins: [] },
    });
    const response = await context.get("/api/portal/workspace");
    expect(response.status()).toBe(401);
    await context.dispose();
  });

  test("invalid credentials on client login returns 401", async () => {
    const context = await createIsolatedContext();
    const response = await context.post("/api/client/login", { data: { username: "wrong", password: "wrong" } });
    expect(response.status()).toBe(401);
    await context.dispose();
  });

  test("invalid credentials on portal login returns 401", async () => {
    const context = await createIsolatedContext();
    const response = await context.post("/api/portal/login", { data: { username: "wrong", password: "wrong" } });
    expect(response.status()).toBe(401);
    await context.dispose();
  });

  test("reviewer session cannot access owner contracts API", async () => {
    const reviewerContext = await createIsolatedContext();
    const loginRes = await reviewerContext.post("/api/client/login", { data: { username: REVIEWER_USERNAME, password: REVIEWER_PASSWORD } });
    expect(loginRes.ok()).toBeTruthy();

    const ownerRes = await reviewerContext.get(`/api/contracts/${DEMO_CONTRACT_ID}/workspace`);
    expect(ownerRes.status()).toBe(403);
    await reviewerContext.dispose();
  });

  test("owner session cannot access client proposals API", async () => {
    const ownerContext = await createIsolatedContext();
    const clientRes = await ownerContext.get(`/api/client/contracts/${DEMO_CONTRACT_ID}/proposals`);
    expect(clientRes.status()).toBe(401);
    await ownerContext.dispose();
  });

  test("proposing changes on non-existent contract returns 403", async () => {
    const reviewerContext = await createIsolatedContext();
    await reviewerContext.post("/api/client/login", { data: { username: REVIEWER_USERNAME, password: REVIEWER_PASSWORD } });
    const response = await reviewerContext.post("/api/client/contracts/non-existent-id/proposals", { data: { baseVersion: 1, edits: [] } });
    expect(response.status()).toBe(403);
    await reviewerContext.dispose();
  });

  test("proposing changes with empty edits array returns 400", async () => {
    const reviewerContext = await createIsolatedContext();
    await reviewerContext.post("/api/client/login", { data: { username: REVIEWER_USERNAME, password: REVIEWER_PASSWORD } });
    const response = await reviewerContext.post(`/api/client/contracts/${DEMO_CONTRACT_ID}/proposals`, { data: { baseVersion: 1, edits: [] } });
    expect(response.status()).toBe(400);
    await reviewerContext.dispose();
  });

  test("proposing changes with stale base version returns 409", async () => {
    const reviewerContext = await createIsolatedContext();
    await reviewerContext.post("/api/client/login", { data: { username: REVIEWER_USERNAME, password: REVIEWER_PASSWORD } });
    const response = await reviewerContext.post(`/api/client/contracts/${DEMO_CONTRACT_ID}/proposals`, { data: { baseVersion: 99, edits: [{ blockId: "sample-block-1", originalText: "a", proposedText: "b" }] } });
    expect(response.status()).toBe(409);
    await reviewerContext.dispose();
  });

  test("resolving non-existent proposal returns 404", async () => {
    const ownerContext = await createIsolatedContext();
    const response = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/paragraph-proposals/non-existent-id/resolve`, { data: { action: "accept", reason: "Accept rationale" } });
    expect(response.status()).toBe(404);
    await ownerContext.dispose();
  });

  test("resolving proposal with invalid decision returns 400", async () => {
    const ownerContext = await createIsolatedContext();
    const response = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/paragraph-proposals/fake-id/resolve`, { data: { action: "invalid" as never, reason: "Invalid rationale" } });
    expect(response.status()).toBe(400);
    await ownerContext.dispose();
  });

  test("commenting on non-existent contract returns 404", async () => {
    const ownerContext = await createIsolatedContext();
    const response = await ownerContext.post("/api/contracts/non-existent-id/comments", { data: { action: "add", blockId: "sample-block-1", body: "Hello" } });
    expect(response.status()).toBe(404);
    await ownerContext.dispose();
  });

  test("commenting without action returns 400", async () => {
    const ownerContext = await createIsolatedContext();
    const response = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { body: "Missing action" } });
    expect(response.status()).toBe(400);
    await ownerContext.dispose();
  });

  test.describe("comment thread edge cases", () => {
    test("resolve without a reason returns 400", async () => {
      const ownerContext = await createIsolatedContext();
      const addRes = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "add", blockId: "sample-block-1", body: "Parent comment" } });
      expect(addRes.ok()).toBeTruthy();
      const addData = (await addRes.json()) as { comment: { id: string } };
      const parentId = addData.comment.id;
      const resolveRes = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "resolve", commentId: parentId, reason: "   " } });
      expect(resolveRes.status()).toBe(400);
      await ownerContext.dispose();
    });

    test("replying to a reply (not a root) returns 400", async () => {
      const ownerContext = await createIsolatedContext();
      const addRes = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "add", blockId: "sample-block-1", body: "Parent comment" } });
      expect(addRes.ok()).toBeTruthy();
      const addData = (await addRes.json()) as { comment: { id: string } };
      const rootId = addData.comment.id;

      const replyRes = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "reply", blockId: "sample-block-1", parentCommentId: rootId, body: "Reply 1" } });
      expect(replyRes.ok()).toBeTruthy();
      const replyData = (await replyRes.json()) as { comment: { id: string } };
      const replyId = replyData.comment.id;

      const nestedReplyRes = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "reply", blockId: "sample-block-1", parentCommentId: replyId, body: "Nested reply" } });
      expect(nestedReplyRes.status()).toBe(400);
      await ownerContext.dispose();
    });

    test("reply using a parent comment from a different contract returns 400 or 404", async () => {
      const ownerContext = await createIsolatedContext();
      const addRes = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, { data: { action: "add", blockId: "sample-block-1", body: "Parent comment" } });
      expect(addRes.ok()).toBeTruthy();
      const addData = (await addRes.json()) as { comment: { id: string } };
      const parentId = addData.comment.id;

      const otherRes = await ownerContext.post("/api/contracts/sample-services-agreement-v2/comments", { data: { action: "reply", blockId: "sample-block-1", parentCommentId: parentId, body: "Cross-contract reply" } });
      expect([400, 404]).toContain(otherRes.status());
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

    const ownerContext = await createIsolatedContext();
    const firstResolve = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/paragraph-proposals/${proposalId}/resolve`, { data: { action: "accept", reason: "Accepted rationale" } });
    expect(firstResolve.ok()).toBeTruthy();

    const secondResolve = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/paragraph-proposals/${proposalId}/resolve`, { data: { action: "reject", reason: "Rejected rationale" } });
    expect(secondResolve.status()).toBe(409);

    await reviewerContext.dispose();
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
    if (!reviewerAgree.ok()) {
      console.error("reviewerAgree failed:", reviewerAgree.status(), await reviewerAgree.text());
    }
    expect(reviewerAgree.ok()).toBeTruthy();
    const reviewerAgreeBody = (await reviewerAgree.json()) as { locked?: boolean };
    expect(reviewerAgreeBody.locked).toBe(true);

    const proposeResponse = await reviewerContext.post(`/api/client/contracts/${DEMO_CONTRACT_ID}/proposals`, { data: { baseVersion: 1, edits: [{ blockId: "sample-block-6", originalText: "Owner Company will perform the services in a professional and workmanlike manner using personnel with appropriate skills and experience.", proposedText: "Different text." }] } });
    expect(proposeResponse.status()).toBe(409);
    await reviewerContext.dispose();
    await ownerContext.dispose();
  });
});
