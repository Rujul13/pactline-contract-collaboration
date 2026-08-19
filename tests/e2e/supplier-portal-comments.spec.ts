import { expect, test, request as playwrightRequest } from "@playwright/test";
import { DEMO_CONTRACT_ID, resetDemo } from "./fixtures";

test.describe("Supplier portal comments and authorization", () => {
  test.beforeEach(async () => {
    await resetDemo();
  });

  test("supplier comment creation, replies, view-only restrictions, and resolved thread layout", async ({ page }) => {
    // 1. Login to the Supplier Portal
    await page.goto("/portal");
    await expect(page.getByRole("heading", { name: "Supplier portal" })).toBeVisible();

    await page.locator('input[value="supplier.reviewer"]').fill("supplier.reviewer");
    await page.locator('input[type="password"]').fill("SupplierDemo!2026");
    await page.getByRole("button", { name: "Sign in securely" }).click();

    await expect(page.getByText("Pactline supplier portal")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Contracts" })).toBeVisible();

    // 2. Open the demo contract (propose_changes permission)
    const demoContractArticle = page.locator("article", { hasText: "Demo Master Services Agreement" });
    await demoContractArticle.getByRole("button", { name: "Open review" }).click();
    await expect(page.getByRole("heading", { name: "Demo Master Services Agreement" })).toBeVisible();

    // 3. Add a top-level paragraph comment
    // Let's target the second paragraph block ("Owner Company will perform the services in a professional...")
    const paragraphBlock = page.locator(".supplier-block").filter({ hasText: "Owner Company will perform the services" });
    await expect(paragraphBlock).toBeVisible();

    // The Comment button should show initially
    const commentBtn = paragraphBlock.locator(".paragraph-comment-trigger");
    await expect(commentBtn).toBeVisible();
    await commentBtn.click();

    // Fill comment composer
    const composer = paragraphBlock.locator(".paragraph-comment-composer");
    await expect(composer).toBeVisible();
    const commentTextarea = composer.locator("textarea");
    await commentTextarea.fill("Staging supplier comment check.");
    await composer.getByRole("button", { name: "Post comment" }).click();

    // Verify comment is posted
    await expect(page.getByText("Comment added to the paragraph discussion.")).toBeVisible();
    const thread = paragraphBlock.locator(".paragraph-thread");
    await expect(thread.getByText("Supplier Reviewer (supplier.reviewer)")).toBeVisible();
    await expect(thread.getByText("Staging supplier comment check.")).toBeVisible();

    // 4. Reply once to the comment
    const replyBtn = thread.locator(".thread-reply-trigger");
    await expect(replyBtn).toBeVisible();
    await replyBtn.click();

    const replyComposer = thread.locator(".paragraph-comment-composer");
    await expect(replyComposer).toBeVisible();
    await replyComposer.locator("textarea").fill("Staging reply from supplier.");
    await replyComposer.getByRole("button", { name: "Post reply" }).click();

    // Verify reply is posted
    await expect(page.getByText("Reply added to the thread.")).toBeVisible();
    await expect(thread.getByText("Staging reply from supplier.")).toBeVisible();
    
    // Ensure the Reply button is no longer open / reply composer is closed
    await expect(replyComposer).not.toBeVisible();

    // 5. Go back to contracts and check a view-only contract
    await page.getByRole("button", { name: "← All contracts" }).click();
    await expect(page.getByRole("heading", { name: "Contracts" })).toBeVisible();

    // Open Expired Mutual NDA (view-only permission)
    const expiredContractArticle = page.locator("article", { hasText: "Expired Mutual NDA" });
    await expiredContractArticle.getByRole("button", { name: "View agreement" }).click();
    await expect(page.getByRole("heading", { name: "Expired Mutual NDA" })).toBeVisible();

    // Verify Comment trigger is not visible on paragraphs
    const expiredParagraph = page.locator(".supplier-block").filter({ hasText: "The parties will protect confidential information" });
    await expect(expiredParagraph.locator(".paragraph-comment-trigger")).not.toBeVisible();

    // 6. Owner resolves the comment thread on DEMO_CONTRACT_ID and verify layout change
    // We use a clean request context to avoid cookie pollution, automatically authenticated as owner on localhost
    const cleanContext = await playwrightRequest.newContext();
    const contractDataRes = await cleanContext.get(`${page.url().split("/portal")[0]}/api/contracts/${DEMO_CONTRACT_ID}/workflow`);
    expect(contractDataRes.ok()).toBeTruthy();
    const contractData = await contractDataRes.json() as { comments: Array<{ id: string; parent_comment_id: string | null; status: string }> };
    const rootComment = contractData.comments.find(c => !c.parent_comment_id && c.status === "open");
    expect(rootComment).toBeDefined();

    // Resolve the thread as owner
    const resolveRes = await cleanContext.post(`${page.url().split("/portal")[0]}/api/contracts/${DEMO_CONTRACT_ID}/comments`, {
      data: { action: "resolve", commentId: rootComment!.id, reason: "Resolved by owner in E2E validation." }
    });
    expect(resolveRes.status()).toBe(200);
    await cleanContext.dispose();

    // Reload supplier page and verify thread shows resolved state and no Reply button
    await page.goto("/portal");
    await demoContractArticle.getByRole("button", { name: "Open review" }).click();
    await expect(page.getByRole("heading", { name: "Demo Master Services Agreement" })).toBeVisible();

    const resolvedParagraph = page.locator(".supplier-block").filter({ hasText: "Owner Company will perform the services" });
    const resolvedThread = resolvedParagraph.locator(".paragraph-thread");
    await expect(resolvedThread.getByText("Resolved: Resolved by owner in E2E validation.")).toBeVisible();
    await expect(resolvedThread.locator(".thread-reply-trigger")).not.toBeVisible();
  });
});
