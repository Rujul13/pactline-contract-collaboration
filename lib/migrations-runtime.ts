import { parseDrizzleStatements } from "./migration-parser.js";

const migrationModules = import.meta.glob<string>("../drizzle/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

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
