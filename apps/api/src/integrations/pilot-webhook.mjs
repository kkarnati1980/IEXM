import { HttpError } from "../http-error.mjs";

export async function dispatchPilotWebhookDeletion({
  targetSystem,
  interactionId,
  attendeeId,
  reason
}) {
  if (!targetSystem || !isWebhookTarget(targetSystem)) {
    throw new HttpError(409, "Webhook dispatch requires a webhook target system");
  }

  const deliveredAt = new Date().toISOString();
  return {
    target_system: targetSystem,
    delivered_at: deliveredAt,
    response_payload: {
      target_system: targetSystem,
      operation: "delete",
      delivery_status: "delivered",
      interaction_id: interactionId ?? null,
      attendee_id: attendeeId ?? null,
      reason: reason ?? null
    }
  };
}

export function isWebhookTarget(targetSystem) {
  return String(targetSystem || "").toLowerCase().includes("webhook");
}
