import { env } from "cloudflare:workers";

export class MutationConflictError extends Error {
  constructor(message = "The document changed during this operation") {
    super(message);
    this.name = "MutationConflictError";
  }
}

type Statement = ReturnType<typeof env.DB.prepare>;

export function mutationGuard(conditionSql: string, bindings: unknown[] = []) {
  const id = crypto.randomUUID();
  const statement = env.DB.prepare(`
    INSERT INTO mutation_guards (id, satisfied, created_at)
    VALUES (?, CASE WHEN (${conditionSql}) THEN 1 ELSE 0 END, CURRENT_TIMESTAMP)
  `).bind(id, ...bindings);
  return { id, statement };
}

export async function guardedBatch(guard: { id: string; statement: Statement }, operations: Statement[]) {
  try {
    const results = await env.DB.batch([
      guard.statement,
      ...operations,
      env.DB.prepare("DELETE FROM mutation_guards WHERE id = ?").bind(guard.id),
    ]);
    return results.slice(1, -1);
  } catch (error) {
    console.warn(JSON.stringify({ event: "mutation.conflict", guardId: guard.id, error: error instanceof Error ? error.message : "unknown" }));
    throw new MutationConflictError();
  }
}
