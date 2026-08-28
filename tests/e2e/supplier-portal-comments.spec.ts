import { expect, test, request as playwrightRequest } from "@playwright/test";
import { BASE_URL } from "../../playwright.config";
import { DEMO_CONTRACT_ID, resetDemo } from "./fixtures";

test.describe("Customer portal comments and authorization", () => {
  test.beforeEach(async () => {
    await resetDemo();
  });

  test("supplier comment creation, replies, view-only restrictions, and resolved thread layout", async ({ page }) => {
    // 1. Login to the Supplier Portal
    await page.goto("/portal");
    await expect(page.getByRole("heading", { name: "Customer portal" })).toBeVisible();

    await page.locator('input[value="customer.reviewer"]').fill("customer.reviewer");
    await page.locator('input[type="password"]').fill("CustomerDemo!2026");
    await page.getByRole("button", { name: "Sign in securely" }).click();

    await expect(page.getByText("Pactline customer portal")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Contracts" })).toBeVisible();

    // 2. Open the demo contract (propose_changes permission)
    const demoContractArticle = page.locator("article", { hasText: "Demo Master Services Agreement" });
    await demoContractArticle.getByRole("button", { name: "Open review" }).click();
    await expect(page.getByRole("heading", { name: "Demo Master Services Agreement" })).toBeVisible();

    // 3. Add a top-level paragraph comment
    const paragraphBlock = page.locator(".supplier-block").filter({ hasText: "Vendor Company will perform the services" });
    await expect(paragraphBlock).toBeVisible();

    const commentBtn = paragraphBlock.locator(".paragraph-comment-trigger");
    await expect(commentBtn).toBeVisible();
    await commentBtn.click();

    const composer = paragraphBlock.locator(".paragraph-comment-composer");
    await expect(composer).toBeVisible();
    const commentTextarea = composer.locator("textarea");
    await commentTextarea.fill("Staging supplier comment check.");
    await composer.getByRole("button", { name: "Post comment" }).click();

    await expect(page.getByText("Comment added to the paragraph discussion.")).toBeVisible();
    const thread = paragraphBlock.locator(".paragraph-thread");
    await expect(thread.getByText("Customer Reviewer (customer.reviewer)")).toBeVisible();
    await expect(thread.getByText("Staging supplier comment check.")).toBeVisible();

    // 4. Reply once to the comment
    const replyBtn = thread.locator(".thread-reply-trigger");
    await expect(replyBtn).toBeVisible();
    await replyBtn.click();

    const replyComposer = thread.locator(".paragraph-comment-composer");
    await expect(replyComposer).toBeVisible();
    await replyComposer.locator("textarea").fill("Staging reply from supplier.");
    await replyComposer.getByRole("button", { name: "Post reply" }).click();

    await expect(page.getByText("Reply added to the thread.")).toBeVisible();
    await expect(thread.getByText("Staging reply from supplier.")).toBeVisible();
    await expect(replyComposer).not.toBeVisible();

    // 5. Go back to contracts and check a view-only contract
    await page.getByRole("button", { name: "← All contracts" }).click();
    await expect(page.getByRole("heading", { name: "Contracts" })).toBeVisible();

    const expiredContractArticle = page.locator("article", { hasText: "Expired Mutual NDA" });
    await expiredContractArticle.getByRole("button", { name: "View agreement" }).click();
    await expect(page.getByRole("heading", { name: "Expired Mutual NDA" })).toBeVisible();

    const expiredParagraph = page.locator(".supplier-block").filter({ hasText: "The parties will protect confidential information" });
    await expect(expiredParagraph.locator(".paragraph-comment-trigger")).not.toBeVisible();

    // Direct E2E API assertion using isolated context: a view-only supplier receives 403 when posting a comment
    const portalContext = await playwrightRequest.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });
    const portalLoginRes = await portalContext.post("/api/portal/login", { data: { username: "customer.reviewer", password: "CustomerDemo!2026" } });
    expect(portalLoginRes.ok()).toBeTruthy();
    const apiCommentRes = await portalContext.post("/api/portal/contracts/sample-expired-nda/comments", {
      data: { blockId: "expired-nda-body", body: "Attempted bypass comment" }
    });
    expect(apiCommentRes.status()).toBe(403);
    await portalContext.dispose();

    // 6. Owner resolves the comment thread on DEMO_CONTRACT_ID and verify layout change
    const cleanContext = await playwrightRequest.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });
    const contractDataRes = await cleanContext.get(`/api/contracts/${DEMO_CONTRACT_ID}/workflow`);
    expect(contractDataRes.ok()).toBeTruthy();
    const contractData = await contractDataRes.json() as { comments: Array<{ id: string; parent_comment_id: string | null; status: string }> };
    const rootComment = contractData.comments.find(c => !c.parent_comment_id && c.status === "open");
    expect(rootComment).toBeDefined();

    const resolveRes = await cleanContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/comments`, {
      data: { action: "resolve", commentId: rootComment!.id, reason: "Resolved by owner in E2E validation." }
    });
    expect(resolveRes.status()).toBe(200);
    await cleanContext.dispose();

    // Reload supplier page and verify thread shows resolved state and no Reply button
    await page.goto("/portal");
    await demoContractArticle.getByRole("button", { name: "Open review" }).click();
    await expect(page.getByRole("heading", { name: "Demo Master Services Agreement" })).toBeVisible();

    const resolvedParagraph = page.locator(".supplier-block").filter({ hasText: "Vendor Company will perform the services" });
    const resolvedThread = resolvedParagraph.locator(".paragraph-thread");
    await expect(resolvedThread.getByText("Resolved: Resolved by owner in E2E validation.")).toBeVisible();
    await expect(resolvedThread.locator(".thread-reply-trigger")).not.toBeVisible();
  });
});
