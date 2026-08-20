import { env } from "cloudflare:workers";

export async function enqueueNotification(
  recipientEmail: string,
  notificationType: "renewal" | "comment" | "approval" | "amendment",
  templateName: string,
  payload: Record<string, unknown>
): Promise<boolean> {
  const now = new Date().toISOString();

  try {
    const user = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(recipientEmail).first<{ id: string }>();
    if (user) {
      const pref = await env.DB.prepare(
        "SELECT unsubscribed FROM notification_preferences WHERE user_id = ? AND notification_type = ?"
      ).bind(user.id, notificationType).first<{ unsubscribed: boolean }>();
      if (pref?.unsubscribed) {
        console.log(`Notification skipped for ${recipientEmail} due to unsubscribe (type: ${notificationType})`);
        return false;
      }
    }

    const portalAccount = await env.DB.prepare("SELECT id FROM portal_accounts WHERE email = ?").bind(recipientEmail).first<{ id: string }>();
    if (portalAccount) {
      const pref = await env.DB.prepare(
        "SELECT unsubscribed FROM notification_preferences WHERE portal_account_id = ? AND notification_type = ?"
      ).bind(portalAccount.id, notificationType).first<{ unsubscribed: boolean }>();
      if (pref?.unsubscribed) {
        console.log(`Notification skipped for ${recipientEmail} due to unsubscribe (type: ${notificationType})`);
        return false;
      }
    }

    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO notification_deliveries (id, recipient_email, template_name, template_payload, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, json(?), 'queued', 0, ?, ?, ?)`
    ).bind(id, recipientEmail, templateName, JSON.stringify(payload), now, now, now).run();

    return true;
  } catch (err) {
    console.error("Failed to enqueue notification", err);
    return false;
  }
}

export async function processNotificationQueue(): Promise<{ processed: number; failed: number }> {
  const now = new Date().toISOString();
  let processed = 0;
  let failed = 0;

  try {
    const deliveries = await env.DB.prepare(
      `SELECT * FROM notification_deliveries
       WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) AND attempts < 5
       LIMIT 50`
    ).bind(now).all<{
      id: string;
      recipient_email: string;
      template_name: string;
      template_payload: string;
      status: string;
      attempts: number;
      next_attempt_at: string | null;
      last_error: string | null;
      created_at: string;
      updated_at: string;
    }>();

    for (const delivery of deliveries.results) {
      const attempts = delivery.attempts + 1;
      try {
        console.log(`[STUB NOTIFICATION QUEUE] Logged to stub queue delivery deliveryId: ${delivery.id} to: ${delivery.recipient_email} using template: ${delivery.template_name}`);

        await env.DB.prepare(
          "UPDATE notification_deliveries SET status = 'logged', attempts = ?, updated_at = ? WHERE id = ?"
        ).bind(attempts, new Date().toISOString(), delivery.id).run();

        processed++;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        const backoffSeconds = Math.pow(2, attempts) * 30;
        const nextAttempt = new Date(Date.now() + backoffSeconds * 1000).toISOString();

        await env.DB.prepare(
          `UPDATE notification_deliveries
           SET attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
           WHERE id = ?`
        ).bind(attempts, nextAttempt, message, new Date().toISOString(), delivery.id).run();

        failed++;
      }
    }
  } catch (err) {
    console.error("Error processing notification queue", err);
  }

  return { processed, failed };
}
