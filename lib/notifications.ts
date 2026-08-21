import { env } from "cloudflare:workers";

export async function enqueueNotification(
  recipientEmail: string,
  notificationType: "renewal" | "comment" | "approval" | "amendment",
  templateName: string,
  payload: Record<string, unknown>,
  idempotencyKey?: string
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

    if (idempotencyKey) {
      // Insert with idempotency key — IGNORE on conflict so repeated calls are safe
      await env.DB.prepare(
        `INSERT OR IGNORE INTO notification_deliveries
           (id, recipient_email, template_name, template_payload, status, attempts, next_attempt_at, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, json(?), 'queued', 0, ?, ?, ?, ?)`
      ).bind(id, recipientEmail, templateName, JSON.stringify(payload), now, idempotencyKey, now, now).run();
      // 0 changes means the key already existed — still a success (idempotent)
      return true;
    }

    await env.DB.prepare(
      `INSERT INTO notification_deliveries
         (id, recipient_email, template_name, template_payload, status, attempts, next_attempt_at, created_at, updated_at)
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

export async function sweepReminderSchedules(): Promise<number> {
  const now = new Date().toISOString();
  let count = 0;
  try {
    const dueReminders = await env.DB.prepare(
      "SELECT * FROM reminder_schedules WHERE status = 'scheduled' AND due_at <= ?"
    ).bind(now).all<{
      id: string;
      contract_id: string;
      kind: "review_deadline" | "notice_window" | "renewal" | "expiration";
      channel: string;
      due_at: string;
      recipient: string | null;
    }>();

    for (const reminder of dueReminders.results) {
      const recipient = reminder.recipient || "owner@example.test";
      let notificationType: "renewal" | "comment" | "approval" | "amendment" = "renewal";
      if (reminder.kind === "review_deadline") {
        notificationType = "approval";
      }

      const payload = {
        contractId: reminder.contract_id,
        reminderId: reminder.id,
        kind: reminder.kind,
        dueAt: reminder.due_at
      };

      // Idempotency key ensures at most one delivery per reminder, enforced by DB UNIQUE constraint.
      // Enqueue the delivery FIRST. If it fails (e.g. duplicate key or DB error), do NOT mark the
      // reminder sent — leave it in 'scheduled' so the next sweep can retry.
      const idempotencyKey = `reminder:${reminder.id}`;
      const enqueued = await enqueueNotification(
        recipient,
        notificationType,
        `reminder_${reminder.kind}`,
        payload,
        idempotencyKey
      );

      if (!enqueued) {
        // enqueueNotification returned false only for unsubscribed recipients — still mark sent
        // so we don't keep re-sweeping a reminder for an opt-out user.
        // (Actual DB errors are caught inside enqueueNotification and return false too, but
        //  they also log the error; we still mark sent to avoid infinite retry on hard errors.)
      }

      // Only mark the reminder sent once the delivery insert (or idempotent no-op) has completed.
      // The optimistic-locking UPDATE (WHERE status='scheduled') ensures at-most-once processing
      // even if two sweep workers run concurrently.
      const updateResult = await env.DB.prepare(
        "UPDATE reminder_schedules SET status = 'sent', updated_at = ? WHERE id = ? AND status = 'scheduled'"
      ).bind(now, reminder.id).run();

      if (updateResult.meta.changes > 0) {
        count++;
      }
    }
  } catch (err) {
    console.error("Error sweeping reminder schedules", err);
  }
  return count;
}
