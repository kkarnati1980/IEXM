import { nextId } from "../store.mjs";

const MANAGED_CODES = ["IOT_RUN_FAILED", "IOT_HEALTH_CRITICAL", "IOT_PARITY_FAILED"];
const SEVERITY_RANK = {
  warning: 1,
  critical: 2
};

export function createIotAlertRouter(options = {}) {
  const repos = options.repos;
  if (!repos) {
    throw new Error("IoT alert router requires repositories");
  }

  const integrationName = options.integrationName ?? "iot_platform";
  const destinations = normalizeDestinations(options.destinations ?? {});
  if (options.webhookUrl) {
    destinations.default.push(options.webhookUrl);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const minSeverity = options.minSeverity ?? "warning";
  const defaultEnvironment = options.defaultEnvironment ?? "staging";

  return {
    async routeForEventState({ tenantId, eventId, run = null, health = null, parity = null }) {
      const now = new Date().toISOString();
      const alerts = buildAlerts({ integrationName, tenantId, eventId, run, health, parity, now });
      const activeCodes = new Set(alerts.map((entry) => entry.code));
      const codesToResolve = MANAGED_CODES.filter((code) => !activeCodes.has(code));
      const resolved = await repos.iotAlertEvents.resolveOpenByCodes(tenantId, eventId, codesToResolve, now);
      const routed = [];

      for (const alert of alerts) {
        const persisted = await repos.iotAlertEvents.upsert(alert);
        const delivered = await deliverAlert({
          repos,
          persisted,
          destinations: resolveDestinations({ persisted, destinations, defaultEnvironment }),
          fetchImpl,
          minSeverity
        });
        routed.push(delivered);
      }

      return {
        triggered_count: routed.length,
        resolved_count: resolved,
        items: routed
      };
    }
  };
}

function buildAlerts({ integrationName, tenantId, eventId, run, health, parity, now }) {
  const alerts = [];

  if (run?.status === "failed") {
    alerts.push({
      id: nextId("iot-alert"),
      integration_name: integrationName,
      tenant_id: tenantId,
      event_id: eventId,
      source_type: "run",
      source_id: run.id,
      dedupe_key: `run:${run.id}:failed`,
      severity: "critical",
      status: "open",
      code: "IOT_RUN_FAILED",
      message: "IoT integration orchestration run failed",
      details: {
        environment: run.summary?.environment ?? "staging",
        run_id: run.id,
        trigger_mode: run.trigger_mode,
        failed_step_count: run.failed_step_count,
        error_summary: run.error_summary,
        failed_steps: run.summary?.failed_step_names ?? []
      },
      delivery_status: "pending",
      routed_destinations: [],
      last_delivery_at: null,
      delivery_error: null,
      created_at: now,
      updated_at: now
    });
  }

  if (health && ["critical", "failed"].includes(health.overall_status ?? health.status)) {
    alerts.push({
      id: nextId("iot-alert"),
      integration_name: integrationName,
      tenant_id: tenantId,
      event_id: eventId,
      source_type: "health",
      source_id: health.id ?? health.checked_at ?? now,
      dedupe_key: `health:${eventId}:${health.checked_at ?? now}:${health.overall_status ?? health.status}`,
      severity: "critical",
      status: "open",
      code: "IOT_HEALTH_CRITICAL",
      message: "IoT operational health is critical",
      details: {
        environment: health.environment ?? "staging",
        overall_status: health.overall_status ?? health.status,
        certification_status: health.certification_status,
        checked_at: health.checked_at,
        warning_count: health.warning_count,
        warnings: health.warnings ?? []
      },
      delivery_status: "pending",
      routed_destinations: [],
      last_delivery_at: null,
      delivery_error: null,
      created_at: now,
      updated_at: now
    });
  }

  if (parity?.status === "failed") {
    alerts.push({
      id: nextId("iot-alert"),
      integration_name: integrationName,
      tenant_id: tenantId,
      event_id: eventId,
      source_type: "parity",
      source_id: parity.id ?? parity.checked_at ?? now,
      dedupe_key: `parity:${eventId}:${parity.checked_at ?? now}:failed`,
      severity: "critical",
      status: "open",
      code: "IOT_PARITY_FAILED",
      message: "IoT staging-to-production parity check failed",
      details: {
        environment: "staging",
        checked_at: parity.checked_at,
        issues: parity.issues ?? [],
        staging_contract_version: parity.staging_contract_version,
        production_contract_version: parity.production_contract_version,
        staging_build_version: parity.staging_build_version,
        production_build_version: parity.production_build_version
      },
      delivery_status: "pending",
      routed_destinations: [],
      last_delivery_at: null,
      delivery_error: null,
      created_at: now,
      updated_at: now
    });
  }

  return alerts;
}

async function deliverAlert({ repos, persisted, destinations, fetchImpl, minSeverity }) {
  if (!shouldSend(persisted.severity, minSeverity) || !destinations.length) {
    return repos.iotAlertEvents.upsert({
      ...persisted,
      delivery_status: "not_configured",
      routed_destinations: [],
      updated_at: new Date().toISOString()
    });
  }

  const payload = {
    integration_name: persisted.integration_name,
    tenant_id: persisted.tenant_id,
    event_id: persisted.event_id,
    code: persisted.code,
    severity: persisted.severity,
    message: persisted.message,
    source_type: persisted.source_type,
    source_id: persisted.source_id,
    details: persisted.details,
    created_at: persisted.created_at
  };

  try {
    const results = await Promise.all(
      destinations.map(async (destination) => {
        const response = await fetchImpl(destination, {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify(payload)
        });
        return { destination, ok: response.ok, status: response.status };
      })
    );
    const failed = results.find((entry) => !entry.ok);

    return repos.iotAlertEvents.upsert({
      ...persisted,
      delivery_status: failed ? "failed" : "delivered",
      routed_destinations: destinations,
      last_delivery_at: new Date().toISOString(),
      delivery_error: failed ? `Webhook returned ${failed.status} from ${failed.destination}` : null,
      updated_at: new Date().toISOString()
    });
  } catch (error) {
    return repos.iotAlertEvents.upsert({
      ...persisted,
      delivery_status: "failed",
      routed_destinations: destinations,
      last_delivery_at: new Date().toISOString(),
      delivery_error: error.message ?? "Webhook delivery failed",
      updated_at: new Date().toISOString()
    });
  }
}

function shouldSend(severity, minSeverity) {
  return (SEVERITY_RANK[severity] ?? 0) >= (SEVERITY_RANK[minSeverity] ?? 0);
}

function resolveDestinations({ persisted, destinations, defaultEnvironment }) {
  const resolved = new Set(destinations.default);
  const sourceEnvironment = determineEnvironment(persisted, defaultEnvironment);

  for (const destination of destinations[sourceEnvironment] ?? []) {
    resolved.add(destination);
  }

  if (persisted.code === "IOT_PARITY_FAILED") {
    for (const destination of destinations.parity) {
      resolved.add(destination);
    }
    for (const destination of destinations.staging) {
      resolved.add(destination);
    }
    for (const destination of destinations.production) {
      resolved.add(destination);
    }
  }

  if (persisted.severity === "critical") {
    for (const destination of destinations.critical) {
      resolved.add(destination);
    }
  }

  return [...resolved];
}

function determineEnvironment(alert, fallback) {
  if (alert.details?.environment) {
    return alert.details.environment;
  }
  if (alert.details?.staging_contract_version || alert.code === "IOT_PARITY_FAILED") {
    return "staging";
  }
  return fallback;
}

function normalizeDestinations(destinations) {
  return {
    default: normalizeUrlList(destinations.default),
    staging: normalizeUrlList(destinations.staging),
    production: normalizeUrlList(destinations.production),
    parity: normalizeUrlList(destinations.parity),
    critical: normalizeUrlList(destinations.critical)
  };
}

function normalizeUrlList(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.filter(Boolean);
  }
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
