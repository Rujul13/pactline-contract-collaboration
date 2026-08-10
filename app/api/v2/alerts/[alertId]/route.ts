import { env } from "cloudflare:workers";
import { requireOwnerApi } from "@/lib/owner-boundary";
import { getOwnerOrganizationId } from "@/lib/v2";

export async function POST(request: Request, context: { params: Promise<{ alertId: string }> }) {
  const auth = await requireOwnerApi(request); if (auth.response) return auth.response; const organizationId = await getOwnerOrganizationId(auth.user.userId); const { alertId } = await context.params;
  const body = await request.json().catch(() => null) as { action?: "acknowledge" | "resolve" | "snooze"; snoozedUntil?: string } | null; if (!body || !["acknowledge", "resolve", "snooze"].includes(body.action ?? "")) return Response.json({ error: "Alert action is invalid" }, { status: 400 });
  const now = new Date().toISOString(); const status = body.action === "acknowledge" ? "acknowledged" : body.action === "resolve" ? "resolved" : "snoozed";
  const result = await env.DB.prepare("UPDATE alerts SET status=?,acknowledged_at=CASE WHEN ?='acknowledged' THEN ? ELSE acknowledged_at END,resolved_at=CASE WHEN ?='resolved' THEN ? ELSE resolved_at END,snoozed_until=CASE WHEN ?='snoozed' THEN ? ELSE NULL END,updated_at=? WHERE id=? AND organization_id=?").bind(status, status, now, status, now, status, body.snoozedUntil ?? null, now, alertId, organizationId).run();
  return result.meta.changes ? Response.json({ status }) : Response.json({ error: "Alert not found" }, { status: 404 });
}
