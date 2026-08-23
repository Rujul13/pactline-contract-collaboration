import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function parseDrizzleStatements(rawSql: string): string[] {
  return rawSql
    .split(/--> statement-breakpoint/g)
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);
}

function getMigrationFiles(): Record<string, string> {
  const globFn = (import.meta as unknown as { glob?: (pattern: string, options?: unknown) => unknown }).glob;
  if (typeof globFn === "function") {
    const modules = globFn("../drizzle/*.sql", {
      query: "?raw",
      eager: true,
    }) as Record<string, string | { default: string }>;
    const result: Record<string, string> = {};
    for (const [path, mod] of Object.entries(modules)) {
      result[path] = typeof mod === "string" ? mod : mod.default;
    }
    return result;
  }

  const drizzleDir = join(process.cwd(), "drizzle");
  const files = readdirSync(drizzleDir)
    .filter((name) => /^\d{4}.*\.sql$/.test(name))
    .sort();
  const result: Record<string, string> = {};
  for (const file of files) {
    result[`../drizzle/${file}`] = readFileSync(join(drizzleDir, file), "utf8");
  }
  return result;
}

export async function ensureMigrationsApplied(): Promise<void> {
  const { env } = await import("cloudflare:workers");
  const db = env.DB;
  await db.exec(
    "CREATE TABLE IF NOT EXISTS __drizzle_migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)"
  );

  const appliedRows = await db
    .prepare("SELECT name FROM __drizzle_migrations")
    .all<{ name: string }>();
  const applied = new Set((appliedRows.results ?? []).map((r) => r.name));

  const migrationFiles = getMigrationFiles();
  const sortedEntries = Object.entries(migrationFiles).sort(([pathA], [pathB]) =>
    pathA.localeCompare(pathB)
  );

  for (const [path, rawSql] of sortedEntries) {
    const filename = path.split("/").pop();
    if (filename && !applied.has(filename)) {
      const statements = parseDrizzleStatements(rawSql);

      for (const statement of statements) {
        await db.exec(statement);
      }

      await db
        .prepare("INSERT INTO __drizzle_migrations (name) VALUES (?)")
        .bind(filename)
        .run();
    }
  }
}
