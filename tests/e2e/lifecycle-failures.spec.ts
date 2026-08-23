import { expect, test } from "@playwright/test";
import { BASE_URL } from "../../playwright.config";
import { DEMO_CONTRACT_ID, resetDemo } from "./fixtures";

test.describe("lifecycle transition failures", () => {
  test.beforeEach(async () => { await resetDemo(); });

  test("rejects a jump that skips stages", async ({ page }) => {
    await page.goto(`/workflow/${DEMO_CONTRACT_ID}`);
    await page.getByLabel("Lifecycle stage").selectOption("executed");
    await page.getByRole("button", { name: "Save lifecycle details" }).click();
    await expect(page.getByRole("status")).toContainText("Invalid lifecycle transition from external_review to executed");
  });

  test("rejects moving to approved with a pending required approval", async ({ page }) => {
    await page.goto(`/workflow/${DEMO_CONTRACT_ID}`);
    await page.getByRole("button", { name: "Add requirement" }).click();
    await expect(page.getByRole("status")).toContainText("approval required.");
    await page.getByLabel("Lifecycle stage").selectOption("external_review");
    await page.getByRole("button", { name: "Save lifecycle details" }).click();
    await expect(page.getByRole("status")).toContainText("Lifecycle details saved");
    await page.getByLabel("Lifecycle stage").selectOption("approved");
    await page.getByRole("button", { name: "Save lifecycle details" }).click();
    await expect(page.getByRole("status")).toContainText("Complete every required approval");
  });

  test("a reviewer session cannot open the owner lifecycle route", async ({ playwright }) => {
    const reviewerContext = await playwright.request.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });
    const loginResponse = await reviewerContext.post("/api/client/login", { data: { username: "client.reviewer", password: "ReviewDemo!2026" } });
    expect(loginResponse.ok()).toBeTruthy();
    const response = await reviewerContext.patch(`/api/contracts/${DEMO_CONTRACT_ID}/lifecycle`, { data: { lifecycleStage: "approved" } });
    expect(response.status()).toBe(403);
    await reviewerContext.dispose();
  });
});
