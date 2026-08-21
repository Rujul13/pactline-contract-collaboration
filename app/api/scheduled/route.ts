import { env } from "cloudflare:workers";
import { sweepReminderSchedules, processNotificationQueue } from "@/lib/notifications";
import { refreshAllOrganizationAlerts } from "@/lib/alerts";

export async function GET() {
  // Only allow running in dev/E2E mode
  if (process.env.NODE_ENV !== "development" && process.env.PACTLINE_E2E !== "true") {
    return new Response("Not found", { status: 404 });
  }

  try {
    await refreshAllOrganizationAlerts();
    await sweepReminderSchedules();
    await processNotificationQueue();

    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO app_settings (key, value, updated_at) VALUES ('cron_last_run_at', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
    ).bind(now, now).run();

    return Response.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 500 });
  }
}
