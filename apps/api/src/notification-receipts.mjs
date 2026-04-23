import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "./http-error.mjs";
import { nextId } from "./store.mjs";
import { resolveNotificationProviderConfig } from "./notification-providers.mjs";

const NOTIFICATION_RECEIPT_TYPES = new Set([
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "complained",
  "unsubscribed",
  "failed",
  "deferred"
]);
const RECEIPT_FAILURE_TYPES = new Set(["bounced", "complained", "unsubscribed", "failed"]);
const RECEIPT_SUCCESS_TYPES = new Set(["delivered", "opened", "clicked"]);
const RECEIPT_SUPPRESSION_TYPES = new Set(["complained", "unsubscribed"]);
const RECEIPT_RESEND_BLOCKING_TYPES = new Set(["complained", "unsubscribed"]);
const RECEIPT_REVIEW_TYPES = new Set(["bounced", "failed", "deferred"]);

export function resolveNotificationWebhookSecret(channel, env = {}) {
  const normalizedChannel = String(channel).toLowerCase();
  const prefix = `NOTIFICATION_${normalizedChannel.toUpperCase()}`;
  return env[`${prefix}_WEBHOOK_SECRET`] ?? null;
}

export function assertNotificationWebhookAuthorized(channel, headers = {}, payload = {}, env = {}) {
  const providerConfig = resolveNotificationProviderConfig(channel, env);
  const configuredSecret = providerConfig.webhook_secret ?? resolveNotificationWebhookSecret(channel, env);
  if (providerConfig.webhook_auth_mode === "shared_secret") {
    if (!configuredSecret) {
      throw new HttpError(503, "Notification webhook is not configured for this channel");
    }
    const suppliedSecret = headers["x-notification-webhook-secret"] ?? headers["x-webhook-secret"] ?? null;
    if (!suppliedSecret || suppliedSecret !== configuredSecret) {
      throw new HttpError(403, "Notification webhook secret is invalid");
    }
    return;
  }
  if (providerConfig.webhook_auth_mode === "hmac_sha256") {
    if (!configuredSecret) {
      throw new HttpError(503, "Notification webhook HMAC secret is not configured");
    }
    const signatureHeaderName = String(providerConfig.webhook_signature_header ?? "x-notification-signature").toLowerCase();
    const timestampHeaderName = String(providerConfig.webhook_timestamp_header ?? "x-notification-timestamp").toLowerCase();
    const suppliedSignature = headers[signatureHeaderName] ?? headers[providerConfig.webhook_signature_header] ?? null;
    const suppliedTimestamp = headers[timestampHeaderName] ?? headers[providerConfig.webhook_timestamp_header] ?? null;
    if (!suppliedSignature || !suppliedTimestamp) {
      throw new HttpError(403, "Notification webhook signature headers are missing");
    }
    assertWebhookTimestampFresh(suppliedTimestamp, providerConfig.webhook_timestamp_tolerance_seconds ?? 300);
    const expectedSignature = createHmac("sha256", configuredSecret)
      .update(`${suppliedTimestamp}.${canonicalizePayload(payload)}`)
      .digest("hex");
    const normalizedSupplied = String(suppliedSignature).replace(/^sha256=/i, "");
    if (!secureCompare(normalizedSupplied, expectedSignature)) {
      throw new HttpError(403, "Notification webhook signature is invalid");
    }
    return;
  }
  if (providerConfig.webhook_auth_mode === "none") {
    throw new HttpError(403, "Notification webhook auth mode is not production-safe");
  }
  throw new HttpError(503, "Notification webhook auth is not configured for this channel");
}

export function normalizeNotificationReceipt(channel, payload = {}, receivedAt = new Date().toISOString()) {
  const receiptType = String(payload.receipt_type ?? payload.status ?? "").toLowerCase();
  if (!NOTIFICATION_RECEIPT_TYPES.has(receiptType)) {
    throw new HttpError(400, "Notification receipt_type is invalid");
  }
  const provider = payload.provider ?? payload.provider_name ?? `${channel}-provider`;
  const providerMessageId = payload.provider_message_id ?? null;
  const providerEventId = payload.provider_event_id ?? payload.event_id ?? null;
  const notificationId = payload.notification_id ?? payload.message_id ?? null;
  const occurredAt = payload.occurred_at ?? payload.timestamp ?? receivedAt;
  const summary = payload.summary ?? payload.error_message ?? payload.message ?? null;
  const dedupeIdentity = providerEventId ?? providerMessageId ?? notificationId ?? "unknown";
  const dedupeKey = payload.dedupe_key ?? [
    channel,
    provider,
    dedupeIdentity,
    receiptType,
    dedupeIdentity === "unknown" ? occurredAt : "stable"
  ].join(":");

  return {
    channel,
    provider,
    receipt_type: receiptType,
    provider_message_id: providerMessageId,
    provider_event_id: providerEventId,
    notification_id: notificationId,
    summary,
    payload: payload.payload ?? payload,
    occurred_at: occurredAt,
    received_at: receivedAt,
    dedupe_key: dedupeKey
  };
}

export async function ingestNotificationReceipt({
  repos,
  tenantId,
  channel,
  payload,
  receivedAt = new Date().toISOString(),
  initiatedBy = "notification-provider-webhook"
}) {
  const normalized = normalizeNotificationReceipt(channel, payload, receivedAt);
  const notification = await resolveNotificationForReceipt(repos, tenantId, normalized);
  if (!notification) {
    return {
      accepted: true,
      matched: false,
      deduplicated: false,
      receipt: null,
      notification: null,
      followup: null,
      reason: "notification_not_found"
    };
  }
  const existing = await repos.notificationReceipts.findByDedupeKey(tenantId, normalized.dedupe_key);
  if (existing) {
    return {
      accepted: true,
      matched: true,
      deduplicated: true,
      receipt: existing,
      notification,
      followup: await repos.followupMessages.findByNotificationId(tenantId, notification.id)
    };
  }

  const receipt = await repos.notificationReceipts.create({
    id: nextId("notification-receipt"),
    tenant_id: notification.tenant_id,
    notification_id: notification.id,
    provider: normalized.provider,
    channel: normalized.channel,
    receipt_type: normalized.receipt_type,
    provider_message_id: normalized.provider_message_id ?? notification.provider_message_id ?? null,
    provider_event_id: normalized.provider_event_id,
    dedupe_key: normalized.dedupe_key,
    summary: normalized.summary,
    payload: normalized.payload,
    occurred_at: normalized.occurred_at,
    received_at: normalized.received_at
  });

  const reconciliation = await reconcileNotificationReceipt({
    repos,
    tenantId,
    notification,
    receipt,
    receivedAt,
    initiatedBy
  });

  return {
    accepted: true,
    matched: true,
    deduplicated: false,
    receipt,
    notification: reconciliation.notification,
    followup: reconciliation.followup
  };
}

export async function buildNotificationReceiptHistory({
  repos,
  tenantId,
  eventId,
  query = {},
  now = new Date().toISOString()
}) {
  const receipts = await repos.notificationReceipts.listByEvent(tenantId, eventId);
  const recentHours = query.recent_hours != null
    ? parsePositiveInteger(query.recent_hours, 24)
    : null;
  const nowMs = Date.parse(now);
  return receipts
    .filter((entry) => !query.channel || entry.channel === query.channel)
    .filter((entry) => !query.provider || entry.provider === query.provider)
    .filter((entry) => !query.receipt_type || entry.receipt_type === query.receipt_type)
    .filter((entry) => !query.device_id || entry.interaction_id === query.device_id)
    .filter((entry) =>
      recentHours == null ||
      Date.parse(entry.occurred_at ?? entry.received_at) >= nowMs - recentHours * 60 * 60 * 1000
    )
    .map((entry) => ({
      id: entry.id,
      notification_id: entry.notification_id,
      event_id: entry.event_id ?? eventId,
      interaction_id: entry.interaction_id ?? null,
      provider: entry.provider,
      channel: entry.channel,
      receipt_type: entry.receipt_type,
      provider_message_id: entry.provider_message_id ?? null,
      provider_event_id: entry.provider_event_id ?? null,
      summary: entry.summary ?? null,
      payload: entry.payload ?? {},
      occurred_at: entry.occurred_at ?? null,
      received_at: entry.received_at
    }))
    .sort((left, right) => Date.parse(right.occurred_at ?? right.received_at) - Date.parse(left.occurred_at ?? left.received_at));
}

export async function buildNotificationReceiptGovernance({
  repos,
  tenantId,
  notification
}) {
  if (!notification?.id) {
    return {
      receipts: [],
      latest_receipt: null,
      latest_receipt_type: null,
      blocking_receipt: null,
      review_receipt: null,
      resend_blocked_reason: null,
      resend_review_reason: null
    };
  }
  const receipts = await repos.notificationReceipts.listByNotification(tenantId, notification.id);
  const latestReceipt = receipts[0] ?? null;
  const blockingReceipt = receipts.find((entry) => RECEIPT_RESEND_BLOCKING_TYPES.has(entry.receipt_type)) ?? null;
  const reviewReceipt = receipts.find((entry) => RECEIPT_REVIEW_TYPES.has(entry.receipt_type)) ?? null;
  const blockingSummary = blockingReceipt?.summary ? ` (${blockingReceipt.summary})` : "";
  const reviewSummary = reviewReceipt?.summary ? ` (${reviewReceipt.summary})` : "";
  return {
    receipts,
    latest_receipt: latestReceipt,
    latest_receipt_type: latestReceipt?.receipt_type ?? null,
    blocking_receipt: blockingReceipt,
    review_receipt: reviewReceipt,
    resend_blocked_reason: blockingReceipt
      ? `Provider receipt ${blockingReceipt.receipt_type} blocks resend for this attendee and channel${blockingSummary}.`
      : null,
    resend_review_reason: !blockingReceipt && reviewReceipt
      ? `Provider receipt ${reviewReceipt.receipt_type} requires operator review before resending${reviewSummary}.`
      : null
  };
}

export async function buildNotificationEngagementAnalytics({
  repos,
  tenantId,
  eventId,
  query = {},
  now = new Date().toISOString()
}) {
  const [receipts, attempts] = await Promise.all([
    buildNotificationReceiptHistory({ repos, tenantId, eventId, query, now }),
    repos.notificationAttempts.listByEvent(tenantId, eventId)
  ]);
  const sentAttempts = attempts
    .filter((entry) => entry.status === "sent")
    .filter((entry) => !query.channel || entry.channel === query.channel)
    .filter((entry) => !query.provider || entry.provider === query.provider)
    .filter((entry) => !query.device_id || entry.interaction_id === query.device_id);

  const summary = buildReceiptAggregate(receipts, sentAttempts.length);
  const byChannel = {};
  const byProvider = {};

  for (const receipt of receipts) {
    applyReceiptToAggregate(summary, receipt.receipt_type);
    if (receipt.channel) {
      if (!byChannel[receipt.channel]) {
        byChannel[receipt.channel] = buildReceiptAggregate([], countMatchingAttempts(sentAttempts, { channel: receipt.channel }));
      }
      applyReceiptToAggregate(byChannel[receipt.channel], receipt.receipt_type);
    }
    if (receipt.provider) {
      if (!byProvider[receipt.provider]) {
        byProvider[receipt.provider] = buildReceiptAggregate([], countMatchingAttempts(sentAttempts, { provider: receipt.provider }));
      }
      applyReceiptToAggregate(byProvider[receipt.provider], receipt.receipt_type);
    }
  }

  finalizeReceiptAggregate(summary);
  Object.values(byChannel).forEach(finalizeReceiptAggregate);
  Object.values(byProvider).forEach(finalizeReceiptAggregate);

  return {
    event_id: eventId,
    generated_at: now,
    filters: {
      channel: query.channel ?? null,
      provider: query.provider ?? null,
      device_id: query.device_id ?? null,
      recent_hours: query.recent_hours != null ? Number(query.recent_hours) : null
    },
    summary,
    by_channel: byChannel,
    by_provider: byProvider
  };
}

async function resolveNotificationForReceipt(repos, tenantId, receipt) {
  if (receipt.notification_id) {
    return repos.notifications.findById(tenantId, receipt.notification_id);
  }
  if (receipt.provider_message_id) {
    return repos.notifications.findByProviderMessageId(tenantId, receipt.provider_message_id);
  }
  return null;
}

async function reconcileNotificationReceipt({
  repos,
  tenantId,
  notification,
  receipt,
  receivedAt,
  initiatedBy
}) {
  let updatedNotification = notification;
  let updatedFollowup = await repos.followupMessages.findByNotificationId(tenantId, notification.id);

  if (RECEIPT_SUCCESS_TYPES.has(receipt.receipt_type)) {
    updatedNotification = await repos.notifications.update({
      ...notification,
      status: notification.status === "cancelled" ? "cancelled" : "sent",
      provider: receipt.provider ?? notification.provider,
      provider_message_id: receipt.provider_message_id ?? notification.provider_message_id,
      final_error: null,
      updated_at: receivedAt
    });
    if (updatedFollowup && updatedFollowup.status !== "cancelled") {
      updatedFollowup = await repos.followupMessages.update({
        ...updatedFollowup,
        status: "sent",
        updated_at: receivedAt
      });
    }
  } else if (RECEIPT_FAILURE_TYPES.has(receipt.receipt_type)) {
    const failureMessage = receipt.summary ?? `Provider receipt marked notification ${receipt.receipt_type}.`;
    updatedNotification = await repos.notifications.update({
      ...notification,
      status: notification.status === "cancelled" ? "cancelled" : "failed",
      provider: receipt.provider ?? notification.provider,
      provider_message_id: receipt.provider_message_id ?? notification.provider_message_id,
      next_attempt_at: null,
      final_error: failureMessage,
      retry_exhausted_at: null,
      retry_exhausted_reason: null,
      updated_at: receivedAt
    });
    if (updatedFollowup && updatedFollowup.status !== "cancelled") {
      updatedFollowup = await repos.followupMessages.update({
        ...updatedFollowup,
        status: "failed",
        updated_at: receivedAt
      });
    }
    if (RECEIPT_SUPPRESSION_TYPES.has(receipt.receipt_type)) {
      const existingSuppression = updatedNotification.interaction_id
        ? await repos.communicationSuppressions.findActiveByInteractionAndChannel(
            tenantId,
            updatedNotification.interaction_id,
            updatedNotification.channel
          )
        : null;
      if (!existingSuppression && updatedNotification.interaction_id) {
        const interaction = await repos.interactions.findById(tenantId, updatedNotification.interaction_id);
        await repos.communicationSuppressions.create({
          id: nextId("suppression"),
          tenant_id: updatedNotification.tenant_id,
          event_id: updatedNotification.event_id,
          interaction_id: updatedNotification.interaction_id,
          attendee_id: interaction.attendee_id ?? null,
          channel: updatedNotification.channel,
          status: "active",
          reason: receipt.receipt_type,
          source: "notification_receipt_webhook",
          created_at: receivedAt,
          updated_at: receivedAt
        });
      }
    }
  }

  await recordNotificationReceiptAudit({
    repos,
    tenantId,
    notificationId: notification.id,
    receipt,
    initiatedBy,
    now: receivedAt
  });

  return {
    notification: updatedNotification,
    followup: updatedFollowup
  };
}

async function recordNotificationReceiptAudit({
  repos,
  tenantId,
  notificationId,
  receipt,
  initiatedBy,
  now
}) {
  if (typeof repos.auditLogs?.create !== "function") {
    return;
  }
  await repos.auditLogs.create({
    id: nextId("audit"),
    tenant_id: tenantId,
    actor_type: "system",
    actor_id: initiatedBy,
    event_type: "notification.receipt.ingested",
    target_type: "notification",
    target_id: notificationId,
    break_glass_access_id: null,
    metadata: {
      provider: receipt.provider,
      channel: receipt.channel,
      receipt_type: receipt.receipt_type,
      provider_message_id: receipt.provider_message_id ?? null,
      provider_event_id: receipt.provider_event_id ?? null,
      summary: receipt.summary ?? null
    },
    created_at: now
  });
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function assertWebhookTimestampFresh(timestamp, toleranceSeconds) {
  const parsedTimestamp = /^\d+$/.test(String(timestamp))
    ? Number(timestamp) * 1000
    : Date.parse(String(timestamp));
  if (!Number.isFinite(parsedTimestamp)) {
    throw new HttpError(403, "Notification webhook timestamp is invalid");
  }
  const driftMs = Math.abs(Date.now() - parsedTimestamp);
  if (driftMs > Number(toleranceSeconds) * 1000) {
    throw new HttpError(403, "Notification webhook timestamp is outside the accepted window");
  }
}

function canonicalizePayload(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortValue(value[key]);
        return acc;
      }, {});
  }
  return value;
}

function secureCompare(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function buildReceiptAggregate(_receipts = [], sentCount = 0) {
  return {
    sent_count: sentCount,
    delivered: 0,
    opened: 0,
    clicked: 0,
    deferred: 0,
    bounced: 0,
    complained: 0,
    unsubscribed: 0,
    failed: 0,
    delivered_rate: null,
    open_rate: null,
    click_rate: null,
    complaint_rate: null,
    unsubscribe_rate: null,
    failure_rate: null
  };
}

function applyReceiptToAggregate(aggregate, receiptType) {
  if (aggregate[receiptType] != null) {
    aggregate[receiptType] += 1;
  }
}

function finalizeReceiptAggregate(aggregate) {
  const sentBase = aggregate.sent_count || 0;
  const deliveredBase = aggregate.delivered || 0;
  const openedBase = aggregate.opened || 0;
  aggregate.delivered_rate = sentBase ? roundRate(aggregate.delivered / sentBase) : null;
  aggregate.open_rate = deliveredBase ? roundRate(aggregate.opened / deliveredBase) : null;
  aggregate.click_rate = openedBase ? roundRate(aggregate.clicked / openedBase) : null;
  aggregate.complaint_rate = sentBase ? roundRate(aggregate.complained / sentBase) : null;
  aggregate.unsubscribe_rate = sentBase ? roundRate(aggregate.unsubscribed / sentBase) : null;
  aggregate.failure_rate = sentBase
    ? roundRate((aggregate.bounced + aggregate.complained + aggregate.unsubscribed + aggregate.failed) / sentBase)
    : null;
}

function countMatchingAttempts(attempts, filters) {
  return attempts.filter((entry) =>
    (!filters.channel || entry.channel === filters.channel) &&
    (!filters.provider || entry.provider === filters.provider)
  ).length;
}

function roundRate(value) {
  return Math.round(value * 1000) / 1000;
}
