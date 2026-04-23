import {
  buildNotificationChannelsReadiness,
  resolveNotificationWorkerSchedule
} from "./notification-providers.mjs";
import { resolveNotificationRetryPolicy } from "./notification-worker.mjs";

const SECURITY_SEVERITY_RANK = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0
};

const SENSITIVE_ROUTE_PREFIXES = [
  "admin.",
  "audit.",
  "break_glass.",
  "device.credentials.",
  "exports.",
  "organizer.compliance",
  "organizer.retention",
  "organizer.downstream_deletion"
];

export function buildSecurityReadiness(ctx) {
  const controls = [
    control({
      id: "secure_mode",
      category: "Authentication",
      label: "Secure application mode is available",
      status: ctx.securityMode === "secure" ? "pass" : "warning",
      evidence:
        ctx.securityMode === "secure"
          ? "APP_SECURITY_MODE is secure."
          : "Current runtime is local_demo; use secure mode for staging and production.",
      recommendation: "Run staging and production with APP_SECURITY_MODE=secure."
    }),
    control({
      id: "browser_oidc",
      category: "Authentication",
      label: "Browser users authenticate through OIDC/SSO",
      status: ctx.securityMode === "secure" && ctx.oidc?.enabled ? "pass" : "warning",
      evidence:
        ctx.securityMode === "secure" && ctx.oidc?.enabled
          ? "OIDC verifier is enabled for browser users."
          : "OIDC is not enabled in this runtime.",
      recommendation: "Enable OIDC issuer, audience, and browser client configuration before production."
    }),
    control({
      id: "seed_tokens_disabled",
      category: "Authentication",
      label: "Seed bearer tokens are disabled outside local demos",
      status: ctx.securityMode === "secure" && !ctx.allowSeedTokens ? "pass" : "warning",
      evidence: ctx.allowSeedTokens
        ? "Seed bearer tokens are accepted by this runtime."
        : "Seed bearer tokens are disabled.",
      recommendation: "Keep AUTH_ALLOW_SEED_TOKENS=false in secure environments."
    }),
    control({
      id: "oidc_email_fallback_disabled",
      category: "Authentication",
      label: "OIDC email fallback is disabled by default",
      status: ctx.oidc?.allowEmailFallback ? "warning" : "pass",
      evidence: ctx.oidc?.allowEmailFallback
        ? "OIDC email fallback is enabled."
        : "OIDC identities must match an explicit linked issuer and subject.",
      recommendation: "Use explicit issuer+subject linking for production accounts."
    }),
    control({
      id: "security_headers",
      category: "Browser/API hardening",
      label: "Security headers are emitted",
      status: ctx.securityHeadersEnabled ? "pass" : "warning",
      evidence: ctx.securityHeadersEnabled
        ? "Default security headers are enabled."
        : "Default security headers are disabled.",
      recommendation: "Enable SECURITY_HEADERS_ENABLED=true in staging and production."
    }),
    control({
      id: "hsts",
      category: "Browser/API hardening",
      label: "HSTS is active in secure mode",
      status: ctx.defaultResponseHeaders?.["strict-transport-security"] ? "pass" : "warning",
      evidence: ctx.defaultResponseHeaders?.["strict-transport-security"]
        ? "Strict-Transport-Security header is present."
        : "Strict-Transport-Security header is not present in this runtime.",
      recommendation: "Serve production over HTTPS and keep HSTS enabled."
    }),
    control({
      id: "rate_limiting",
      category: "Abuse controls",
      label: "Sensitive routes have basic rate limiting",
      status: ctx.rateLimiter ? "pass" : "warning",
      evidence: ctx.rateLimiter
        ? "Rate limiter is active for auth, public, sensitive, and admin buckets."
        : "Rate limiter is disabled.",
      recommendation: "Enable RATE_LIMITING_ENABLED=true and tune limits with the edge/WAF."
    }),
    control({
      id: "database_runtime_role",
      category: "Database isolation",
      label: "Database runtime role is separated from migrator/admin access",
      status: ctx.backend === "postgres" && ctx.databaseRuntimeRole ? "pass" : "warning",
      evidence:
        ctx.backend === "postgres" && ctx.databaseRuntimeRole
          ? `Postgres runtime role is ${ctx.databaseRuntimeRole}.`
          : "Current runtime is not using the Postgres runtime role path.",
      recommendation: "Use DATABASE_RUNTIME_ROLE=app_runtime with forced RLS for production."
    }),
    control({
      id: "database_tls_verification",
      category: "Transport encryption",
      label: "Database TLS certificate verification is not disabled",
      status: resolveDatabaseTlsStatus(ctx),
      evidence: resolveDatabaseTlsEvidence(ctx),
      recommendation: "Use DATABASE_SSL=true with DATABASE_SSL_REJECT_UNAUTHORIZED=true for managed production Postgres."
    }),
    control({
      id: "audit_immutability",
      category: "Audit integrity",
      label: "Audit logs are append-only for runtime access",
      status: ctx.backend === "postgres" ? "pass" : "warning",
      evidence:
        ctx.backend === "postgres"
          ? "Postgres migrations restrict app_runtime audit access to SELECT and INSERT."
          : "Memory runtime is mutable and intended for local/demo use only.",
      recommendation: "Use the Postgres backend for staging/production audit evidence."
    }),
    control({
      id: "data_encryption",
      category: "Data protection",
      label: "PII/export encryption is ready for production",
      status: process.env.EXPORT_ENCRYPTION_MODE === "kms" ? "pass" : "warning",
      evidence:
        process.env.EXPORT_ENCRYPTION_MODE === "kms"
          ? "EXPORT_ENCRYPTION_MODE=kms is configured."
          : "Application-level export/KMS encryption is not configured in this runtime.",
      recommendation: "Use managed at-rest encryption plus KMS envelope encryption for export artifacts and backups."
    }),
    control({
      id: "wallet_provider_mode",
      category: "Wallet provider security",
      label: "Wallet provider mode is production-safe",
      status: resolveWalletProviderModeStatus(ctx),
      evidence: resolveWalletProviderModeEvidence(ctx),
      recommendation: "Keep wallet passes disabled until configured, and use WALLET_PASS_PROVIDER_MODE=production for production launches."
    }),
    control({
      id: "wallet_provider_key_refs",
      category: "Wallet provider security",
      label: "Wallet provider signing material uses managed key references",
      status: resolveWalletProviderKeyStatus(ctx),
      evidence: resolveWalletProviderKeyEvidence(ctx),
      recommendation: "Set WALLET_PASS_SIGNING_KEY_REF and WALLET_PASS_ISSUER_ID through KMS/Vault-backed secret references, not pasted private keys."
    }),
    control({
      id: "notification_provider_mode",
      category: "Notification provider security",
      label: "Enabled notification channels use production-safe provider modes",
      status: resolveNotificationProviderModeStatus(ctx),
      evidence: resolveNotificationProviderModeEvidence(ctx),
      recommendation: "Use NOTIFICATION_<CHANNEL>_PROVIDER_MODE=production for enabled production channels, and keep unused channels disabled."
    }),
    control({
      id: "notification_provider_config",
      category: "Notification provider security",
      label: "Enabled notification channels have required provider configuration",
      status: resolveNotificationProviderConfigStatus(ctx),
      evidence: resolveNotificationProviderConfigEvidence(ctx),
      recommendation: "Set NOTIFICATION_<CHANNEL>_PROVIDER_URL, auth configuration, and bounded timeout values for each enabled production channel."
    }),
    control({
      id: "notification_webhook_auth",
      category: "Notification provider security",
      label: "Enabled production notification channels use authenticated provider webhooks",
      status: resolveNotificationWebhookAuthStatus(ctx),
      evidence: resolveNotificationWebhookAuthEvidence(ctx),
      recommendation: "Use shared-secret or HMAC webhook authentication for enabled production channels, never unauthenticated webhooks."
    }),
    control({
      id: "notification_worker_schedule",
      category: "Notification operations",
      label: "Outbound notification worker scheduler is configured",
      status: resolveNotificationWorkerScheduleStatus(ctx),
      evidence: resolveNotificationWorkerScheduleEvidence(ctx),
      recommendation: "Enable the worker scheduler with explicit tenant scope, bounded interval, and bounded batch size before relying on automated follow-up delivery."
    }),
    control({
      id: "notification_retry_governance",
      category: "Notification operations",
      label: "Outbound notification retry limits and dead-letter thresholds are bounded",
      status: resolveNotificationRetryGovernanceStatus(ctx),
      evidence: resolveNotificationRetryGovernanceEvidence(ctx),
      recommendation: "Set bounded NOTIFICATION_MAX_ATTEMPTS, NOTIFICATION_RETRY_DELAY_MINUTES, and NOTIFICATION_DEAD_LETTER_ALERT_THRESHOLD values before production messaging is relied on."
    }),
    control({
      id: "external_pentest",
      category: "Penetration testing",
      label: "External penetration test is scheduled after production rehearsal",
      status: process.env.PENTEST_SCHEDULED === "true" ? "pass" : "manual",
      evidence:
        process.env.PENTEST_SCHEDULED === "true"
          ? "PENTEST_SCHEDULED=true is configured."
          : "External pen-test scheduling is an operational gate, not detectable from runtime.",
      recommendation: "Schedule external penetration testing after final production testing and before go-live."
    })
  ];

  const counts = controls.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] ?? 0) + 1;
    return acc;
  }, {});
  const overallStatus = counts.fail
    ? "blocked"
    : counts.warning || counts.manual
      ? "needs_attention"
      : "ready";

  return {
    generated_at: new Date().toISOString(),
    overall_status: overallStatus,
    summary: {
      total: controls.length,
      pass: counts.pass ?? 0,
      warning: counts.warning ?? 0,
      manual: counts.manual ?? 0,
      fail: counts.fail ?? 0
    },
    controls
  };
}

function resolveWalletProviderModeStatus(ctx) {
  const enabled = ctx.env?.WALLET_PASS_ENABLED === "true";
  const mode = ctx.env?.WALLET_PASS_PROVIDER_MODE ?? "not_configured";
  if (!enabled) {
    return "pass";
  }
  if (mode === "production") {
    return "pass";
  }
  return mode === "mock_success" ? "warning" : "fail";
}

function resolveWalletProviderModeEvidence(ctx) {
  const enabled = ctx.env?.WALLET_PASS_ENABLED === "true";
  const mode = ctx.env?.WALLET_PASS_PROVIDER_MODE ?? "not_configured";
  if (!enabled) {
    return "Wallet pass issuance is disabled, so no provider signing path is exposed.";
  }
  return `Wallet pass issuance is enabled with provider mode ${mode}.`;
}

function resolveWalletProviderKeyStatus(ctx) {
  const enabled = ctx.env?.WALLET_PASS_ENABLED === "true";
  const mode = ctx.env?.WALLET_PASS_PROVIDER_MODE ?? "not_configured";
  if (!enabled) {
    return "pass";
  }
  if (mode !== "production") {
    return "manual";
  }
  return ctx.env?.WALLET_PASS_SIGNING_KEY_REF && ctx.env?.WALLET_PASS_ISSUER_ID
    ? "pass"
    : "fail";
}

function resolveWalletProviderKeyEvidence(ctx) {
  const enabled = ctx.env?.WALLET_PASS_ENABLED === "true";
  const mode = ctx.env?.WALLET_PASS_PROVIDER_MODE ?? "not_configured";
  if (!enabled) {
    return "Wallet provider is disabled; signing keys are not loaded.";
  }
  if (mode !== "production") {
    return "Wallet provider is not in production mode; production key references require manual release review.";
  }
  const hasKeyRef = Boolean(ctx.env?.WALLET_PASS_SIGNING_KEY_REF);
  const hasIssuer = Boolean(ctx.env?.WALLET_PASS_ISSUER_ID);
  return `Signing key reference configured: ${hasKeyRef ? "yes" : "no"}; issuer configured: ${hasIssuer ? "yes" : "no"}.`;
}

function resolveNotificationProviderModeStatus(ctx) {
  const channels = buildNotificationChannelsReadiness(ctx.env);
  const enabled = channels.filter((entry) => entry.enabled);
  if (!enabled.length) {
    return "pass";
  }
  if (enabled.every((entry) => entry.mode === "production")) {
    return "pass";
  }
  if (enabled.some((entry) => entry.mode === "not_configured")) {
    return "fail";
  }
  return "warning";
}

function resolveNotificationProviderModeEvidence(ctx) {
  const channels = buildNotificationChannelsReadiness(ctx.env);
  const enabled = channels.filter((entry) => entry.enabled);
  if (!enabled.length) {
    return "No outbound notification channels are enabled.";
  }
  return enabled
    .map((entry) => `${entry.channel}: mode ${entry.mode}`)
    .join("; ");
}

function resolveNotificationProviderConfigStatus(ctx) {
  const channels = buildNotificationChannelsReadiness(ctx.env);
  const enabledProduction = channels.filter((entry) => entry.enabled && entry.mode === "production");
  if (!enabledProduction.length) {
    return channels.some((entry) => entry.enabled) ? "manual" : "pass";
  }
  return enabledProduction.every((entry) => entry.production_ready) ? "pass" : "fail";
}

function resolveNotificationProviderConfigEvidence(ctx) {
  const channels = buildNotificationChannelsReadiness(ctx.env).filter((entry) => entry.enabled);
  if (!channels.length) {
    return "No notification providers are enabled.";
  }
  return channels
    .map((entry) => {
      const failedChecks = (entry.checks ?? []).filter((check) => !check.ok).map((check) => check.reason);
      return failedChecks.length
        ? `${entry.channel}: ${failedChecks.join(" ")}`
        : `${entry.channel}: provider configuration checks passed.`;
    })
    .join("; ");
}

function resolveNotificationWebhookAuthStatus(ctx) {
  const channels = buildNotificationChannelsReadiness(ctx.env);
  const enabledProduction = channels.filter((entry) => entry.enabled && entry.mode === "production");
  if (!enabledProduction.length) {
    return channels.some((entry) => entry.enabled) ? "manual" : "pass";
  }
  return enabledProduction.every((entry) => entry.webhook_ready) ? "pass" : "fail";
}

function resolveNotificationWebhookAuthEvidence(ctx) {
  const channels = buildNotificationChannelsReadiness(ctx.env).filter((entry) => entry.enabled);
  if (!channels.length) {
    return "No notification providers are enabled.";
  }
  return channels
    .map((entry) => {
      const failedChecks = (entry.webhook_checks ?? []).filter((check) => !check.ok).map((check) => check.reason);
      return failedChecks.length
        ? `${entry.channel}: ${failedChecks.join(" ")}`
        : `${entry.channel}: webhook auth mode ${entry.webhook_auth_mode}.`;
    })
    .join("; ");
}

function resolveNotificationWorkerScheduleStatus(ctx) {
  const channels = buildNotificationChannelsReadiness(ctx.env).filter((entry) => entry.enabled);
  if (!channels.length) {
    return "pass";
  }
  const schedule = resolveNotificationWorkerSchedule(ctx.env);
  return schedule.status === "ready" ? "pass" : "fail";
}

function resolveNotificationWorkerScheduleEvidence(ctx) {
  const channels = buildNotificationChannelsReadiness(ctx.env).filter((entry) => entry.enabled);
  if (!channels.length) {
    return "Notification worker scheduling is not required because notification delivery is disabled.";
  }
  const schedule = resolveNotificationWorkerSchedule(ctx.env);
  const checkSummary = (schedule.checks ?? []).map((entry) => entry.reason).join(" ");
  return `Scheduler status: ${schedule.status}. ${checkSummary}`.trim();
}

function resolveNotificationRetryGovernanceStatus(ctx) {
  const policy = resolveNotificationRetryPolicy(ctx.env);
  const boundedMaxAttempts = policy.max_attempts >= 1 && policy.max_attempts <= 10;
  const boundedRetryDelay = policy.retry_delay_minutes >= 1 && policy.retry_delay_minutes <= 1440;
  const boundedDeadLetterThreshold =
    policy.dead_letter_alert_threshold >= 1 && policy.dead_letter_alert_threshold <= 1000;
  return boundedMaxAttempts && boundedRetryDelay && boundedDeadLetterThreshold ? "pass" : "warning";
}

function resolveNotificationRetryGovernanceEvidence(ctx) {
  const policy = resolveNotificationRetryPolicy(ctx.env);
  return `Notification retry policy: max attempts ${policy.max_attempts}, retry delay ${policy.retry_delay_minutes} minutes, dead-letter alert threshold ${policy.dead_letter_alert_threshold}.`;
}

export function buildSecurityAlerts({
  readiness,
  auditLogs = [],
  breakGlassRequests = [],
  users = [],
  pentestFindings = [],
  notificationProviderReadiness = null,
  notificationWorkerSchedule = null,
  notificationDeadLetterSummary = null,
  now = new Date()
}) {
  const alerts = [];
  const nowMs = now.getTime();

  for (const item of readiness.controls) {
    if (item.status === "fail") {
      alerts.push(alert({
        rule_id: `readiness.${item.id}`,
        severity: item.id.includes("seed") || item.id.includes("oidc") ? "critical" : "high",
        title: item.label,
        body: item.evidence,
        source: "security_readiness",
        created_at: readiness.generated_at,
        recommendation: item.recommendation
      }));
    }
  }

  for (const request of breakGlassRequests) {
    if (request.status === "active") {
      alerts.push(alert({
        rule_id: "break_glass.active",
        severity: "critical",
        title: "Active break-glass session",
        body: `Break-glass request ${request.id} is active until ${request.expires_at}.`,
        source: "break_glass",
        created_at: request.starts_at ?? request.created_at,
        target_id: request.id,
        recommendation: "Review the investigation reason and revoke as soon as emergency access is no longer required."
      }));
    } else if (isRecent(request.created_at, nowMs, 24)) {
      alerts.push(alert({
        rule_id: `break_glass.${request.status}`,
        severity: request.status === "revoked" || request.status === "expired" ? "medium" : "high",
        title: `Recent break-glass ${request.status}`,
        body: `Break-glass request ${request.id} changed state recently.`,
        source: "break_glass",
        created_at: request.created_at,
        target_id: request.id,
        recommendation: "Confirm the emergency access request has matching ticket and approver evidence."
      }));
    }
  }

  for (const log of auditLogs) {
    const eventType = log.event_type ?? "";
    if (!eventType.endsWith(".denied") && !eventType.endsWith(".failed")) {
      continue;
    }

    const authReason = log.metadata?.auth_reason ?? "";
    const sensitive = isSensitiveSecurityEvent(eventType);
    const statusCode = Number(log.metadata?.status_code ?? 0);
    const severity = statusCode >= 500
      ? "high"
      : authReason.startsWith("user_status_")
        ? "high"
        : sensitive
          ? "high"
          : "medium";

    alerts.push(alert({
      rule_id: authReason.startsWith("user_status_") ? "auth.lifecycle_denied" : "audit.denied_or_failed",
      severity,
      title: authReason.startsWith("user_status_")
        ? "Blocked inactive user login attempt"
        : sensitive
          ? "Denied sensitive action"
          : "Denied or failed request",
      body: `${eventType} returned ${statusCode || "an error"} for actor ${log.actor_id}.`,
      source: "audit",
      created_at: log.created_at,
      target_id: log.target_id,
      evidence: {
        audit_id: log.id,
        event_type: eventType,
        actor_id: log.actor_id,
        target_type: log.target_type,
        target_id: log.target_id,
        request_id: log.metadata?.request_id ?? null,
        permission: log.metadata?.permission ?? null,
        role: log.metadata?.role ?? null,
        auth_reason: authReason || null
      },
      recommendation: "Review whether this was expected operator behavior, probing, or misconfigured access."
    }));
  }

  for (const user of users) {
    if (["disabled", "suspended", "deleted"].includes(user.status) && user.last_login_at && isRecent(user.last_login_at, nowMs, 72)) {
      alerts.push(alert({
        rule_id: "user.inactive_recent_login",
        severity: "medium",
        title: "Inactive user has recent login timestamp",
        body: `${user.email} is ${user.status} but has a recent last_login_at value.`,
        source: "iam",
        created_at: user.last_login_at,
        target_id: user.id,
        recommendation: "Confirm the lifecycle action occurred after the login and investigate if timing does not match."
      }));
    }
  }

  for (const finding of pentestFindings) {
    if (!["open", "triaged", "in_progress"].includes(finding.status)) {
      continue;
    }
    if (!["critical", "high"].includes(finding.severity)) {
      continue;
    }
    alerts.push(alert({
      rule_id: "pentest.open_high_or_critical",
      severity: finding.severity,
      title: `Open ${finding.severity} pen-test finding`,
      body: finding.title,
      source: "pentest",
      created_at: finding.updated_at ?? finding.created_at,
      target_id: finding.id,
      evidence: {
        finding_id: finding.id,
        status: finding.status,
        category: finding.category,
        affected_area: finding.affected_area ?? null,
        due_at: finding.due_at ?? null
      },
      recommendation: "Remediate, verify, and mark the finding remediated before go-live, or capture a formal accepted-risk decision."
    }));
  }

  const enabledNotificationChannels = (notificationProviderReadiness ?? [])
    .filter((entry) => entry.enabled);
  if (enabledNotificationChannels.length && notificationWorkerSchedule?.status !== "ready") {
    alerts.push(alert({
      rule_id: "notifications.scheduler_misconfigured",
      severity: "high",
      title: "Outbound notification worker is not scheduled safely",
      body: `Enabled notification channels exist, but the worker scheduler is ${notificationWorkerSchedule?.status ?? "unknown"}.`,
      source: "notification_delivery",
      created_at: now.toISOString(),
      recommendation: "Enable the scheduled worker with explicit tenant scope, bounded interval, and bounded batch size before production messaging is relied on."
    }));
  }

  if (
    notificationDeadLetterSummary?.total != null &&
    notificationDeadLetterSummary?.threshold != null &&
    notificationDeadLetterSummary.total >= notificationDeadLetterSummary.threshold
  ) {
    alerts.push(alert({
      rule_id: "notifications.dead_letter_backlog",
      severity: "high",
      title: "Outbound notification dead-letter backlog exceeds threshold",
      body: `${notificationDeadLetterSummary.total} notifications are in dead-letter state across ${notificationDeadLetterSummary.events_with_dead_letter ?? 0} event(s), meeting or exceeding the threshold of ${notificationDeadLetterSummary.threshold}.`,
      source: "notification_delivery",
      created_at: now.toISOString(),
      evidence: notificationDeadLetterSummary,
      recommendation: "Review retry exhaustion causes, clear provider issues, and use force-requeue only after investigation."
    }));
  }

  const sorted = alerts.sort((left, right) => {
    const rank = SECURITY_SEVERITY_RANK[right.severity] - SECURITY_SEVERITY_RANK[left.severity];
    if (rank !== 0) {
      return rank;
    }
    return Date.parse(right.created_at ?? 0) - Date.parse(left.created_at ?? 0);
  });

  return {
    generated_at: new Date().toISOString(),
    summary: sorted.reduce((acc, item) => {
      acc.total += 1;
      acc[item.severity] = (acc[item.severity] ?? 0) + 1;
      return acc;
    }, { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 }),
    items: sorted
  };
}

export function buildPentestEvidencePack({
  readiness,
  alerts,
  accessControlMatrix,
  auditLogs,
  pentestFindings = [],
  attackSurface = null
}) {
  const securityAuditLogs = auditLogs
    .filter((entry) =>
      entry.event_type?.includes("admin.") ||
      entry.event_type?.includes("break_glass") ||
      entry.event_type?.includes("audit.") ||
      entry.event_type?.includes("exports.") ||
      entry.event_type?.endsWith(".denied") ||
      entry.event_type?.endsWith(".failed")
    )
    .slice(0, 50);

  return {
    generated_at: new Date().toISOString(),
    purpose: "Sprint 9 external penetration testing support and remediation evidence pack",
    readiness,
    security_alerts: alerts,
    access_control: {
      route_permission_count: accessControlMatrix.length,
      sensitive_permission_count: accessControlMatrix.filter((entry) =>
        ["security", "secret", "secret-adjacent", "pii", "privacy"].includes(entry.sensitivity)
      ).length,
      items: accessControlMatrix
    },
    attack_surface: attackSurface,
    finding_summary: summarizePentestFindings(pentestFindings),
    pentest_findings: pentestFindings,
    recent_security_audit_logs: securityAuditLogs,
    handoff_checklist: [
      "Verify secure OIDC/SSO login in staging with real identity provider.",
      "Confirm no seed bearer tokens or tokens in URLs are accepted in secure mode.",
      "Confirm platform-admin IAM user lifecycle and scoped access changes are audited.",
      "Confirm break-glass requires two distinct approvers and expires/revokes correctly.",
      "Run SAST, dependency, secret, and DAST scans before external penetration testing.",
      "Provide this evidence pack, OpenAPI spec, masking matrix, break-glass SOP, and access-control matrix to the tester."
    ]
  };
}

export function buildAttackSurfaceReport({ accessControlMatrix, routes }) {
  const sensitive = accessControlMatrix.filter((entry) =>
    ["security", "secret", "secret-adjacent", "pii", "privacy", "sensitive"].includes(entry.sensitivity)
  );
  return {
    generated_at: new Date().toISOString(),
    route_count: routes.length,
    authenticated_route_count: accessControlMatrix.filter((entry) => entry.roles.length > 0).length,
    public_route_count: accessControlMatrix.filter((entry) => entry.roles.length === 0).length,
    sensitive_route_count: sensitive.length,
    public_routes: accessControlMatrix
      .filter((entry) => entry.roles.length === 0)
      .map((entry) => ({
        route_id: entry.route_id,
        permission: entry.permission,
        sensitivity: entry.sensitivity,
        description: entry.description
      })),
    sensitive_routes: sensitive.map((entry) => ({
      route_id: entry.route_id,
      permission: entry.permission,
      roles: entry.roles,
      sensitivity: entry.sensitivity,
      scope: entry.scope
    })),
    tester_notes: [
      "Do not perform destructive testing against production data.",
      "Use staging accounts with explicit written authorization and scoped test data.",
      "High and critical findings must be tracked through the platform-admin pen-test finding workflow."
    ]
  };
}

export function summarizePentestFindings(findings = []) {
  return findings.reduce((acc, finding) => {
    acc.total += 1;
    acc.by_status[finding.status] = (acc.by_status[finding.status] ?? 0) + 1;
    acc.by_severity[finding.severity] = (acc.by_severity[finding.severity] ?? 0) + 1;
    if (["open", "triaged", "in_progress"].includes(finding.status) && ["critical", "high"].includes(finding.severity)) {
      acc.blocking += 1;
    }
    return acc;
  }, {
    total: 0,
    blocking: 0,
    by_status: {},
    by_severity: {}
  });
}

function control({ id, category, label, status, evidence, recommendation }) {
  return { id, category, label, status, evidence, recommendation };
}

function alert({ rule_id, severity, title, body, source, created_at, target_id = null, evidence = null, recommendation }) {
  return {
    id: `${rule_id}:${target_id ?? created_at ?? title}`.replaceAll(/\s+/g, "-").toLowerCase(),
    rule_id,
    severity,
    title,
    body,
    source,
    target_id,
    evidence,
    recommendation,
    created_at: created_at ?? new Date().toISOString()
  };
}

function resolveDatabaseTlsStatus(ctx) {
  if (ctx.backend !== "postgres") {
    return "manual";
  }
  if (!ctx.databaseSsl) {
    return ctx.securityMode === "secure" ? "warning" : "manual";
  }
  return ctx.databaseSslRejectUnauthorized ? "pass" : "fail";
}

function resolveDatabaseTlsEvidence(ctx) {
  if (ctx.backend !== "postgres") {
    return "Runtime is not using Postgres in this environment.";
  }
  if (!ctx.databaseSsl) {
    return "Postgres SSL is disabled in this runtime.";
  }
  return ctx.databaseSslRejectUnauthorized
    ? "Postgres SSL certificate verification is enabled."
    : "Postgres SSL is enabled but certificate verification is disabled.";
}

function isRecent(value, nowMs, hours) {
  if (!value) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && nowMs - timestamp <= hours * 60 * 60 * 1000;
}

function isSensitiveSecurityEvent(eventType) {
  return SENSITIVE_ROUTE_PREFIXES.some((prefix) => eventType.startsWith(prefix));
}
