export function parseDrizzleStatements(rawSql) {
  return rawSql
    .split(/--> statement-breakpoint/g)
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);
}
