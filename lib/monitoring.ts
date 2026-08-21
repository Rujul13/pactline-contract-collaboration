import { env } from "cloudflare:workers";
import { sha256Hex } from "./security";

type ErrorContext = {
  requestId: string;
  route: string;
  method: string;
  actorScope: "owner" | "reviewer" | "supplier" | "system";
  contractId?: string | null;
  severity?: "warning" | "error" | "critical";
  metadata?: Record<string, unknown>;
};

export function shouldRedact(key: string): boolean {
  const lower = key.toLowerCase();

  // 1. Redact Authorization, Proxy-Authorization, X-API-Key
  if (lower === "authorization" || lower === "proxy-authorization" || lower === "x-api-key") {
    return true;
  }

  // 2. Redact cookie variants
  if (lower.includes("cookie")) {
    return true;
  }

  // 3. Redact case/format variants of password, token, key, secret
  if (
    lower.includes("password") ||
    lower.includes("token") ||
    lower.includes("key") ||
    lower.includes("secret")
  ) {
    return true;
  }

  // 4. Case/format variants of original sensitive fields
  const originalSensitive = [
    "body", "prompt", "proposedtext", "proposed_text",
    "currenttext", "current_text", "originaltext", "original_text"
  ];
  if (originalSensitive.some(k => lower.includes(k) || lower === k)) {
    return true;
  }

  return false;
}

/**
 * Classifies an error into a safe allow-listed category for storage.
 * Raw exception text is NEVER persisted — only the category is stored.
 */
export function classifyError(error: unknown): string {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (msg.includes("not found") || msg.includes("no such") || msg.includes("404")) {
    return "resource_not_found";
  }
  if (msg.includes("unauthorized") || msg.includes("forbidden") || msg.includes("401") || msg.includes("403")) {
    return "authorization_failure";
  }
  if (msg.includes("constraint") || msg.includes("unique") || msg.includes("conflict")) {
    return "constraint_violation";
  }
  if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("deadline")) {
    return "timeout";
  }
  if (msg.includes("network") || msg.includes("connection") || msg.includes("econnrefused")) {
    return "network_error";
  }
  return "application_error";
}

/** @deprecated Use classifyError instead. Kept for backward compatibility with existing tests. */
export function sanitizeErrorMessage(message: string): string {
  const lower = message.toLowerCase();
  const containsSensitive = [
    "password", "token", "key", "secret", "cookie", "authorization",
    "proxy-authorization", "api-key", "body", "prompt", "proposedtext",
    "proposed_text", "currenttext", "current_text", "originaltext", "original_text"
  ].some(k => lower.includes(k));
  if (containsSensitive) {
    return "An operational error occurred (sanitized)";
  }
  // Even for messages without sensitive keywords, we now always return the safe category string
  // to guarantee no raw exception text is ever persisted.
  return "An operational error occurred (sanitized)";
}

/** Sanitizes query parameters and request bodies to redact credentials, prompts, and contract text. */
export function sanitizeData(data: unknown): unknown {
  if (typeof data !== "object" || data === null) {
    return data;
  }
  if (Array.isArray(data)) {
    return data.map(sanitizeData);
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (shouldRedact(key)) {
      sanitized[key] = "[REDACTED]";
    } else {
      sanitized[key] = sanitizeData(value);
    }
  }
  return sanitized;
}

export function sanitizeUrl(urlStr: string): string {
  try {
    const url = new URL(urlStr);
    for (const key of url.searchParams.keys()) {
      if (shouldRedact(key)) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    return url.pathname + url.search;
  } catch {
    return urlStr;
  }
}

/** Records a sanitized, deduplicated operational event without contract text or secrets. */
export async function captureError(error: unknown, context: ErrorContext) {
  // Never persist raw exception text. Store only an allow-listed error category.
  const message = classifyError(error);
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

    // Check optional webhook alert
    if (env.MONITORING_ALERT_WEBHOOK_URL && context.severity === "critical") {
      await fetch(env.MONITORING_ALERT_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: `Critical operational error in Pactline:\nRoute: ${context.route}\nMessage: ${message}\nRequest ID: ${context.requestId}`
        })
      }).catch(e => console.error("Failed to send webhook alert", e));
    }

    return id;
  } catch (monitoringError) {
    console.error("Pactline monitoring write failed", monitoringError);
    return null;
  }
}

type RouteHandler = (request: Request, context: unknown) => Promise<Response>;

/** Route-level wrapper for automatic error capture, requestId propagation, and request/payload sanitization. */
export function withMonitoring(handler: RouteHandler, routeName: string): RouteHandler {
  return async (request: Request, context: unknown) => {
    const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
    const url = new URL(request.url);
    const sanitizedPath = sanitizeUrl(request.url);

    // Determine actor scope based on route
    let actorScope: "owner" | "reviewer" | "supplier" | "system" = "system";
    if (url.pathname.includes("/api/owner/")) {
      actorScope = "owner";
    } else if (url.pathname.includes("/api/client/")) {
      actorScope = "reviewer";
    } else if (url.pathname.includes("/api/portal/")) {
      actorScope = "supplier";
    }

    // Extract contractId if present
    let contractId: string | null = null;
    const pathSegments = url.pathname.split("/");
    const contractsIdx = pathSegments.indexOf("contracts");
    if (contractsIdx !== -1 && pathSegments[contractsIdx + 1]) {
      contractId = pathSegments[contractsIdx + 1];
    }

    try {
      const response = await handler(request, context);
      try {
        response.headers.set("x-request-id", requestId);
      } catch {}
      return response;
    } catch (error) {
      console.error(`Error in route ${routeName}:`, error);

      // Sanitize request metadata
      const queryParams = Object.fromEntries(url.searchParams.entries());
      let bodyData: unknown = null;
      try {
        const clonedRequest = request.clone();
        bodyData = await clonedRequest.json().catch(() => null);
      } catch {}

      const sanitizedMetadata = sanitizeData({
        url: sanitizedPath,
        query: queryParams,
        body: bodyData,
        headers: Object.fromEntries(request.headers.entries())
      }) as Record<string, unknown>;

      await captureError(error, {
        requestId,
        route: routeName,
        method: request.method,
        actorScope,
        contractId,
        severity: "error",
        metadata: sanitizedMetadata
      });

      const errorResponse = Response.json(
        { error: "Internal Server Error", requestId },
        { status: 500 }
      );
      try {
        errorResponse.headers.set("x-request-id", requestId);
      } catch {}
      return errorResponse;
    }
  };
}
