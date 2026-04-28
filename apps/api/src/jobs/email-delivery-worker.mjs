// Email delivery worker — polls notifications for queued transactional emails
// and sends them via SendGrid. Never crashes; all errors are caught and logged.

const SENDGRID_URL = "https://api.sendgrid.com/v3/mail/send";
const MAX_ATTEMPTS = 3;

export function startEmailDeliveryWorker(repos, state, intervalMs = 30_000) {
  const handle = setInterval(() => {
    runEmailDeliveryBatchOnce(repos, state).catch((err) => {
      console.error("[email-delivery] Unexpected error:", err.message);
    });
  }, intervalMs);
  handle.unref();
  return handle;
}

export async function runEmailDeliveryBatchOnce(repos, state, env = process.env) {
  for (const tenant of state.tenants) {
    let queued;
    try {
      queued = await repos.notifications.listQueued(tenant.id, {});
    } catch (err) {
      console.error(`[email-delivery] Failed to list queued for tenant ${tenant.id}:`, err.message);
      continue;
    }
    const transactional = queued.filter((n) => n.system_payload?.recipient_email);
    for (const notification of transactional) {
      try {
        await processSend(repos, notification, env);
      } catch (err) {
        console.error(`[email-delivery] Failed to process ${notification.id}:`, err.message);
      }
    }
  }
}

async function processSend(repos, notification, env) {
  const { recipient_email, subject, body, html, text } = notification.system_payload;
  const now = new Date().toISOString();
  const attempts = Number(notification.attempts_count ?? 0) + 1;

  let success = false;
  let errorMessage = null;

  try {
    const res = await fetch(SENDGRID_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.SENDGRID_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: recipient_email }] }],
        from: { email: env.EMAIL_FROM, name: env.EMAIL_FROM_NAME ?? "Codex Platform" },
        subject,
        content: [
          { type: "text/plain", value: text ?? body ?? "" },
          { type: "text/html", value: html ?? body ?? "" }
        ]
      })
    });
    if (res.status === 202) {
      success = true;
    } else {
      errorMessage = `SendGrid returned HTTP ${res.status}`;
    }
  } catch (err) {
    errorMessage = err.message;
    console.error(`[email-delivery] fetch error for ${notification.id}:`, err.message);
  }

  if (success) {
    await repos.notifications.update({
      ...notification,
      status: "sent",
      provider: "sendgrid",
      attempts_count: attempts,
      last_attempt_at: now,
      final_error: null,
      updated_at: now
    });
    console.log(`[email-delivery] Sent ${notification.id} to ${recipient_email}`);
  } else {
    const isDead = attempts >= MAX_ATTEMPTS;
    await repos.notifications.update({
      ...notification,
      status: isDead ? "dead_letter" : "queued",
      attempts_count: attempts,
      last_attempt_at: now,
      final_error: errorMessage,
      updated_at: now
    });
    if (isDead) {
      console.error(
        `[email-delivery] ${notification.id} moved to dead_letter after ${attempts} attempts: ${errorMessage}`
      );
    }
  }
}
