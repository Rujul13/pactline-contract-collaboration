export function parseDrizzleStatements(rawSql) {
  if (typeof rawSql !== "string") return [];
  return rawSql
    .split(/--> statement-breakpoint/g)
    .map((stmt) => {
      const cleaned = stmt.replace(/--.*$/gm, "");
      return cleaned.replace(/[\r\n]+/g, " ").trim();
    })
    .filter((stmt) => stmt.length > 0);
}
