import { request as playwrightRequest } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { BASE_URL } from "../../playwright.config";

export const DEMO_CONTRACT_ID = "sample-services-agreement";
export const REVIEWER_USERNAME = "client.reviewer";
export const REVIEWER_PASSWORD = "ReviewDemo!2026";

const D1_DIR = ".wrangler/state-e2e/v3/d1/miniflare-D1DatabaseObject";
let migrated = false;

function findDbFile(): string | undefined {
  return readdirSync(D1_DIR).find((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite");
}

function migrateLocalD1(): void {
  if (migrated) return;
  if (!existsSync(D1_DIR)) throw new Error(`Local D1 directory not found at ${D1_DIR} — the Playwright webServer should have created it by the time a test runs. Is PACTLINE_E2E=true reaching vite.config.ts?`);
  const dbFile = findDbFile();
  if (!dbFile) throw new Error(`No local D1 sqlite file found under ${D1_DIR}`);
  const dbPath = `${D1_DIR}/${dbFile}`;
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys=ON");

  const tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name);
  const hasNotifications = tables.includes("notification_deliveries");

  if (!hasNotifications) {
    db.exec("PRAGMA foreign_keys=OFF");
    const userTables = (db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((row) => row.name);
    for (const table of userTables) {
      db.exec(`DROP TABLE IF EXISTS "${table}"`);
    }
    db.exec("PRAGMA foreign_keys=ON");
  }

  const alreadyMigrated = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='contracts'").all().length > 0;
  if (!alreadyMigrated) {
    for (const file of readdirSync("drizzle").filter((name) => /^\d{4}.*\.sql$/.test(name)).sort()) {
      db.exec(readFileSync(`drizzle/${file}`, "utf8").replaceAll("--> statement-breakpoint", ""));
    }
  }
  db.close();
  migrated = true;
}

export async function resetDemo(): Promise<void> {
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { host: `localhost:${new URL(BASE_URL).port}` } });
  if (!migrated) {
    // Miniflare only materializes the per-database D1 sqlite file on the first
    // actual query against the binding — a plain server boot / health-check GET
    // does not touch it. Fire a throwaway request so migrateLocalD1() below has
    // a file to find; its failure (missing tables) is expected and ignored.
    if (!existsSync(D1_DIR) || !findDbFile()) {
      await context.post("/api/demo/reset").catch(() => undefined);
    }
    migrateLocalD1();
  }
  const response = await context.post("/api/demo/reset");
  if (!response.ok()) throw new Error(`Demo reset failed: ${response.status()} ${await response.text()}`);
  await context.dispose();
}
