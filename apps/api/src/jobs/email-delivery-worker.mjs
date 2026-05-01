// Email delivery worker — polls notifications for queued transactional emails
// and sends them via SMTP (nodemailer). Never crashes; all errors are caught and logged.

import nodemailer from "nodemailer";

const MAX_ATTEMPTS = 3;

function createTransporter(env) {
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT) || 587,
    secure: env.SMTP_PORT === "465",
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASS
    }
  });
}

export function startEmailDeliveryWorker(repos, state, intervalMs = 30_000) {
  const handle = setInterval(() => {
    runEmailDeliveryBatchOnce(repos, state).catch((err) => {
      console.error("[email-delivery] Unexpected error:", err.message);
    });
  }, intervalMs);
  handle.unref();
  return handle;
}

export async function runEmailDeliveryBatchOnce(repos, state, env = process.env, createTransportFn = createTransporter) {
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
        await processSend(repos, notification, env, createTransportFn);
      } catch (err) {
        console.error(`[email-delivery] Failed to process ${notification.id}:`, err.message);
      }
    }
  }
}

async function processSend(repos, notification, env, createTransportFn) {
  const { recipient_email, subject, body, html, text } = notification.system_payload;
  const now = new Date().toISOString();
  const attempts = Number(notification.attempts_count ?? 0) + 1;

  let success = false;
  let errorMessage = null;

  try {
    const transporter = createTransportFn(env);
    const fromName = env.SMTP_FROM_NAME ?? "Codex Platform";
    const fromAddr = env.SMTP_FROM;
    await transporter.sendMail({
      from: `${fromName} <${fromAddr}>`,
      to: recipient_email,
      subject,
      text: text ?? body ?? "",
      html: html ?? body ?? ""
    });
    success = true;
  } catch (err) {
    errorMessage = err.message;
    console.error(`[email-delivery] SMTP error for ${notification.id}:`, err.message);
  }

  if (success) {
    await repos.notifications.update({
      ...notification,
      status: "sent",
      provider: "smtp",
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
