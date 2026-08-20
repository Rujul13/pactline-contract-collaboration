import { expect, test } from "@playwright/test";
import { BASE_URL } from "../../playwright.config";
import { resetDemo, REVIEWER_PASSWORD, REVIEWER_USERNAME } from "./fixtures";

test.describe("Operations and Diagnostics E2E", () => {
  test.beforeAll(async () => {
    await resetDemo();
  });

  test("unauthorized access is gated with 401", async ({ playwright }) => {
    // Create isolated request context to avoid cookie pollution
    const unauthContext = await playwright.request.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: { host: "127.0.0.1" }
    });
    const res = await unauthContext.get("/api/owner/release-readiness", {
      headers: {
        cookie: "garbage=1"
      }
    });
    expect(res.status()).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Authentication required");
    await unauthContext.dispose();
  });

  test("reviewer session receives 403 forbidden on owner endpoints", async ({ playwright }) => {
    // Create isolated request context for reviewer
    const reviewerContext = await playwright.request.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: { host: `localhost:${new URL(BASE_URL).port}` }
    });

    const loginRes = await reviewerContext.post("/api/client/login", {
      data: {
        username: REVIEWER_USERNAME,
        password: REVIEWER_PASSWORD
      }
    });
    expect(loginRes.ok()).toBe(true);

    // Call owner endpoint with reviewer cookies
    const res = await reviewerContext.get("/api/owner/release-readiness");
    expect(res.status()).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Owner permission required");

    await reviewerContext.dispose();
  });

  test("owner diagnostics retrieve status cleanly with 200", async ({ request }) => {
    const res = await request.get("/api/owner/release-readiness", {
      headers: {
        host: `localhost:${new URL(BASE_URL).port}`
      }
    });
    expect(res.status()).toBe(200);
    const data = await res.json() as {
      d1: { status: string; latencyMs: number };
      migrations: { applied: number; isCurrent: boolean };
      r2: { status: string };
      lastCronRun: string;
      buildIdentity: { commitSha: string };
    };

    expect(data.d1.status).toBe("online");
    expect(typeof data.d1.latencyMs).toBe("number");
    expect(data.migrations.applied).toBeGreaterThanOrEqual(11);
    expect(typeof data.migrations.isCurrent).toBe("boolean");
    expect(data.r2.status).toBeDefined();
    expect(data.lastCronRun).toBeDefined();
    expect(data.buildIdentity.commitSha).toBeDefined();
  });

  test("telemetry captures route errors and redacts credentials", async ({ request }) => {
    // 1. Trigger deliberate error with sensitive parameters
    const triggerRes = await request.get("/api/owner/monitoring/errors?password=my-secret-password-123&cookie=sessionTokenValue", {
      headers: {
        host: `localhost:${new URL(BASE_URL).port}`,
        "x-trigger-error": "true"
      }
    });
    expect(triggerRes.status()).toBe(500);
    const triggerBody = await triggerRes.json() as { error: string; requestId: string };
    expect(triggerBody.error).toBe("Internal Server Error");
    expect(triggerBody.requestId).toBeDefined();

    // 2. Fetch the errors log as owner
    const logRes = await request.get("/api/owner/monitoring/errors", {
      headers: {
        host: `localhost:${new URL(BASE_URL).port}`
      }
    });
    expect(logRes.status()).toBe(200);
    const logData = await logRes.json() as {
      errors: Array<{
        id: string;
        route: string;
        message: string;
        actor_scope: string;
        metadata: {
          query: {
            password?: string;
            cookie?: string;
          };
        };
      }>;
    };

    // Find our triggered error
    const testError = logData.errors.find((err) => err.message === "Deliberate test error for monitoring");
    expect(testError).toBeDefined();
    if (!testError) throw new Error("Test error not found");
    expect(testError.route).toBe("/api/owner/monitoring/errors");
    expect(testError.actor_scope).toBe("owner");

    // Assert password and sessionTokenValue are redacted in metadata query
    const metadata = testError.metadata;
    expect(metadata.query.password).toBe("[REDACTED]");
    expect(metadata.query.cookie).toBe("[REDACTED]");
  });

  test("operations release dashboard UI is visible to the owner", async ({ page }) => {
    await page.goto("/owner/release-dashboard");
    await expect(page.locator("h1")).toContainText("Release & Observability Dashboard");
    await expect(page.locator("text=Worker Bindings")).toBeVisible();
    await expect(page.locator("text=Schema & Migrations")).toBeVisible();
    await expect(page.locator("text=Cron & Telemetry")).toBeVisible();
  });
});
