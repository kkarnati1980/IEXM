import {
  buildNotificationChannelsReadiness,
  resolveNotificationWorkerSchedule
} from "./notification-providers.mjs";
import { resolveNotificationRetryPolicy } from "./notification-worker.mjs";

const PLACEHOLDER_PATTERNS = [
  /replace-with/i,
  /your-/i,
  /example\.com/i,
  /^changeme$/i,
  /^todo$/i
];

export async function buildDeploymentReadiness(ctx, { includeDetails = true } = {}) {
  const env = ctx.env ?? process.env;
  const database = await checkDatabase(ctx);
  const controls = [
    ...validateProductionEnvironment(env, {
      backend: ctx.backend,
      securityMode: ctx.securityMode,
      allowSeedTokens: ctx.allowSeedTokens,
      securityHeadersEnabled: ctx.securityHeadersEnabled,
      databaseSsl: ctx.databaseSsl,
      databaseSslRejectUnauthorized: ctx.databaseSslRejectUnauthorized,
      oidcEnabled: Boolean(ctx.oidc?.enabled)
    }),
    {
      id: "database_connectivity",
      category: "Runtime",
      label: "Database connectivity",
      status: database.ok ? "pass" : "fail",
      evidence: database.ok ? "Database healthcheck succeeded." : database.error,
      recommendation: "Confirm DATABASE_URL, network access, credentials, migrations, and database TLS settings."
    }
  ];

  const summary = summarizeControls(controls);
  const ready = summary.fail === 0;
  const payload = {
    generated_at: new Date().toISOString(),
    ready,
    environment: env.DEPLOYMENT_ENV || env.NODE_ENV || "development",
    backend: ctx.backend,
    security_mode: ctx.securityMode,
    summary
  };

  if (includeDetails) {
    payload.controls = controls;
  }

  return payload;
}

export function validateProductionEnvironment(env = process.env, runtime = {}) {
  const deploymentEnv = env.DEPLOYMENT_ENV || env.NODE_ENV || "development";
  const productionLike = ["production", "staging"].includes(deploymentEnv);
  const secureLike = runtime.securityMode === "secure" || env.APP_SECURITY_MODE === "secure" || productionLike;
  const controls = [];

  controls.push(requiredValue({
    id: "node_env",
    category: "Runtime",
    label: "Runtime environment is explicitly set",
    value: env.NODE_ENV,
    required: productionLike,
    expected: "production",
    recommendation: "Set NODE_ENV=production for production containers."
  }));
  controls.push(booleanControl({
    id: "secure_mode",
    category: "Security",
    label: "Secure application mode is enabled",
    actual: runtime.securityMode ?? env.APP_SECURITY_MODE,
    expected: "secure",
    required: productionLike,
    recommendation: "Set APP_SECURITY_MODE=secure outside local development."
  }));
  controls.push(booleanControl({
    id: "postgres_backend",
    category: "Runtime",
    label: "Postgres backend is selected",
    actual: runtime.backend ?? env.REPOSITORY_BACKEND,
    expected: "postgres",
    required: productionLike,
    recommendation: "Set REPOSITORY_BACKEND=postgres for staging and production."
  }));
  controls.push(requiredValue({
    id: "database_url",
    category: "Database",
    label: "Database URL is configured",
    value: env.DATABASE_URL,
    required: productionLike,
    recommendation: "Set DATABASE_URL from the managed database secret store."
  }));
  controls.push(flagControl({
    id: "database_ssl",
    category: "Database",
    label: "Database SSL is enabled",
    actual: runtime.databaseSsl ?? parseBoolean(env.DATABASE_SSL),
    expected: true,
    required: productionLike,
    recommendation: "Set DATABASE_SSL=true for managed production Postgres."
  }));
  controls.push(flagControl({
    id: "database_tls_verify",
    category: "Database",
    label: "Database TLS certificate verification is enabled",
    actual: runtime.databaseSslRejectUnauthorized ?? parseBoolean(env.DATABASE_SSL_REJECT_UNAUTHORIZED),
    expected: true,
    required: productionLike,
    recommendation: "Keep DATABASE_SSL_REJECT_UNAUTHORIZED=true unless using a trusted local test database."
  }));
  controls.push(secretControl({
    id: "session_secret",
    category: "Secrets",
    label: "Session secret is production grade",
    value: env.SESSION_SECRET,
    required: secureLike,
    minLength: 32,
    recommendation: "Store SESSION_SECRET in the deployment secret manager and rotate it on a schedule."
  }));
  controls.push(flagControl({
    id: "seed_tokens_disabled",
    category: "Authentication",
    label: "Seed bearer tokens are disabled",
    actual: runtime.allowSeedTokens ?? parseBoolean(env.AUTH_ALLOW_SEED_TOKENS),
    expected: false,
    required: secureLike,
    recommendation: "Set AUTH_ALLOW_SEED_TOKENS=false outside local development."
  }));
  controls.push(flagControl({
    id: "oidc_enabled",
    category: "Authentication",
    label: "OIDC/SSO is enabled",
    actual: runtime.oidcEnabled ?? parseBoolean(env.OIDC_ENABLED),
    expected: true,
    required: secureLike,
    recommendation: "Set OIDC_ENABLED=true with issuer, audience, and browser client settings."
  }));
  for (const [id, label, key] of [
    ["oidc_issuer", "OIDC issuer is configured", "OIDC_ISSUER"],
    ["oidc_audience", "OIDC audience is configured", "OIDC_AUDIENCE"],
    ["oidc_client_id", "OIDC browser client ID is configured", "OIDC_CLIENT_ID"]
  ]) {
    controls.push(requiredValue({
      id,
      category: "Authentication",
      label,
      value: env[key],
      required: secureLike,
      recommendation: `Set ${key} from your identity provider application.`
    }));
  }
  controls.push(flagControl({
    id: "oidc_email_fallback_disabled",
    category: "Authentication",
    label: "OIDC email fallback is disabled",
    actual: parseBoolean(env.OIDC_ALLOW_EMAIL_FALLBACK) ?? false,
    expected: false,
    required: secureLike,
    recommendation: "Keep OIDC_ALLOW_EMAIL_FALLBACK=false after migration."
  }));
  controls.push(flagControl({
    id: "security_headers",
    category: "HTTP",
    label: "Security headers are enabled",
    actual: runtime.securityHeadersEnabled ?? parseBoolean(env.SECURITY_HEADERS_ENABLED),
    expected: true,
    required: secureLike,
    recommendation: "Set SECURITY_HEADERS_ENABLED=true."
  }));
  controls.push(flagControl({
    id: "rate_limiting",
    category: "HTTP",
    label: "Rate limiting is enabled",
    actual: parseBoolean(env.RATE_LIMITING_ENABLED),
    expected: true,
    required: secureLike,
    recommendation: "Set RATE_LIMITING_ENABLED=true and coordinate limits with the WAF."
  }));
  controls.push(corsControl(env.CORS_ALLOW_ORIGINS, productionLike));
  controls.push(positiveIntegerControl({
    id: "request_body_limit",
    category: "HTTP",
    label: "Request body limit is bounded",
    value: env.REQUEST_BODY_LIMIT_BYTES,
    fallback: 1_048_576,
    max: 2_097_152,
    recommendation: "Keep REQUEST_BODY_LIMIT_BYTES at or below 2 MiB unless a reviewed upload path is added."
  }));
  controls.push(positiveIntegerControl({
    id: "request_timeout",
    category: "HTTP",
    label: "Request timeout is bounded",
    value: env.REQUEST_TIMEOUT_MS,
    fallback: 15_000,
    max: 30_000,
    recommendation: "Keep REQUEST_TIMEOUT_MS at or below 30 seconds and use async jobs for longer work."
  }));
  controls.push(flagControl({
    id: "release_manifest_required",
    category: "IoT Integration",
    label: "IoT release manifest enforcement is enabled",
    actual: parseBoolean(env.IOT_REQUIRE_RELEASE_MANIFEST),
    expected: true,
    required: productionLike,
    recommendation: "Set IOT_REQUIRE_RELEASE_MANIFEST=true and mount the approved release manifest."
  }));
  controls.push(requiredValue({
    id: "release_manifest_path",
    category: "IoT Integration",
    label: "IoT release manifest path is configured",
    value: env.IOT_RELEASE_MANIFEST_PATH,
    required: productionLike,
    recommendation: "Set IOT_RELEASE_MANIFEST_PATH to the approved manifest mounted in the container."
  }));
  controls.push(requiredValue({
    id: "critical_alert_webhook",
    category: "Observability",
    label: "Critical alert webhook is configured",
    value: env.IOT_ALERT_WEBHOOK_URL_CRITICAL,
    required: productionLike,
    recommendation: "Route critical alerts to the on-call channel before go-live."
  }));
  controls.push(manualOrPass({
    id: "export_encryption",
    category: "Data protection",
    label: "Export artifact encryption is configured",
    passed: env.EXPORT_ENCRYPTION_MODE === "kms",
    required: productionLike,
    evidence: env.EXPORT_ENCRYPTION_MODE === "kms"
      ? "EXPORT_ENCRYPTION_MODE=kms is configured."
      : "KMS export encryption is not configured in the runtime environment.",
    recommendation: "Set EXPORT_ENCRYPTION_MODE=kms and use provider-managed object-store encryption for generated artifacts."
  }));
  controls.push(manualOrPass({
    id: "backup_encryption",
    category: "Data protection",
    label: "Encrypted backup policy is confirmed",
    passed: env.BACKUP_ENCRYPTION_CONFIRMED === "true",
    required: productionLike,
    evidence: env.BACKUP_ENCRYPTION_CONFIRMED === "true"
      ? "BACKUP_ENCRYPTION_CONFIRMED=true is configured."
      : "Backup encryption is an infrastructure control that must be confirmed by operators.",
    recommendation: "Confirm encrypted database backups and retention policy in the cloud provider."
  }));
  controls.push(...notificationDeploymentControls(env, productionLike));

  return controls;
}

export function summarizeControls(controls) {
  return controls.reduce((acc, control) => {
    acc.total += 1;
    acc[control.status] = (acc[control.status] ?? 0) + 1;
    return acc;
  }, { total: 0, pass: 0, warning: 0, manual: 0, fail: 0 });
}

async function checkDatabase(ctx) {
  if (ctx.backend !== "postgres") {
    return { ok: true, skipped: true };
  }
  if (!ctx.db?.healthcheck) {
    return { ok: false, error: "Postgres backend is selected but no database healthcheck is available." };
  }
  try {
    await ctx.db.healthcheck();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || "Database healthcheck failed." };
  }
}

function requiredValue({ id, category, label, value, required, expected = null, recommendation }) {
  const missing = value == null || String(value).trim() === "";
  const placeholder = !missing && isPlaceholder(value);
  const wrongExpected = expected != null && value !== expected;
  const status = missing || placeholder || wrongExpected ? (required ? "fail" : "warning") : "pass";
  return {
    id,
    category,
    label,
    status,
    evidence: missing
      ? "Value is missing."
      : placeholder
        ? "Value still looks like a placeholder."
        : wrongExpected
          ? `Value is ${redactValue(value)}; expected ${expected}.`
          : "Value is configured.",
    recommendation
  };
}

function secretControl({ id, category, label, value, required, minLength, recommendation }) {
  const missing = value == null || String(value).trim() === "";
  const placeholder = !missing && isPlaceholder(value);
  const short = !missing && String(value).length < minLength;
  const status = missing || placeholder || short ? (required ? "fail" : "warning") : "pass";
  return {
    id,
    category,
    label,
    status,
    evidence: missing
      ? "Secret is missing."
      : placeholder
        ? "Secret still looks like a placeholder."
        : short
          ? `Secret is shorter than ${minLength} characters.`
          : "Secret is present and length check passed.",
    recommendation
  };
}

function booleanControl({ id, category, label, actual, expected, required, recommendation }) {
  const pass = actual === expected;
  return {
    id,
    category,
    label,
    status: pass ? "pass" : required ? "fail" : "warning",
    evidence: pass ? `Value is ${expected}.` : `Value is ${actual ?? "unset"}; expected ${expected}.`,
    recommendation
  };
}

function flagControl({ id, category, label, actual, expected, required, recommendation }) {
  const pass = actual === expected;
  return {
    id,
    category,
    label,
    status: pass ? "pass" : required ? "fail" : "warning",
    evidence: pass ? `Flag is ${expected}.` : `Flag is ${actual ?? "unset"}; expected ${expected}.`,
    recommendation
  };
}

function corsControl(value, required) {
  const origins = String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const pass = origins.length > 0 && !origins.includes("*") && origins.every((origin) => origin.startsWith("https://"));
  return {
    id: "cors_allowlist",
    category: "HTTP",
    label: "CORS allowlist is explicit and HTTPS-only",
    status: pass ? "pass" : required ? "fail" : "warning",
    evidence: !origins.length
      ? "CORS allowlist is empty."
      : origins.includes("*")
        ? "CORS allowlist contains wildcard origin."
        : origins.some((origin) => !origin.startsWith("https://"))
          ? "One or more CORS origins are not HTTPS."
          : "CORS allowlist is explicit and HTTPS-only.",
    recommendation: "Set CORS_ALLOW_ORIGINS to the exact HTTPS browser origins that should call the API."
  };
}

function positiveIntegerControl({ id, category, label, value, fallback, max, recommendation }) {
  const numeric = value == null || value === "" ? fallback : Number(value);
  const pass = Number.isInteger(numeric) && numeric > 0 && numeric <= max;
  return {
    id,
    category,
    label,
    status: pass ? "pass" : "warning",
    evidence: pass ? `Value is ${numeric}.` : `Value is ${value ?? "unset"}; expected a positive integer up to ${max}.`,
    recommendation
  };
}

function manualOrPass({ id, category, label, passed, required, evidence, recommendation }) {
  return {
    id,
    category,
    label,
    status: passed ? "pass" : required ? "manual" : "warning",
    evidence,
    recommendation
  };
}

function parseBoolean(value) {
  if (value == null || value === "") {
    return null;
  }
  if (value === true || value === "true") {
    return true;
  }
  if (value === false || value === "false") {
    return false;
  }
  return null;
}

function notificationDeploymentControls(env, productionLike) {
  const channels = buildNotificationChannelsReadiness(env);
  const controls = [];
  const enabledChannels = channels.filter((entry) => entry.enabled);

  controls.push(manualOrPass({
    id: "notification_provider_modes",
    category: "Notification operations",
    label: "Enabled notification channels use production provider mode",
    passed: enabledChannels.every((entry) => entry.mode === "production"),
    required: productionLike && enabledChannels.length > 0,
    evidence: !enabledChannels.length
      ? "No notification delivery channels are enabled."
      : enabledChannels.map((entry) => `${entry.channel}: mode ${entry.mode}`).join("; "),
    recommendation: "Use NOTIFICATION_<CHANNEL>_PROVIDER_MODE=production for enabled production channels."
  }));

  for (const channel of enabledChannels.filter((entry) => entry.mode === "production")) {
    controls.push(requiredValue({
      id: `notification_provider_url_${channel.channel}`,
      category: "Notification operations",
      label: `${channel.channel.toUpperCase()} notification provider URL is configured`,
      value: channel.url,
      required: productionLike,
      recommendation: `Set NOTIFICATION_${channel.channel.toUpperCase()}_PROVIDER_URL to the approved provider endpoint.`
    }));
    controls.push(manualOrPass({
      id: `notification_provider_auth_${channel.channel}`,
      category: "Notification operations",
      label: `${channel.channel.toUpperCase()} notification auth configuration is complete`,
      passed: channel.production_ready,
      required: productionLike,
      evidence: (channel.checks ?? []).map((entry) => entry.reason).join(" "),
      recommendation: `Configure NOTIFICATION_${channel.channel.toUpperCase()} provider auth and keep timeouts bounded.`
    }));
    controls.push(manualOrPass({
      id: `notification_webhook_auth_${channel.channel}`,
      category: "Notification operations",
      label: `${channel.channel.toUpperCase()} notification webhook auth is configured`,
      passed: channel.webhook_ready,
      required: productionLike,
      evidence: (channel.webhook_checks ?? []).map((entry) => entry.reason).join(" "),
      recommendation: `Configure NOTIFICATION_${channel.channel.toUpperCase()} webhook auth with a shared secret or HMAC signature validation.`
    }));
  }

  const worker = resolveNotificationWorkerSchedule(env);
  controls.push(manualOrPass({
    id: "notification_worker_enabled",
    category: "Notification operations",
    label: "Notification worker scheduler is enabled for automated delivery",
    passed: worker.status === "ready",
    required: productionLike && enabledChannels.length > 0,
    evidence: worker.enabled
      ? `Worker enabled with interval ${worker.interval_seconds}s, batch ${worker.batch_limit}, tenant ${worker.tenant_id ?? "unset"}, event ${worker.event_id ?? "all-events"}.`
      : "Notification worker scheduler is disabled.",
    recommendation: "Enable NOTIFICATION_WORKER_ENABLED=true with tenant scope before relying on outbound automation."
  }));
  controls.push(positiveIntegerControl({
    id: "notification_worker_interval",
    category: "Notification operations",
    label: "Notification worker interval is bounded",
    value: env.NOTIFICATION_WORKER_INTERVAL_SECONDS,
    fallback: 60,
    max: 3600,
    recommendation: "Keep NOTIFICATION_WORKER_INTERVAL_SECONDS at or below one hour."
  }));
  controls.push(positiveIntegerControl({
    id: "notification_worker_batch_limit",
    category: "Notification operations",
    label: "Notification worker batch size is bounded",
    value: env.NOTIFICATION_WORKER_BATCH_LIMIT,
    fallback: 20,
    max: 200,
    recommendation: "Keep NOTIFICATION_WORKER_BATCH_LIMIT at or below 200 per poll."
  }));
  const retryPolicy = resolveNotificationRetryPolicy(env);
  controls.push(manualOrPass({
    id: "notification_max_attempts",
    category: "Notification operations",
    label: "Notification max attempts are bounded",
    passed: retryPolicy.max_attempts >= 1 && retryPolicy.max_attempts <= 10,
    required: productionLike && enabledChannels.length > 0,
    evidence: `Configured max attempts: ${retryPolicy.max_attempts}.`,
    recommendation: "Set NOTIFICATION_MAX_ATTEMPTS to a bounded value between 1 and 10."
  }));
  controls.push(manualOrPass({
    id: "notification_retry_delay_minutes",
    category: "Notification operations",
    label: "Notification retry delay is bounded",
    passed: retryPolicy.retry_delay_minutes >= 1 && retryPolicy.retry_delay_minutes <= 1440,
    required: productionLike && enabledChannels.length > 0,
    evidence: `Configured retry delay: ${retryPolicy.retry_delay_minutes} minute(s).`,
    recommendation: "Set NOTIFICATION_RETRY_DELAY_MINUTES to a bounded value between 1 minute and 24 hours."
  }));
  controls.push(manualOrPass({
    id: "notification_dead_letter_alert_threshold",
    category: "Notification operations",
    label: "Notification dead-letter backlog alert threshold is configured",
    passed:
      retryPolicy.dead_letter_alert_threshold >= 1 &&
      retryPolicy.dead_letter_alert_threshold <= 1000,
    required: productionLike && enabledChannels.length > 0,
    evidence: `Configured dead-letter alert threshold: ${retryPolicy.dead_letter_alert_threshold}.`,
    recommendation: "Set NOTIFICATION_DEAD_LETTER_ALERT_THRESHOLD to a bounded positive value."
  }));

  return controls;
}

function isPlaceholder(value) {
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(String(value)));
}

function redactValue(value) {
  if (value == null) {
    return "unset";
  }
  const text = String(value);
  if (text.length <= 6) {
    return "***";
  }
  return `${text.slice(0, 3)}...${text.slice(-3)}`;
}
