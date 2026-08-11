import { env } from "cloudflare:workers";
import { sha256Hex } from "./security";

type ErrorContext = {
  requestId: string;
  route: string;
  method: string;
  actorScope: "owner" | "reviewer" | "supplier" | "system";
  contractId?: string | null;
  severity?: "warning" | "error" | "critical";
  metadata?: Record<string, string | number | boolean | null>;
};

/** Records a sanitized, deduplicated operational event without contract text or secrets. */
export async function captureError(error: unknown, context: ErrorContext) {
  const message = error instanceof Error ? error.message.slice(0, 500) : "Unknown application error";
  const fingerprint = await sha256Hex(`${context.route}\n${message}`);
  const now = new Date().toISOString();
  try {
    const existing = await env.DB.prepare("SELECT id FROM error_events WHERE fingerprint=? AND resolved_at IS NULL ORDER BY last_seen_at DESC LIMIT 1").bind(fingerprint).first<{ id: string }>();
    if (existing) {
      await env.DB.prepare("UPDATE error_events SET occurrence_count=occurrence_count+1,last_seen_at=?,request_id=?,metadata=json(?),severity=? WHERE id=?")
        .bind(now, context.requestId, JSON.stringify(context.metadata ?? {}), context.severity ?? "error", existing.id).run();
      return existing.id;
    }
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO error_events (id,request_id,route,method,actor_scope,contract_id,severity,message,fingerprint,metadata,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,json(?),?,?)")
      .bind(id, context.requestId, context.route, context.method, context.actorScope, context.contractId ?? null, context.severity ?? "error", message, fingerprint, JSON.stringify(context.metadata ?? {}), now, now).run();
    return id;
  } catch (monitoringError) {
    console.error("Pactline monitoring write failed", monitoringError);
    return null;
  }
}
