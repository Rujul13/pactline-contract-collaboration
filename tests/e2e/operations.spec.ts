import { expect, test } from "@playwright/test";
import { BASE_URL } from "../../playwright.config";
import { resetDemo, REVIEWER_PASSWORD, REVIEWER_USERNAME, DEMO_CONTRACT_ID } from "./fixtures";
import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";

const D1_DIR = ".wrangler/state-e2e/v3/d1/miniflare-D1DatabaseObject";
const PORTAL_USERNAME = "supplier.reviewer";
const PORTAL_PASSWORD = "SupplierDemo!2026";

function getDatabase() {
  const files = readdirSync(D1_DIR);
  const dbFile = files.find((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite");
  if (!dbFile) throw new Error("E2E database not found under " + D1_DIR);
  const db = new DatabaseSync(`${D1_DIR}/${dbFile}`);
  db.exec("PRAGMA foreign_keys=ON");
  return db;
}

test.describe("Operations and Diagnostics E2E", () => {
  test.beforeEach(async () => {
    await resetDemo();
  });

  test("unauthorized access is gated with 401", async ({ playwright }) => {
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
      r2: { status: string; reachable: boolean; details?: string };
      lastCronRun: string;
      buildIdentity: { commitSha: string };
    };

    expect(data.d1.status).toBe("online");
    expect(typeof data.d1.latencyMs).toBe("number");
    expect(data.migrations.applied).toBeGreaterThanOrEqual(11);
    expect(typeof data.migrations.isCurrent).toBe("boolean");
    expect(data.r2.status).toBe("available");
    expect(data.r2.reachable).toBe(true);
    expect(data.lastCronRun).toBeDefined();
    expect(data.buildIdentity.commitSha).toBeDefined();
  });

  test("telemetry captures route errors and redacts credentials", async ({ request }) => {
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

    const testError = logData.errors.find((err) => err.message === "Deliberate test error for monitoring");
    expect(testError).toBeDefined();
    if (!testError) throw new Error("Test error not found");
    expect(testError.route).toBe("/api/owner/monitoring/errors");
    expect(testError.actor_scope).toBe("owner");

    const metadata = testError.metadata;
    expect(metadata.query.password).toBe("[REDACTED]");
    expect(metadata.query.cookie).toBe("[REDACTED]");
  });

  test("monitoring privacy redacts authorization, proxy-authorization, x-api-key, cookies, and error messages", async ({ request }) => {
    // Trigger error with highly sensitive values
    const triggerRes = await request.get("/api/owner/monitoring/errors", {
      headers: {
        host: `localhost:${new URL(BASE_URL).port}`,
        "x-trigger-error": "true",
        "x-trigger-error-msg": "Failed connection using token abc-secret-123",
        "Authorization": "Bearer token12345",
        "Proxy-Authorization": "Basic proxySecret",
        "X-API-Key": "my-secret-key-999",
        "Cookie": "session_cookie=cookieVal"
      }
    });
    expect(triggerRes.status()).toBe(500);

    const logRes = await request.get("/api/owner/monitoring/errors", {
      headers: {
        host: `localhost:${new URL(BASE_URL).port}`
      }
    });
    expect(logRes.status()).toBe(200);
    const logData = await logRes.json() as {
      errors: Array<{
        message: string;
        metadata: {
          headers: Record<string, string>;
        };
      }>;
    };

    // Find the error we just triggered (it will be sanitized)
    const testError = logData.errors.find((err) => err.message === "An operational error occurred (sanitized)");
    expect(testError).toBeDefined();
    if (!testError) throw new Error("Sanitized test error not found");

    const headers = testError.metadata.headers;
    expect(headers["authorization"]).toBe("[REDACTED]");
    expect(headers["proxy-authorization"]).toBe("[REDACTED]");
    expect(headers["x-api-key"]).toBe("[REDACTED]");
    expect(headers["cookie"]).toBe("[REDACTED]");
  });

  test("relationship metadata is restricted to authorized contracts for reviewer and supplier", async ({ playwright }) => {
    const targetId = "inaccessible-linked-contract";
    const db = getDatabase();
    
    try {
      const userRow = db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string } | undefined;
      const userId = userRow?.id || "owner";

      // Insert inaccessible contract safely satisfying initiator_id and approver_id NOT NULL constraints
      db.prepare("INSERT OR REPLACE INTO contracts (id, title, lifecycle_stage, risk_level, current_version, status, initiator_id, approver_id, created_at, updated_at) VALUES (?, 'Inaccessible Contract', 'draft', 'low', 1, 'draft', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").run(targetId, userId, userId);
      
      // Insert relationship: sample-services-agreement amends inaccessible-linked-contract
      db.prepare("INSERT OR REPLACE INTO contract_relationships (id, source_contract_id, target_contract_id, relationship_type, created_by) VALUES (?, ?, ?, 'amends', 'owner')").run(crypto.randomUUID(), DEMO_CONTRACT_ID, targetId);
    } finally {
      db.close();
    }

    // 1. Owner can discover it
    const ownerContext = await playwright.request.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: { host: `localhost:${new URL(BASE_URL).port}` }
    });
    const ownerRes = await ownerContext.get(`/api/contracts/${DEMO_CONTRACT_ID}/relationships`);
    expect(ownerRes.status()).toBe(200);
    const ownerData = await ownerRes.json() as { predecessors: Array<{ id: string }> };
    expect(ownerData.predecessors.some(p => p.id === targetId)).toBe(true);
    await ownerContext.dispose();

    // 2. Reviewer authorized only for DEMO_CONTRACT_ID cannot discover it
    const reviewerContext = await playwright.request.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: { host: "127.0.0.1" }
    });
    const revLogin = await reviewerContext.post("/api/client/login", {
      data: { username: REVIEWER_USERNAME, password: REVIEWER_PASSWORD }
    });
    expect(revLogin.ok()).toBe(true);

    const reviewerRes = await reviewerContext.get(`/api/contracts/${DEMO_CONTRACT_ID}/relationships`);
    expect(reviewerRes.status()).toBe(200);
    const reviewerData = await reviewerRes.json() as { predecessors: Array<{ id: string }> };
    expect(reviewerData.predecessors.some(p => p.id === targetId)).toBe(false);
    await reviewerContext.dispose();

    // 3. Supplier authorized only for DEMO_CONTRACT_ID cannot discover it
    const supplierContext = await playwright.request.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: { host: "127.0.0.1" }
    });
    const supLogin = await supplierContext.post("/api/portal/login", {
      data: { username: PORTAL_USERNAME, password: PORTAL_PASSWORD }
    });
    expect(supLogin.ok()).toBe(true);

    const supplierRes = await supplierContext.get(`/api/contracts/${DEMO_CONTRACT_ID}/relationships`);
    expect(supplierRes.status()).toBe(200);
    const supplierData = await supplierRes.json() as { predecessors: Array<{ id: string }> };
    expect(supplierData.predecessors.some(p => p.id === targetId)).toBe(false);
    await supplierContext.dispose();
  });

  test("notifications scheduled sweep is idempotent and shows correct provider stub copy", async ({ playwright }) => {
    const db = getDatabase();
    const reminderId = "test-reminder-sweep-1";
    const dueAt = new Date(Date.now() - 60000).toISOString(); // 1 minute ago (due)

    try {
      // Clean any residual test alerts or reminder schedules
      db.prepare("DELETE FROM reminder_schedules WHERE id = ?").run(reminderId);
      db.prepare("DELETE FROM notification_deliveries WHERE template_payload LIKE '%' || ? || '%'").run(reminderId);

      // Insert due reminder schedule
      db.prepare(`
        INSERT INTO reminder_schedules (id, contract_id, kind, channel, due_at, recipient, status, created_at, updated_at)
        VALUES (?, ?, 'review_deadline', 'in_app', ?, 'sweep-test@example.test', 'scheduled', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(reminderId, DEMO_CONTRACT_ID, dueAt);
    } finally {
      db.close();
    }

    const schedulerContext = await playwright.request.newContext({ baseURL: BASE_URL });

    const dbDebug1 = getDatabase();
    try {
      console.log("E2E RUNNING: Reminders before sweep:", dbDebug1.prepare("SELECT id, status, due_at FROM reminder_schedules").all());
    } finally {
      dbDebug1.close();
    }

    // Trigger scheduled sweep 1st time
    const run1 = await schedulerContext.get("/__scheduled");
    console.log("E2E RUNNING: run1 response status:", run1.status());
    console.log("E2E RUNNING: run1 response text:", await run1.text());
    expect(run1.ok()).toBe(true);

    // Trigger scheduled sweep 2nd time to prove idempotency
    const run2 = await schedulerContext.get("/__scheduled");
    expect(run2.ok()).toBe(true);

    await schedulerContext.dispose();

    // Query DB directly to assert idempotency and correct enqueued values
    const db2 = getDatabase();
    try {
      console.log("E2E RUNNING: Reminders after sweep:", db2.prepare("SELECT id, status, due_at FROM reminder_schedules").all());
      console.log("E2E RUNNING: Deliveries after sweep:", db2.prepare("SELECT id, recipient_email, status FROM notification_deliveries").all());
      const reminder = db2.prepare("SELECT * FROM reminder_schedules WHERE id = ?").get(reminderId) as { status: string } | undefined;
      expect(reminder?.status).toBe("sent");

      const deliveries = db2.prepare("SELECT * FROM notification_deliveries WHERE recipient_email = 'sweep-test@example.test'").all() as Array<{ status: string }>;
      // There should be exactly 1 delivery created
      expect(deliveries.length).toBe(1);
      expect(deliveries[0].status).toBe("logged"); // Enqueued 'queued' and processed immediately to 'logged' in scheduler execution
    } finally {
      db2.close();
    }

    // Verify copy on Release Dashboard UI
const tempBrowser = await playwright.chromium.launch();
const ownerBrowserContext = await tempBrowser.newContext({
  baseURL: BASE_URL,
  extraHTTPHeaders: { host: `localhost:${new URL(BASE_URL).port}` }
});

      const page = await ownerBrowserContext.newPage();
      await page.goto(`${BASE_URL}/owner/release-dashboard`);

      // Check that Notification Queue Log has our test delivery and shows "Logged — local stub"
      await expect(page.locator("text=sweep-test@example.test")).toBeVisible();
      await expect(page.locator("text=Logged — local stub")).toBeVisible();

      await ownerBrowserContext.dispose();
await tempBrowser.close();
  });

  test("operations release dashboard UI is visible to the owner", async ({ page }) => {
    await page.goto("/owner/release-dashboard");
    await expect(page.locator("h1")).toContainText("Release & Observability Dashboard");
    await expect(page.locator("text=Worker Bindings")).toBeVisible();
    await expect(page.locator("text=Schema Capability Check")).toBeVisible();
    await expect(page.locator("text=Cron & Telemetry")).toBeVisible();
    await expect(page.locator("text=Notification Queue Log")).toBeVisible();
  });
});
