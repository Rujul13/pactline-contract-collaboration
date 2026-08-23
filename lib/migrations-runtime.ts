import { parseDrizzleStatements } from "./migration-parser.js";

const migrationModules = import.meta.glob<{ default: string }>("../drizzle/*.sql", {
  query: "?raw",
  eager: true,
});

function getSqlString(mod: unknown): string {
  if (typeof mod === "string") return mod;
  if (mod && typeof mod === "object") {
    if ("default" in mod) return getSqlString((mod as { default: unknown }).default);
  }
  return String(mod ?? "");
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

  const sortedEntries = Object.entries(migrationModules).sort(([pathA], [pathB]) =>
    pathA.localeCompare(pathB)
  );

  for (const [path, module] of sortedEntries) {
    const filename = path.split("/").pop();
    if (filename && !applied.has(filename)) {
      const rawSql = getSqlString(module);
      const statements = parseDrizzleStatements(rawSql);

      for (const statement of statements) {
        if (statement.trim()) {
          await db.exec(statement);
        }
      }

      await db
        .prepare("INSERT INTO __drizzle_migrations (name) VALUES (?)")
        .bind(filename)
        .run();
    }
  }
}
