import { Buffer } from "node:buffer";

export const NOTIFICATION_CHANNELS = ["email", "sms", "whatsapp"];

const DEFAULT_PROVIDER_TIMEOUT_MS = 8_000;
const DEFAULT_WORKER_INTERVAL_SECONDS = 60;
const DEFAULT_WORKER_BATCH_LIMIT = 20;

export function resolveNotificationProviderConfig(channel, env = {}) {
  const normalizedChannel = String(channel).toLowerCase();
  const prefix = `NOTIFICATION_${normalizedChannel.toUpperCase()}`;
  const enabled = env[`${prefix}_ENABLED`] === "true";
  const mode = env[`${prefix}_PROVIDER_MODE`] ?? "not_configured";
  const kind = env[`${prefix}_PROVIDER_KIND`] ?? (mode === "production" ? "http_json" : "mock");
  const provider = env[`${prefix}_PROVIDER_NAME`] ??
    (mode.startsWith("mock_") ? `mock-${normalizedChannel}` : `${normalizedChannel}-provider`);
  const timeoutMs = parsePositiveInteger(env[`${prefix}_PROVIDER_TIMEOUT_MS`], DEFAULT_PROVIDER_TIMEOUT_MS);
  const authType = env[`${prefix}_PROVIDER_AUTH_TYPE`] ?? "none";
  const sender = env[`${prefix}_SENDER`] ?? env[`${prefix}_FROM`] ?? null;
  const url = env[`${prefix}_PROVIDER_URL`] ?? null;
  const authHeaderName = env[`${prefix}_PROVIDER_AUTH_HEADER_NAME`] ?? null;
  const authHeaderValue = env[`${prefix}_PROVIDER_AUTH_HEADER_VALUE`] ?? null;
  const authToken = env[`${prefix}_PROVIDER_AUTH_TOKEN`] ?? null;
  const authUsername = env[`${prefix}_PROVIDER_AUTH_USERNAME`] ?? null;
  const authPassword = env[`${prefix}_PROVIDER_AUTH_PASSWORD`] ?? null;
  const webhookAuthMode = env[`${prefix}_WEBHOOK_AUTH_MODE`] ?? (
    env[`${prefix}_WEBHOOK_SECRET`] ? "shared_secret" : "not_configured"
  );
  const webhookSecret = env[`${prefix}_WEBHOOK_SECRET`] ?? null;
  const webhookSignatureHeader = env[`${prefix}_WEBHOOK_SIGNATURE_HEADER`] ?? "x-notification-signature";
  const webhookTimestampHeader = env[`${prefix}_WEBHOOK_TIMESTAMP_HEADER`] ?? "x-notification-timestamp";
  const webhookTimestampToleranceSeconds = parsePositiveInteger(
    env[`${prefix}_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`],
    300
  );

  const productionChecks = [];
  if (!enabled) {
    productionChecks.push({ ok: true, reason: "Channel is disabled." });
  } else if (mode !== "production") {
    productionChecks.push({
      ok: mode === "mock_success" || mode === "mock_failure" || mode === "mock_temporary_failure",
      reason: mode === "not_configured"
        ? "Provider mode is not configured."
        : `Provider mode is ${mode}.`
    });
  } else {
    productionChecks.push({
      ok: kind === "http_json",
      reason: kind === "http_json"
        ? "Provider kind is http_json."
        : `Provider kind ${kind} is not supported.`
    });
    productionChecks.push({
      ok: Boolean(url),
      reason: url ? "Provider URL is configured." : "Provider URL is missing."
    });
    productionChecks.push({
      ok: timeoutMs > 0 && timeoutMs <= 30_000,
      reason: timeoutMs > 0 && timeoutMs <= 30_000
        ? `Provider timeout is ${timeoutMs}ms.`
        : `Provider timeout ${timeoutMs}ms is outside the supported range.`
    });
    productionChecks.push({
      ok: validateAuthConfiguration(authType, {
        headerName: authHeaderName,
        headerValue: authHeaderValue,
        token: authToken,
        username: authUsername,
        password: authPassword
      }),
      reason: buildAuthConfigurationReason(authType, {
        headerName: authHeaderName,
        headerValue: authHeaderValue,
        token: authToken,
        username: authUsername,
        password: authPassword
      })
    });
  }

  const webhookChecks = [];
  if (!enabled) {
    webhookChecks.push({ ok: true, reason: "Channel is disabled, so webhook auth is not required." });
  } else if (mode !== "production") {
    webhookChecks.push({ ok: true, reason: `Webhook auth is not required while provider mode is ${mode}.` });
  } else if (webhookAuthMode === "shared_secret") {
    webhookChecks.push({
      ok: Boolean(webhookSecret),
      reason: webhookSecret ? "Shared-secret webhook auth is configured." : "Webhook shared secret is missing."
    });
  } else if (webhookAuthMode === "hmac_sha256") {
    webhookChecks.push({
      ok: Boolean(webhookSecret),
      reason: webhookSecret ? "HMAC webhook secret is configured." : "HMAC webhook secret is missing."
    });
    webhookChecks.push({
      ok: Boolean(webhookSignatureHeader),
      reason: webhookSignatureHeader ? `Webhook signature header is ${webhookSignatureHeader}.` : "Webhook signature header is missing."
    });
    webhookChecks.push({
      ok: Boolean(webhookTimestampHeader),
      reason: webhookTimestampHeader ? `Webhook timestamp header is ${webhookTimestampHeader}.` : "Webhook timestamp header is missing."
    });
    webhookChecks.push({
      ok: webhookTimestampToleranceSeconds > 0 && webhookTimestampToleranceSeconds <= 3600,
      reason: webhookTimestampToleranceSeconds > 0 && webhookTimestampToleranceSeconds <= 3600
        ? `Webhook timestamp tolerance is ${webhookTimestampToleranceSeconds}s.`
        : `Webhook timestamp tolerance ${webhookTimestampToleranceSeconds}s is outside the supported range.`
    });
  } else if (webhookAuthMode === "none") {
    webhookChecks.push({
      ok: false,
      reason: "Webhook auth mode none is not production-safe."
    });
  } else {
    webhookChecks.push({
      ok: false,
      reason: "Webhook auth mode is not configured."
    });
  }

  const productionReady = productionChecks.every((entry) => entry.ok);
  const webhookReady = webhookChecks.every((entry) => entry.ok);
  return {
    channel: normalizedChannel,
    enabled,
    mode,
    kind,
    provider,
    timeout_ms: timeoutMs,
    auth_type: authType,
    url,
    sender,
    auth_header_name: authHeaderName,
    auth_header_value: authHeaderValue,
    auth_token: authToken,
    auth_username: authUsername,
    auth_password: authPassword,
    webhook_auth_mode: webhookAuthMode,
    webhook_secret: webhookSecret,
    webhook_signature_header: webhookSignatureHeader,
    webhook_timestamp_header: webhookTimestampHeader,
    webhook_timestamp_tolerance_seconds: webhookTimestampToleranceSeconds,
    webhook_ready: webhookReady,
    webhook_checks: webhookChecks,
    production_ready: productionReady,
    production_checks: productionChecks,
    status: !enabled
      ? "disabled"
      : productionReady && (mode === "production" || mode.startsWith("mock_"))
        ? "ready"
        : "misconfigured",
    non_blocking: true
  };
}

export function buildNotificationChannelsReadiness(env = {}) {
  return NOTIFICATION_CHANNELS.map((channel) => resolveNotificationProviderConfig(channel, env)).map((config) => ({
    channel: config.channel,
    enabled: config.enabled,
    mode: config.mode,
    kind: config.kind,
    provider: config.provider,
    url: config.url,
    timeout_ms: config.timeout_ms,
    auth_type: config.auth_type,
    sender: config.sender,
    webhook_auth_mode: config.webhook_auth_mode,
    webhook_ready: config.webhook_ready,
    webhook_signature_header: config.webhook_signature_header,
    webhook_timestamp_header: config.webhook_timestamp_header,
    webhook_timestamp_tolerance_seconds: config.webhook_timestamp_tolerance_seconds,
    production_ready: config.production_ready,
    status: config.status,
    non_blocking: true,
    checks: config.production_checks,
    webhook_checks: config.webhook_checks
  }));
}

export function resolveNotificationWorkerSchedule(env = {}) {
  const enabled = env.NOTIFICATION_WORKER_ENABLED === "true";
  const intervalSeconds = parsePositiveInteger(
    env.NOTIFICATION_WORKER_INTERVAL_SECONDS,
    DEFAULT_WORKER_INTERVAL_SECONDS
  );
  const batchLimit = parsePositiveInteger(
    env.NOTIFICATION_WORKER_BATCH_LIMIT,
    DEFAULT_WORKER_BATCH_LIMIT
  );
  const tenantId = env.NOTIFICATION_WORKER_TENANT_ID ?? null;
  const eventId = env.NOTIFICATION_WORKER_EVENT_ID ?? null;
  const configured = enabled &&
    Boolean(tenantId) &&
    intervalSeconds > 0 &&
    intervalSeconds <= 3600 &&
    batchLimit > 0 &&
    batchLimit <= 200;

  return {
    enabled,
    interval_seconds: intervalSeconds,
    batch_limit: batchLimit,
    tenant_id: tenantId,
    event_id: eventId,
    configured,
    status: !enabled ? "disabled" : configured ? "ready" : "misconfigured",
    checks: [
      {
        ok: !enabled || Boolean(tenantId),
        reason: tenantId
          ? "Worker tenant scope is configured."
          : "Worker tenant scope is missing."
      },
      {
        ok: intervalSeconds > 0 && intervalSeconds <= 3600,
        reason: intervalSeconds > 0 && intervalSeconds <= 3600
          ? `Worker interval is ${intervalSeconds}s.`
          : `Worker interval ${intervalSeconds}s is outside the supported range.`
      },
      {
        ok: batchLimit > 0 && batchLimit <= 200,
        reason: batchLimit > 0 && batchLimit <= 200
          ? `Worker batch limit is ${batchLimit}.`
          : `Worker batch limit ${batchLimit} is outside the supported range.`
      }
    ]
  };
}

export async function sendNotificationWithProvider({
  notification,
  followup,
  recipient,
  env = {},
  fetchImpl = global.fetch
}) {
  const providerConfig = resolveNotificationProviderConfig(notification.channel, env);
  if (!providerConfig.enabled || providerConfig.mode === "not_configured") {
    return {
      provider: providerConfig.provider,
      status: "failed",
      error_message: "Notification provider is enabled for queueing but not configured for delivery.",
      http_status: null,
      duration_ms: null,
      response_excerpt: null
    };
  }
  if (providerConfig.mode === "mock_failure") {
    return {
      provider: providerConfig.provider,
      status: "failed",
      error_message: "Mock notification provider returned a permanent failure.",
      http_status: null,
      duration_ms: null,
      response_excerpt: null
    };
  }
  if (providerConfig.mode === "mock_temporary_failure") {
    return {
      provider: providerConfig.provider,
      status: "temporary_failure",
      error_message: "Mock notification provider returned a retryable failure.",
      http_status: null,
      duration_ms: null,
      response_excerpt: null
    };
  }
  if (providerConfig.mode === "mock_success") {
    return {
      provider: providerConfig.provider,
      status: "sent",
      provider_message_id: `${providerConfig.provider}-${notification.id}-${Number(notification.attempts_count ?? 0) + 1}`,
      http_status: null,
      duration_ms: null,
      response_excerpt: null
    };
  }
  if (!providerConfig.production_ready) {
    return {
      provider: providerConfig.provider,
      status: "failed",
      error_message: providerConfig.production_checks
        .filter((entry) => !entry.ok)
        .map((entry) => entry.reason)
        .join(" ")
    };
  }
  return sendHttpJsonNotification({
    providerConfig,
    notification,
    followup,
    recipient,
    fetchImpl
  });
}

async function sendHttpJsonNotification({
  providerConfig,
  notification,
  followup,
  recipient,
  fetchImpl
}) {
  if (typeof fetchImpl !== "function") {
    return {
      provider: providerConfig.provider,
      status: "failed",
      error_message: "Global fetch is not available for the notification provider."
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), providerConfig.timeout_ms);
  const startedAtMs = Date.now();
  try {
    const response = await fetchImpl(providerConfig.url, {
      method: "POST",
      headers: buildProviderRequestHeaders(providerConfig),
      body: JSON.stringify({
        message_id: notification.id,
        channel: notification.channel,
        to: recipient,
        sender: providerConfig.sender,
        subject: followup?.subject ?? null,
        body: followup?.body ?? "",
        metadata: {
          tenant_id: notification.tenant_id,
          event_id: notification.event_id,
          interaction_id: notification.interaction_id ?? null,
          followup_id: followup?.id ?? null,
          message_type: notification.message_type
        }
      }),
      signal: controller.signal
    });

    const rawBody = await response.text();
    const parsedBody = safeParseJson(rawBody);
    const errorMessage = formatProviderError(response.status, rawBody);
    const durationMs = Date.now() - startedAtMs;
    const responseExcerpt = formatResponseExcerpt(rawBody);
    if (response.ok) {
      return {
        provider: providerConfig.provider,
        status: "sent",
        provider_message_id:
          parsedBody?.provider_message_id ??
          parsedBody?.message_id ??
          parsedBody?.id ??
          response.headers.get("x-message-id") ??
          null,
        http_status: response.status,
        duration_ms: durationMs,
        response_excerpt: responseExcerpt
      };
    }
    if (response.status === 429 || response.status >= 500) {
      return {
        provider: providerConfig.provider,
        status: "temporary_failure",
        error_message: errorMessage,
        http_status: response.status,
        duration_ms: durationMs,
        response_excerpt: responseExcerpt
      };
    }
    return {
      provider: providerConfig.provider,
      status: "failed",
      error_message: errorMessage,
      http_status: response.status,
      duration_ms: durationMs,
      response_excerpt: responseExcerpt
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      return {
        provider: providerConfig.provider,
        status: "temporary_failure",
        error_message: `Provider request timed out after ${providerConfig.timeout_ms}ms.`,
        http_status: null,
        duration_ms: Date.now() - startedAtMs,
        response_excerpt: null
      };
    }
    return {
      provider: providerConfig.provider,
      status: "temporary_failure",
      error_message: error?.message || "Provider request failed.",
      http_status: null,
      duration_ms: Date.now() - startedAtMs,
      response_excerpt: null
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildProviderRequestHeaders(config) {
  const headers = {
    "content-type": "application/json"
  };
  if (config.auth_type === "bearer") {
    headers.authorization = `Bearer ${config.auth_token}`;
  } else if (config.auth_type === "basic") {
    headers.authorization = `Basic ${Buffer.from(`${config.auth_username}:${config.auth_password}`).toString("base64")}`;
  } else if (config.auth_type === "header") {
    headers[config.auth_header_name] = config.auth_header_value;
  }
  return headers;
}

function validateAuthConfiguration(authType, { headerName, headerValue, token, username, password }) {
  if (authType === "none") {
    return true;
  }
  if (authType === "bearer") {
    return Boolean(token);
  }
  if (authType === "basic") {
    return Boolean(username) && Boolean(password);
  }
  if (authType === "header") {
    return Boolean(headerName) && Boolean(headerValue);
  }
  return false;
}

function buildAuthConfigurationReason(authType, { headerName, headerValue, token, username, password }) {
  if (authType === "none") {
    return "Provider auth type is none.";
  }
  if (authType === "bearer") {
    return token ? "Bearer token is configured." : "Bearer token is missing.";
  }
  if (authType === "basic") {
    return username && password
      ? "Basic auth credentials are configured."
      : "Basic auth username or password is missing.";
  }
  if (authType === "header") {
    return headerName && headerValue
      ? "Custom auth header is configured."
      : "Custom auth header name or value is missing.";
  }
  return `Unsupported auth type ${authType}.`;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function safeParseJson(value) {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function formatProviderError(status, rawBody) {
  const trimmed = String(rawBody ?? "").trim();
  if (!trimmed) {
    return `Provider responded with HTTP ${status}.`;
  }
  const excerpt = trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : trimmed;
  return `Provider responded with HTTP ${status}: ${excerpt}`;
}

function formatResponseExcerpt(rawBody) {
  const trimmed = String(rawBody ?? "").trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.length > 200 ? `${trimmed.slice(0, 197)}...` : trimmed;
}
