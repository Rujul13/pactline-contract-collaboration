import { expect, test } from "@playwright/test";
import { DEMO_CONTRACT_ID, resetDemo } from "./fixtures";

test.describe("lifecycle transition failures", () => {
  test.beforeEach(async () => { await resetDemo(); });

  test("rejects a jump that skips stages", async ({ page }) => {
    // The demo contract seeds at lifecycle_stage='external_review' (lib/demo.ts),
    // unlocked. external_review's only forward edge in LIFECYCLE_TRANSITIONS
    // (lib/workflow.ts) is "approved" — jumping straight to "executed" skips
    // that stage, so isValidLifecycleTransition() rejects it before the
    // PATCH route ever reaches its locked-document check. The route
    // (app/api/contracts/[contractId]/lifecycle/route.ts) returns
    // `Invalid lifecycle transition from ${currentStage} to ${nextStage}`.
    await page.goto(`/workflow/${DEMO_CONTRACT_ID}`);
    await page.getByLabel("Lifecycle stage").selectOption("executed");
    await page.getByRole("button", { name: "Save lifecycle details" }).click();
    await expect(page.getByRole("status")).toContainText("Invalid lifecycle transition from external_review to executed");
  });

  test("rejects moving to approved with a pending required approval", async ({ page }) => {
    await page.goto(`/workflow/${DEMO_CONTRACT_ID}`);
    await page.getByRole("button", { name: "Add requirement" }).click();
    await expect(page.getByRole("status")).toContainText("approval required.");
    // Wait for this save's confirmation before selecting the next stage — the
    // form's <select> is re-synced from the server response (app/workflow/[contractId]/page.tsx's
    // load()), so racing ahead of it can let a stale reload clobber the next
    // selectOption() before "Save lifecycle details" is clicked again.
    await page.getByLabel("Lifecycle stage").selectOption("external_review");
    await page.getByRole("button", { name: "Save lifecycle details" }).click();
    await expect(page.getByRole("status")).toContainText("Lifecycle details saved");
    await page.getByLabel("Lifecycle stage").selectOption("approved");
    await page.getByRole("button", { name: "Save lifecycle details" }).click();
    await expect(page.getByRole("status")).toContainText(/required approval/);
  });

  test("a reviewer session cannot open the owner lifecycle route", async ({ request }) => {
    const loginResponse = await request.post("/api/client/login", { data: { username: "client.reviewer", password: "ReviewDemo!2026" } });
    expect(loginResponse.ok()).toBeTruthy();
    const response = await request.patch(`/api/contracts/${DEMO_CONTRACT_ID}/lifecycle`, { data: { lifecycleStage: "approved" } });
    expect(response.status()).toBe(403);
  });
});
