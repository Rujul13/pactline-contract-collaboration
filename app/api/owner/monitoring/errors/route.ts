import { env } from "cloudflare:workers";
import { requireOwnerApi } from "@/lib/owner-boundary";
import { withMonitoring } from "@/lib/monitoring";

export const GET = withMonitoring(async function GET(request: Request) {
  if (request.headers.get("x-trigger-error") === "true") {
    const customMsg = request.headers.get("x-trigger-error-msg");
    throw new Error(customMsg || "Deliberate test error for monitoring");
  }

  const auth = await requireOwnerApi(request);
  if (auth.response) return auth.response;

  const url = new URL(request.url);
  const showResolved = url.searchParams.get("resolved") === "true";

  let query = "SELECT * FROM error_events WHERE resolved_at IS ";
  query += showResolved ? "NOT NULL" : "NULL";
  query += " ORDER BY last_seen_at DESC LIMIT 100";

  try {
    const errors = await env.DB.prepare(query).all<{
      id: string;
      request_id: string;
      route: string;
      method: string;
      actor_scope: string;
      contract_id: string | null;
      severity: string;
      message: string;
      fingerprint: string;
      metadata: string | Record<string, unknown>;
      occurrence_count: number;
      first_seen_at: string;
      last_seen_at: string;
      resolved_at: string | null;
    }>();
    const parsedErrors = errors.results.map((row) => ({
      ...row,
      metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata
    }));
    return Response.json({ errors: parsedErrors });
  } catch (err) {
    console.error("Error fetching monitoring errors", err);
    return Response.json({ error: "Internal Server Error" }, { status: 500 });
  }
}, "/api/owner/monitoring/errors");
