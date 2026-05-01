// Email delivery worker — polls notifications for queued transactional emails
// and sends them via ZeptoMail HTTP API. Never crashes; all errors are caught and logged.

const MAX_ATTEMPTS = 3;

async function sendEmail({ to, toName, subject, html, text }, env) {
  const apiKey = env.SMTP_PASS;
  const fromAddress = env.SMTP_FROM || "noreply@communication.feturtles.com";
  const fromName = env.SMTP_FROM_NAME || "Codex Platform";

  const response = await fetch("https://api.zeptomail.in/v1.1/email", {
    method: "POST",
    headers: {
      Authorization: "Zoho-enczapikey " + apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: { address: fromAddress, name: fromName },
      to: [{ email_address: { address: to, name: toName || to } }],
      subject: subject,
      htmlbody: html,
      textbody: text
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error("ZeptoMail API error " + response.status + ": " + body);
  }
  return true;
}

export function startEmailDeliveryWorker(repos, state, intervalMs = 30_000) {
  const handle = setInterval(() => {
    runEmailDeliveryBatchOnce(repos).catch((err) => {
      console.error("[email-delivery] Unexpected error:", err.message);
    });
  }, intervalMs);
  handle.unref();
  return handle;
}

export async function runEmailDeliveryBatchOnce(repos, env = process.env, sendEmailFn = sendEmail) {
  const tenants = await repos.tenants.listAll();
  for (const tenant of tenants) {
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
        await processSend(repos, notification, env, sendEmailFn);
      } catch (err) {
        console.error(`[email-delivery] Failed to process ${notification.id}:`, err.message);
      }
    }
  }
}

async function processSend(repos, notification, env, sendEmailFn) {
  const { recipient_email, subject, body, html, text } = notification.system_payload;
  const now = new Date().toISOString();
  const attempts = Number(notification.attempts_count ?? 0) + 1;

  let success = false;
  let errorMessage = null;

  try {
    await sendEmailFn(
      {
        to: recipient_email,
        toName: recipient_email,
        subject,
        html: html ?? body ?? "",
        text: text ?? body ?? ""
      },
      env
    );
    success = true;
  } catch (err) {
    errorMessage = err.message;
    console.error(`[email-delivery] ZeptoMail error for ${notification.id}:`, err.message);
  }

  if (success) {
    await repos.notifications.update({
      ...notification,
      status: "sent",
      provider: "zeptomail",
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
