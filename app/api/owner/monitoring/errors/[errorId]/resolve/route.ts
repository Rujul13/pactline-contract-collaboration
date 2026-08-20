import { env } from "cloudflare:workers";
import { requireOwnerApi } from "@/lib/owner-boundary";
import { withMonitoring } from "@/lib/monitoring";

export const POST = withMonitoring(async function POST(request: Request, context: { params: Promise<{ errorId: string }> }) {
  const auth = await requireOwnerApi(request);
  if (auth.response) return auth.response;

  const { errorId } = await context.params;
  const now = new Date().toISOString();

  try {
    const result = await env.DB.prepare("UPDATE error_events SET resolved_at=? WHERE id=? AND resolved_at IS NULL")
      .bind(now, errorId).run();

    if (result.meta.changes === 0) {
      return Response.json({ error: "Error event not found or already resolved" }, { status: 404 });
    }

    return Response.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}, "/api/owner/monitoring/errors/:errorId/resolve");
