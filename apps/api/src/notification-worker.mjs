import { HttpError } from "./http-error.mjs";
import { nextId } from "./store.mjs";
import { buildNotificationReceiptGovernance } from "./notification-receipts.mjs";
import {
  resolveNotificationProviderConfig,
  sendNotificationWithProvider
} from "./notification-providers.mjs";

const FINAL_NOTIFICATION_STATUSES = new Set(["sent", "failed", "cancelled"]);
const SKIP_PROCESSING_STATUSES = new Set(["sent", "cancelled"]);
const DEFAULT_NOTIFICATION_MAX_ATTEMPTS = 3;
const DEFAULT_NOTIFICATION_RETRY_DELAY_MINUTES = 15;
const DEFAULT_NOTIFICATION_DEAD_LETTER_ALERT_THRESHOLD = 5;

export function resolveNotificationProvider(channel, env = {}) {
  return resolveNotificationProviderConfig(channel, env);
}

export function resolveNotificationRetryPolicy(env = {}) {
  return {
    max_attempts: parsePositiveInteger(env.NOTIFICATION_MAX_ATTEMPTS, DEFAULT_NOTIFICATION_MAX_ATTEMPTS),
    retry_delay_minutes: parsePositiveInteger(
      env.NOTIFICATION_RETRY_DELAY_MINUTES,
      DEFAULT_NOTIFICATION_RETRY_DELAY_MINUTES
    ),
    dead_letter_alert_threshold: parsePositiveInteger(
      env.NOTIFICATION_DEAD_LETTER_ALERT_THRESHOLD,
      DEFAULT_NOTIFICATION_DEAD_LETTER_ALERT_THRESHOLD
    )
  };
}

export function deriveNotificationQueueState(notification, nowIso = new Date().toISOString()) {
  if (!notification) {
    return "unknown";
  }
  if (notification.retry_exhausted_at) {
    return "dead_letter";
  }
  if (notification.status !== "queued") {
    return notification.status;
  }
  if (
    notification.last_attempt_at &&
    notification.final_error &&
    notification.next_attempt_at &&
    Date.parse(notification.next_attempt_at) > Date.parse(nowIso)
  ) {
    return "temporary_failure";
  }
  return "queued";
}

export async function buildNotificationQueueMetrics({ repos, tenantId, eventId, now = new Date().toISOString() }) {
  const notifications = await repos.notifications.listByEvent(tenantId, eventId);
  const counts = {
    queued_ready: 0,
    temporary_failure: 0,
    sending: 0,
    dead_letter: 0,
    failed: 0,
    sent: 0,
    cancelled: 0,
    total: notifications.length
  };
  const byChannel = {};

  for (const notification of notifications) {
    const queueState = deriveNotificationQueueState(notification, now);
    if (queueState === "queued") {
      counts.queued_ready += 1;
    }
    if (queueState === "temporary_failure") {
      counts.temporary_failure += 1;
    }
    if (queueState === "sending") {
      counts.sending += 1;
    }
    if (!byChannel[notification.channel]) {
      byChannel[notification.channel] = {
        total: 0,
        queued_ready: 0,
        temporary_failure: 0,
        sending: 0,
        dead_letter: 0,
        failed: 0,
        sent: 0,
        cancelled: 0
      };
    }
    const channelCounts = byChannel[notification.channel];
    channelCounts.total += 1;
    if (queueState === "queued") {
      channelCounts.queued_ready += 1;
    } else if (queueState === "temporary_failure") {
      channelCounts.temporary_failure += 1;
    } else if (queueState === "sending") {
      channelCounts.sending += 1;
    } else if (queueState === "dead_letter") {
      counts.dead_letter += 1;
      channelCounts.dead_letter += 1;
    } else if (queueState === "failed") {
      counts.failed += 1;
      channelCounts.failed += 1;
    } else if (queueState === "sent") {
      counts.sent += 1;
      channelCounts.sent += 1;
    } else if (queueState === "cancelled") {
      counts.cancelled += 1;
      channelCounts.cancelled += 1;
    }
  }

  return {
    event_id: eventId,
    generated_at: now,
    counts,
    by_channel: byChannel
  };
}

export async function buildNotificationQueueInventory({
  repos,
  tenantId,
  eventId,
  query = {},
  now = new Date().toISOString()
}) {
  const notifications = await repos.notifications.listByEvent(tenantId, eventId);
  const mapped = await Promise.all(notifications.map(async (notification) => {
    const followup = await repos.followupMessages.findByNotificationId(tenantId, notification.id);
    const attempts = await repos.notificationAttempts.listByNotification(tenantId, notification.id);
    const receiptGovernance = await buildNotificationReceiptGovernance({
      repos,
      tenantId,
      notification
    });
    const latestAttempt = attempts.at(-1) ?? null;
    return {
      id: notification.id,
      event_id: notification.event_id,
      interaction_id: notification.interaction_id,
      followup_id: followup?.id ?? null,
      channel: notification.channel,
      provider: notification.provider ?? latestAttempt?.provider ?? null,
      status: notification.status,
      queue_state: deriveNotificationQueueState(notification, now),
      message_type: notification.message_type,
      attempts_count: Number(notification.attempts_count ?? attempts.length),
      latest_attempt_status: latestAttempt?.status ?? null,
      latest_attempt_at: latestAttempt?.attempted_at ?? notification.last_attempt_at ?? null,
      latest_attempt_provider: latestAttempt?.provider ?? null,
      latest_attempt_http_status: latestAttempt?.http_status ?? null,
      latest_attempt_duration_ms: latestAttempt?.duration_ms ?? null,
      latest_attempt_response_excerpt: latestAttempt?.response_excerpt ?? null,
      latest_receipt_type: receiptGovernance.latest_receipt_type,
      provider_message_id: notification.provider_message_id ?? latestAttempt?.provider_message_id ?? null,
      last_error: notification.final_error ?? latestAttempt?.error_message ?? null,
      retry_exhausted_at: notification.retry_exhausted_at ?? null,
      retry_exhausted_reason: notification.retry_exhausted_reason ?? null,
      resend_blocked_reason: receiptGovernance.resend_blocked_reason,
      resend_review_reason: receiptGovernance.resend_review_reason,
      consent_checked_at: notification.consent_checked_at,
      sending_started_at: notification.sending_started_at ?? null,
      next_attempt_at: notification.next_attempt_at ?? null,
      created_at: notification.created_at,
      updated_at: notification.updated_at,
      followup_status: followup?.status ?? null,
      followup_subject: followup?.subject ?? null,
      followup_body: followup?.body ?? null
    };
  }));

  return mapped
    .filter((entry) => !query.channel || entry.channel === query.channel)
    .filter((entry) => !query.status || entry.queue_state === query.status || entry.status === query.status)
    .filter((entry) => !query.device_id || entry.interaction_id === query.device_id)
    .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
}

export async function buildNotificationAttemptHistory({
  repos,
  tenantId,
  eventId,
  query = {},
  now = new Date().toISOString()
}) {
  const attempts = await repos.notificationAttempts.listByEvent(tenantId, eventId);
  const recentHours = query.recent_hours != null
    ? parsePositiveInteger(query.recent_hours, 24)
    : null;
  const nowMs = Date.parse(now);
  return attempts
    .filter((entry) => !query.channel || entry.channel === query.channel)
    .filter((entry) => !query.provider || entry.provider === query.provider)
    .filter((entry) => !query.status || entry.status === query.status)
    .filter((entry) => !query.device_id || entry.interaction_id === query.device_id)
    .filter((entry) =>
      recentHours == null || (entry.attempted_at && Date.parse(entry.attempted_at) >= nowMs - recentHours * 60 * 60 * 1000)
    )
    .map((entry) => ({
      id: entry.id,
      notification_id: entry.notification_id,
      event_id: entry.event_id ?? eventId,
      interaction_id: entry.interaction_id ?? null,
      channel: entry.channel ?? null,
      provider: entry.provider,
      status: entry.status,
      attempt_number: Number(entry.attempt_number ?? 1),
      provider_message_id: entry.provider_message_id ?? null,
      http_status: entry.http_status ?? null,
      duration_ms: entry.duration_ms ?? null,
      response_excerpt: entry.response_excerpt ?? null,
      error_message: entry.error_message ?? null,
      attempted_at: entry.attempted_at
    }))
    .sort((left, right) => Date.parse(right.attempted_at) - Date.parse(left.attempted_at));
}

export async function buildNotificationDeliveryAnalytics({
  repos,
  tenantId,
  eventId,
  query = {},
  now = new Date().toISOString()
}) {
  const items = await buildNotificationAttemptHistory({
    repos,
    tenantId,
    eventId,
    query,
    now
  });
  const summary = {
    total_attempts: items.length,
    average_duration_ms: average(items.map((entry) => entry.duration_ms).filter((value) => value != null)),
    sent: 0,
    temporary_failure: 0,
    failed: 0
  };
  const byChannel = {};
  const byProvider = {};
  const byStatus = {};

  for (const item of items) {
    byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
    if (summary[item.status] != null) {
      summary[item.status] += 1;
    }
    if (item.channel) {
      if (!byChannel[item.channel]) {
        byChannel[item.channel] = {
          attempts: 0,
          average_duration_ms: null,
          sent: 0,
          temporary_failure: 0,
          failed: 0
        };
      }
      byChannel[item.channel].attempts += 1;
      if (byChannel[item.channel][item.status] != null) {
        byChannel[item.channel][item.status] += 1;
      }
    }
    if (item.provider) {
      if (!byProvider[item.provider]) {
        byProvider[item.provider] = {
          attempts: 0,
          average_duration_ms: null,
          sent: 0,
          temporary_failure: 0,
          failed: 0
        };
      }
      byProvider[item.provider].attempts += 1;
      if (byProvider[item.provider][item.status] != null) {
        byProvider[item.provider][item.status] += 1;
      }
    }
  }

  for (const [channel, stats] of Object.entries(byChannel)) {
    stats.average_duration_ms = average(
      items
        .filter((entry) => entry.channel === channel && entry.duration_ms != null)
        .map((entry) => entry.duration_ms)
    );
  }
  for (const [provider, stats] of Object.entries(byProvider)) {
    stats.average_duration_ms = average(
      items
        .filter((entry) => entry.provider === provider && entry.duration_ms != null)
        .map((entry) => entry.duration_ms)
    );
  }

  return {
    event_id: eventId,
    generated_at: now,
    filters: {
      channel: query.channel ?? null,
      provider: query.provider ?? null,
      status: query.status ?? null,
      device_id: query.device_id ?? null,
      recent_hours: query.recent_hours != null ? Number(query.recent_hours) : null
    },
    summary,
    by_channel: byChannel,
    by_provider: byProvider,
    by_status: byStatus
  };
}

export async function claimQueuedNotification({
  repos,
  tenantId,
  notificationId,
  provider,
  now = new Date().toISOString()
}) {
  const notification = await repos.notifications.findById(tenantId, notificationId);
  if (SKIP_PROCESSING_STATUSES.has(notification.status)) {
    throw new HttpError(409, "Notification is already in a final state");
  }
  if (notification.status !== "queued") {
    throw new HttpError(409, "Only queued notifications can be claimed for sending");
  }
  return repos.notifications.update({
    ...notification,
    status: "sending",
    provider,
    sending_started_at: now,
    updated_at: now
  });
}

export async function completeNotificationSendSuccess({
  repos,
  tenantId,
  notificationId,
  provider,
  providerMessageId = null,
  httpStatus = null,
  durationMs = null,
  responseExcerpt = null,
  attemptedByUserId = null,
  now = new Date().toISOString()
}) {
  const notification = await repos.notifications.findById(tenantId, notificationId);
  const attemptNumber = Number(notification.attempts_count ?? 0) + 1;
  const attempt = await repos.notificationAttempts.create({
    id: nextId("notification-attempt"),
    tenant_id: notification.tenant_id,
    notification_id: notification.id,
    provider,
    status: "sent",
    attempt_number: attemptNumber,
    provider_message_id: providerMessageId,
    http_status: httpStatus,
    duration_ms: durationMs,
    response_excerpt: responseExcerpt,
    error_message: null,
    attempted_at: now
  });
  const updatedNotification = await repos.notifications.update({
    ...notification,
    status: "sent",
    provider,
    last_attempt_at: now,
    next_attempt_at: null,
    attempts_count: attemptNumber,
    provider_message_id: providerMessageId,
    final_error: null,
    retry_exhausted_at: null,
    retry_exhausted_reason: null,
    sending_started_at: null,
    updated_at: now
  });
  const followup = await repos.followupMessages.findByNotificationId(tenantId, notification.id);
  const updatedFollowup = followup
    ? await repos.followupMessages.update({
        ...followup,
        status: "sent",
        updated_at: now
      })
    : null;
  await recordNotificationAudit({
    repos,
    tenantId,
    actorId: attemptedByUserId,
    notificationId,
    eventType: "notification.worker.sent",
    metadata: {
      provider,
      provider_message_id: providerMessageId
    },
    now
  });
  return {
    attempt,
    notification: updatedNotification,
    followup: updatedFollowup
  };
}

export async function completeNotificationSendTemporaryFailure({
  repos,
  tenantId,
  notificationId,
  provider,
  errorMessage,
  retryAt,
  env = {},
  providerMessageId = null,
  httpStatus = null,
  durationMs = null,
  responseExcerpt = null,
  attemptedByUserId = null,
  now = new Date().toISOString()
}) {
  const notification = await repos.notifications.findById(tenantId, notificationId);
  const attemptNumber = Number(notification.attempts_count ?? 0) + 1;
  const retryPolicy = resolveNotificationRetryPolicy(env);
  const attempt = await repos.notificationAttempts.create({
    id: nextId("notification-attempt"),
    tenant_id: notification.tenant_id,
    notification_id: notification.id,
    provider,
    status: "temporary_failure",
    attempt_number: attemptNumber,
    provider_message_id: providerMessageId,
    http_status: httpStatus,
    duration_ms: durationMs,
    response_excerpt: responseExcerpt,
    error_message: errorMessage,
    attempted_at: now
  });
  const exhausted = attemptNumber >= retryPolicy.max_attempts;
  const updatedNotification = await repos.notifications.update({
    ...notification,
    status: exhausted ? "failed" : "queued",
    provider,
    last_attempt_at: now,
    next_attempt_at: exhausted ? null : retryAt,
    attempts_count: attemptNumber,
    provider_message_id: providerMessageId,
    final_error: errorMessage,
    retry_exhausted_at: exhausted ? now : null,
    retry_exhausted_reason: exhausted ? errorMessage : null,
    sending_started_at: null,
    updated_at: now
  });
  const followup = await repos.followupMessages.findByNotificationId(tenantId, notification.id);
  const updatedFollowup = followup
    ? await repos.followupMessages.update({
        ...followup,
        status: exhausted ? "failed" : "queued",
        updated_at: now
      })
    : null;
  await recordNotificationAudit({
    repos,
    tenantId,
    actorId: attemptedByUserId,
    notificationId,
    eventType: exhausted ? "notification.worker.retry_exhausted" : "notification.worker.temporary_failure",
    metadata: {
      provider,
      retry_at: exhausted ? null : retryAt,
      error_message: errorMessage,
      max_attempts: retryPolicy.max_attempts,
      retry_exhausted_at: exhausted ? now : null
    },
    now
  });
  return {
    attempt,
    notification: updatedNotification,
    followup: updatedFollowup
  };
}

export async function completeNotificationSendFailure({
  repos,
  tenantId,
  notificationId,
  provider,
  errorMessage,
  attemptedByUserId = null,
  providerMessageId = null,
  httpStatus = null,
  durationMs = null,
  responseExcerpt = null,
  now = new Date().toISOString()
}) {
  const notification = await repos.notifications.findById(tenantId, notificationId);
  const attemptNumber = Number(notification.attempts_count ?? 0) + 1;
  const attempt = await repos.notificationAttempts.create({
    id: nextId("notification-attempt"),
    tenant_id: notification.tenant_id,
    notification_id: notification.id,
    provider,
    status: "failed",
    attempt_number: attemptNumber,
    provider_message_id: providerMessageId,
    http_status: httpStatus,
    duration_ms: durationMs,
    response_excerpt: responseExcerpt,
    error_message: errorMessage,
    attempted_at: now
  });
  const updatedNotification = await repos.notifications.update({
    ...notification,
    status: "failed",
    provider,
    last_attempt_at: now,
    next_attempt_at: null,
    attempts_count: attemptNumber,
    provider_message_id: providerMessageId,
    final_error: errorMessage,
    retry_exhausted_at: null,
    retry_exhausted_reason: null,
    sending_started_at: null,
    updated_at: now
  });
  const followup = await repos.followupMessages.findByNotificationId(tenantId, notification.id);
  const updatedFollowup = followup
    ? await repos.followupMessages.update({
        ...followup,
        status: "failed",
        updated_at: now
      })
    : null;
  await recordNotificationAudit({
    repos,
    tenantId,
    actorId: attemptedByUserId,
    notificationId,
    eventType: "notification.worker.failed",
    metadata: {
      provider,
      provider_message_id: providerMessageId,
      error_message: errorMessage
    },
    now
  });
  return {
    attempt,
    notification: updatedNotification,
    followup: updatedFollowup
  };
}

export async function processNotificationQueueBatch({
  repos,
  tenantId,
  eventId = null,
  env = {},
  limit = 20,
  initiatedBy = "notification-worker",
  now = new Date().toISOString()
}) {
  const retryPolicy = resolveNotificationRetryPolicy(env);
  const retryDelayMinutes = retryPolicy.retry_delay_minutes;
  const queued = await repos.notifications.listQueued(tenantId, {
    eventId,
    limit,
    now
  });
  const items = [];

  for (const entry of queued) {
    const current = await repos.notifications.findById(tenantId, entry.id);
    if (FINAL_NOTIFICATION_STATUSES.has(current.status)) {
      items.push({
        notification_id: current.id,
        event_id: current.event_id,
        interaction_id: current.interaction_id,
        channel: current.channel,
        status: current.status,
        queue_state: deriveNotificationQueueState(current, now),
        outcome: "skipped_final"
      });
      continue;
    }

    const deliveryContext = await resolveNotificationDeliveryContext(repos, tenantId, current, env);
    if (deliveryContext.cancelled_reason) {
      const cancelled = await repos.withTransaction(async (txRepos) =>
        cancelNotificationForInvalidDelivery({
          repos: txRepos,
          tenantId,
          notificationId: current.id,
          reason: deliveryContext.cancelled_reason,
          attemptedByUserId: initiatedBy,
          now
        })
      );
      items.push({
        notification_id: cancelled.notification.id,
        event_id: cancelled.notification.event_id,
        interaction_id: cancelled.notification.interaction_id,
        channel: cancelled.notification.channel,
        status: cancelled.notification.status,
        queue_state: deriveNotificationQueueState(cancelled.notification, now),
        outcome: "cancelled",
        error_message: deliveryContext.cancelled_reason
      });
      continue;
    }
    if (deliveryContext.permanent_failure_reason) {
      const failed = await repos.withTransaction(async (txRepos) => {
        const claimed = await claimQueuedNotification({
          repos: txRepos,
          tenantId,
          notificationId: current.id,
          provider: deliveryContext.provider.provider,
          now
        });
        return completeNotificationSendFailure({
          repos: txRepos,
          tenantId,
          notificationId: claimed.id,
          provider: deliveryContext.provider.provider,
          errorMessage: deliveryContext.permanent_failure_reason,
          attemptedByUserId: initiatedBy,
          now
        });
      });
      items.push({
        notification_id: failed.notification.id,
        event_id: failed.notification.event_id,
        interaction_id: failed.notification.interaction_id,
        channel: failed.notification.channel,
        status: failed.notification.status,
        queue_state: deriveNotificationQueueState(failed.notification, now),
        outcome: "failed",
        error_message: deliveryContext.permanent_failure_reason
      });
      continue;
    }
    const processed = await repos.withTransaction(async (txRepos) => {
      const claimed = await claimQueuedNotification({
        repos: txRepos,
        tenantId,
        notificationId: current.id,
        provider: deliveryContext.provider.provider,
        now
      });
      const outcome = await sendNotificationWithProvider({
        notification: claimed,
        followup: deliveryContext.followup,
        recipient: deliveryContext.recipient,
        env
      });
      if (outcome.status === "sent") {
        return completeNotificationSendSuccess({
          repos: txRepos,
          tenantId,
          notificationId: claimed.id,
          provider: outcome.provider ?? deliveryContext.provider.provider,
          providerMessageId: outcome.provider_message_id,
          httpStatus: outcome.http_status ?? null,
          durationMs: outcome.duration_ms ?? null,
          responseExcerpt: outcome.response_excerpt ?? null,
          attemptedByUserId: initiatedBy,
          now
        });
      }
      if (outcome.status === "temporary_failure") {
        return completeNotificationSendTemporaryFailure({
          repos: txRepos,
          tenantId,
          notificationId: claimed.id,
          provider: outcome.provider ?? deliveryContext.provider.provider,
          errorMessage: outcome.error_message,
          retryAt: new Date(Date.parse(now) + retryDelayMinutes * 60 * 1000).toISOString(),
          env,
          providerMessageId: outcome.provider_message_id ?? null,
          httpStatus: outcome.http_status ?? null,
          durationMs: outcome.duration_ms ?? null,
          responseExcerpt: outcome.response_excerpt ?? null,
          attemptedByUserId: initiatedBy,
          now
        });
      }
      return completeNotificationSendFailure({
        repos: txRepos,
        tenantId,
        notificationId: claimed.id,
        provider: outcome.provider ?? deliveryContext.provider.provider,
        errorMessage: outcome.error_message,
        providerMessageId: outcome.provider_message_id ?? null,
        httpStatus: outcome.http_status ?? null,
        durationMs: outcome.duration_ms ?? null,
        responseExcerpt: outcome.response_excerpt ?? null,
        attemptedByUserId: initiatedBy,
        now
      });
    });

    items.push({
      notification_id: processed.notification.id,
      event_id: processed.notification.event_id,
      interaction_id: processed.notification.interaction_id,
      channel: processed.notification.channel,
      status: processed.notification.status,
      queue_state: deriveNotificationQueueState(processed.notification, now),
      outcome: processed.attempt.status,
      attempt_id: processed.attempt.id,
      provider: processed.attempt.provider,
      provider_message_id: processed.attempt.provider_message_id,
      http_status: processed.attempt.http_status ?? null,
      duration_ms: processed.attempt.duration_ms ?? null,
      response_excerpt: processed.attempt.response_excerpt ?? null,
      error_message: processed.attempt.error_message,
      retry_exhausted_at: processed.notification.retry_exhausted_at ?? null,
      next_attempt_at: processed.notification.next_attempt_at ?? null
    });
  }

  return {
    generated_at: now,
    processed_count: items.filter((entry) => entry.outcome !== "skipped_final").length,
    skipped_count: items.filter((entry) => entry.outcome === "skipped_final").length,
    sent_count: items.filter((entry) => entry.outcome === "sent").length,
    temporary_failure_count: items.filter((entry) => entry.outcome === "temporary_failure").length,
    failed_count: items.filter((entry) => entry.outcome === "failed").length,
    dead_letter_count: items.filter((entry) => entry.queue_state === "dead_letter").length,
    cancelled_count: items.filter((entry) => entry.outcome === "cancelled").length,
    items
  };
}

async function recordNotificationAudit({
  repos,
  tenantId,
  actorId,
  notificationId,
  eventType,
  metadata,
  now
}) {
  if (typeof repos.auditLogs?.create !== "function") {
    return;
  }
  await repos.auditLogs.create({
    id: nextId("audit"),
    tenant_id: tenantId,
    actor_type: actorId ? "user" : "system",
    actor_id: actorId ?? "notification-worker",
    event_type: eventType,
    target_type: "notification",
    target_id: notificationId,
    break_glass_access_id: null,
    metadata,
    created_at: now
  });
}

async function resolveNotificationDeliveryContext(repos, tenantId, notification, env = {}) {
  const provider = resolveNotificationProvider(notification.channel, env);
  if (!notification.interaction_id) {
    return {
      provider,
      recipient: null,
      followup: null,
      cancelled_reason: "Notification is missing an interaction scope and cannot be delivered safely."
    };
  }
  const interaction = await repos.interactions.findById(tenantId, notification.interaction_id);
  const followup = await repos.followupMessages.findByNotificationId(tenantId, notification.id);
  const attendeeProfile = interaction.attendee_id
    ? await repos.attendeeProfiles.findByAttendeeId(interaction.attendee_id)
    : null;
  const recipient = resolveFollowupRecipient(attendeeProfile, notification.channel);
  const channelConsent = await repos.communicationChannelConsents.findByInteractionAndChannel(
    tenantId,
    interaction.id,
    notification.channel
  );
  const suppression = await repos.communicationSuppressions.findActiveByInteractionAndChannel(
    tenantId,
    interaction.id,
    notification.channel
  );
  if (!["vendor_only", "vendor_and_sponsor"].includes(interaction.consent_status)) {
    return {
      provider,
      recipient,
      followup,
      cancelled_reason: "Vendor consent is no longer valid for follow-up messaging."
    };
  }
  if (!channelConsent?.allowed) {
    return {
      provider,
      recipient,
      followup,
      cancelled_reason: "Communication channel consent is no longer valid for follow-up messaging."
    };
  }
  if (suppression) {
    return {
      provider,
      recipient,
      followup,
      cancelled_reason: "Communication is actively suppressed for this attendee and channel."
    };
  }
  if (!followup) {
    return {
      provider,
      recipient,
      followup: null,
      cancelled_reason: "Follow-up content is missing for this queued notification."
    };
  }
  if (!recipient) {
    return {
      provider,
      recipient: null,
      followup,
      cancelled_reason: null,
      permanent_failure_reason: "Notification recipient is missing for the selected channel."
    };
  }
  return {
    provider,
    interaction,
    followup,
    recipient,
    cancelled_reason: null,
    permanent_failure_reason: null
  };
}

async function cancelNotificationForInvalidDelivery({
  repos,
  tenantId,
  notificationId,
  reason,
  attemptedByUserId = null,
  now = new Date().toISOString()
}) {
  const notification = await repos.notifications.findById(tenantId, notificationId);
  const updatedNotification = await repos.notifications.update({
    ...notification,
    status: "cancelled",
    next_attempt_at: null,
    final_error: reason,
    updated_at: now
  });
  const followup = await repos.followupMessages.findByNotificationId(tenantId, notification.id);
  const updatedFollowup = followup
    ? await repos.followupMessages.update({
        ...followup,
        status: "cancelled",
        updated_at: now
      })
    : null;
  await recordNotificationAudit({
    repos,
    tenantId,
    actorId: attemptedByUserId,
    notificationId,
    eventType: "notification.worker.cancelled",
    metadata: {
      reason
    },
    now
  });
  return {
    notification: updatedNotification,
    followup: updatedFollowup
  };
}

function resolveFollowupRecipient(attendeeProfile, channel) {
  if (channel === "email") {
    return attendeeProfile?.email ?? null;
  }
  if (channel === "sms" || channel === "whatsapp") {
    return attendeeProfile?.phone ?? null;
  }
  return null;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function average(values) {
  if (!values.length) {
    return null;
  }
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}
