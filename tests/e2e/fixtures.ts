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
  if (!existsSync(D1_DIR)) return undefined;
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

  // Create migrations table if not exists
  db.exec("CREATE TABLE IF NOT EXISTS __drizzle_migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)");

  // Seed migrations for existing database if this is the first run using this tracker
  const hasContracts = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='contracts'").all().length > 0;
  const migrationCount = (db.prepare("SELECT COUNT(*) as count FROM __drizzle_migrations").get() as { count: number }).count;

  if (hasContracts && migrationCount === 0) {
    const files = readdirSync("drizzle").filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
    for (const file of files) {
      if (file < "0012_notification_idempotency.sql") {
        db.prepare("INSERT INTO __drizzle_migrations (name) VALUES (?)").run(file);
      }
    }
  }

  const applied = new Set(
    (db.prepare("SELECT name FROM __drizzle_migrations").all() as Array<{ name: string }>).map((row) => row.name)
  );

  const files = readdirSync("drizzle").filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
  for (const file of files) {
    if (!applied.has(file)) {
      console.log(`Applying E2E migration: ${file}`);
      db.exec(readFileSync(`drizzle/${file}`, "utf8").replaceAll("--> statement-breakpoint", ""));
      db.prepare("INSERT INTO __drizzle_migrations (name) VALUES (?)").run(file);
    }
  }

  db.close();
  migrated = true;
}

export async function resetDemo(): Promise<void> {
  const context = await playwrightRequest.newContext({
    baseURL: BASE_URL,
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { host: `localhost:${new URL(BASE_URL).port}` },
  });

  if (!migrated) {
    // Wait for Miniflare to materialize D1 database file by probing GET / instead of calling /api/demo/reset before tables exist
    let retries = 0;
    while ((!existsSync(D1_DIR) || !findDbFile()) && retries < 20) {
      await context.get("/").catch(() => undefined);
      if (existsSync(D1_DIR) && findDbFile()) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
      retries++;
    }
    migrateLocalD1();
  }

  const response = await context.post("/api/demo/reset");
  if (!response.ok()) throw new Error(`Demo reset failed: ${response.status()} ${await response.text()}`);
  await context.dispose();
}
