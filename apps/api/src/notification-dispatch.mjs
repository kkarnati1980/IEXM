import { createHash } from "node:crypto";
import { nextId } from "./store.mjs";
import { renderTemplate } from "./notification-templates.mjs";

export async function dispatchTransactionalEmail({
  repos,
  tenantId,
  recipientEmail,
  messageType,
  templateVars = {},
  actorUserId = null
}) {
  const now = new Date().toISOString();
  const { subject, html, text, body } = renderTemplate(messageType, templateVars);
  const recipientHash = createHash("sha256")
    .update(`email:${String(recipientEmail).trim().toLowerCase()}`)
    .digest("hex");

  return repos.notifications.create({
    id: nextId("notification"),
    tenant_id: tenantId,
    event_id: null,
    interaction_id: null,
    channel: "email",
    message_type: messageType,
    status: "queued",
    provider: null,
    recipient_hash: recipientHash,
    system_payload: { recipient_email: recipientEmail, subject, html, text, body },
    consent_checked_at: null,
    sending_started_at: null,
    last_attempt_at: null,
    next_attempt_at: now,
    attempts_count: 0,
    provider_message_id: null,
    final_error: null,
    created_by_user_id: actorUserId,
    approved_by_user_id: null,
    created_at: now,
    updated_at: now
  });
}
