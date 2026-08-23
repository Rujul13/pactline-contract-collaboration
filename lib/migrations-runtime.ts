import { env } from "cloudflare:workers";

const migrationModules = import.meta.glob<{ default: string }>("../drizzle/*.sql", {
  query: "?raw",
  eager: true,
});

export async function ensureMigrationsApplied(): Promise<void> {
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
      const rawSql = typeof module === "string" ? module : module.default;
      const sql = rawSql.replaceAll("--> statement-breakpoint", "");
      await db.exec(sql);
      await db
        .prepare("INSERT INTO __drizzle_migrations (name) VALUES (?)")
        .bind(filename)
        .run();
    }
  }

  // Self-healing check: restore notification_deliveries table if a test temporarily altered its name
  await db.exec(`
    CREATE TABLE IF NOT EXISTS notification_deliveries (
      id TEXT PRIMARY KEY NOT NULL,
      reminder_schedule_id TEXT,
      recipient_email TEXT NOT NULL,
      channel TEXT NOT NULL,
      template_name TEXT NOT NULL,
      template_payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error TEXT,
      idempotency_key TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (reminder_schedule_id) REFERENCES reminder_schedules(id) ON UPDATE CASCADE ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_deliveries_idempotency ON notification_deliveries (idempotency_key);
  `);
}
