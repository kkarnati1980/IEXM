import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import { HttpError } from "../src/http-error.mjs";
import { createIotContractCertificationRunner } from "../src/iot/contract-certification-runner.mjs";
import { createIotCertificationHealthRunner } from "../src/iot/certification-health-runner.mjs";
import { createIotDeviceOpsSyncService } from "../src/iot/device-ops-sync-service.mjs";
import { createIotIntegrationOrchestrator } from "../src/iot/integration-orchestrator.mjs";
import { createMockIotApp } from "../src/iot/mock-app.mjs";
import { createIotPlatformAdapter } from "../src/iot/platform-adapter.mjs";
import { createIotHeartbeatSyncService } from "../src/iot/heartbeat-sync-service.mjs";
import { createIotIncidentSyncService } from "../src/iot/incident-sync-service.mjs";
import { createIotTapSyncService } from "../src/iot/tap-sync-service.mjs";

function createInjectFetch(app) {
  return async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.href ?? String(input));
    const response = await app.inject({
      method: init.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : {}
    });

    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode,
      async json() {
        return response.body;
      }
    };
  };
}

function createDispatchFetch(routes) {
  return async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.href ?? String(input));
    const handler = routes[url.host];
    if (!handler) {
      throw new Error(`No fetch handler configured for host ${url.host}`);
    }

    if (typeof handler === "function") {
      return handler(url, init);
    }

    return createInjectFetch(handler)(url, init);
  };
}

test("mock IoT app serves contract metadata and paginated tap streams", async () => {
  const app = await createMockIotApp();

  const meta = await app.inject({
    method: "GET",
    path: "/iot/v1/meta/contract"
  });
  assert.equal(meta.statusCode, 200);
  assert.equal(meta.body.contract_version, "2026-04-17.1");

  const taps = await app.inject({
    method: "GET",
    path: "/iot/v1/streams/taps?limit=2"
  });
  assert.equal(taps.statusCode, 200);
  assert.equal(taps.body.items.length, 2);
  assert.equal(taps.body.next_cursor, "tap-cursor-1011");
});

test("platform IoT adapter validates metadata and normalizes tap events", async () => {
  const app = await createMockIotApp();
  const adapter = createIotPlatformAdapter({
    baseUrl: "http://iot-mock.local",
    expectedContractVersion: "2026-04-17.1",
    expectedEnvironment: "staging",
    fetchImpl: createInjectFetch(app)
  });

  const contract = await adapter.getContractMetadata();
  assert.equal(contract.contract_version, "2026-04-17.1");

  const taps = await adapter.listTapEvents({ limit: 4 });
  assert.equal(taps.items.length, 4);
  assert.equal(taps.items[0].idempotency_key, "device-01:local-1001");
  assert.equal(taps.items[1].localTapEvent.tap_type, "phone_ndef");
  assert.equal(taps.items[1].queue_sequence_number, 201);
  assert.equal(taps.items[3].localTapEvent.local_event_id, "local-1010");
});

test("platform IoT adapter provisions and revokes credentials against the mock contract", async () => {
  const app = await createMockIotApp();
  const adapter = createIotPlatformAdapter({
    baseUrl: "http://iot-mock.local",
    expectedContractVersion: "2026-04-17.1",
    expectedEnvironment: "staging",
    fetchImpl: createInjectFetch(app)
  });

  const provisioned = await adapter.provisionDeviceCredential({
    tenant_id: "tenant-demo",
    device_id: "device-01",
    credential_label: "Phase 2 tablet",
    requested_by: "PLATFORM_INT_OWNER"
  });
  assert.equal(provisioned.device_id, "device-01");
  assert.ok(provisioned.bearer_token.startsWith("dvc_mock_"));

  const revoked = await adapter.revokeDeviceCredential(provisioned.credential_id);
  assert.equal(revoked.status, "revoked");
});

test("IoT contract certification runner validates schema and error catalog against the mock contract", async () => {
  const app = await createMockIotApp();
  const adapter = createIotPlatformAdapter({
    baseUrl: "http://iot-mock.local",
    expectedContractVersion: "2026-04-17.1",
    expectedEnvironment: "staging",
    fetchImpl: createInjectFetch(app)
  });

  const runner = createIotContractCertificationRunner({ adapter });
  const result = await runner.run();

  assert.equal(result.status, "passed");
  assert.equal(result.failed_checks, 0);
  assert.ok(result.checks.some((entry) => entry.name === "cursor_invalid_error"));
  assert.ok(result.checks.some((entry) => entry.name === "device_not_found_error"));
});

test("IoT tap sync service certifies contract, ingests taps, and persists checkpoint", async () => {
  const mockApp = await createMockIotApp();
  const platformApp = await createApp();
  const adapter = createIotPlatformAdapter({
    baseUrl: "http://iot-mock.local",
    expectedContractVersion: "2026-04-17.1",
    expectedEnvironment: "staging",
    fetchImpl: createInjectFetch(mockApp)
  });

  const service = createIotTapSyncService({
    adapter,
    repos: platformApp.repos,
    pageLimit: 2
  });

  const firstRun = await service.runOnce();
  assert.equal(firstRun.processed, 4);
  assert.equal(firstRun.created, 3);
  assert.equal(firstRun.duplicates, 1);
  assert.equal(firstRun.checkpoint_cursor, "tap-cursor-1012");
  assert.equal(platformApp.state.interactions.length, 3);

  const checkpoint = await platformApp.repos.iotSyncCheckpoints.findByIntegrationAndStream("iot_platform", "taps");
  assert.equal(checkpoint.last_cursor, "tap-cursor-1012");
  assert.equal(checkpoint.last_contract_version, "2026-04-17.1");
  const certification = await platformApp.repos.iotCertificationStatuses.findByIntegration("iot_platform");
  assert.equal(certification.status, "certified");
  assert.equal(certification.contract_version, "2026-04-17.1");

  const secondRun = await service.runOnce();
  assert.equal(secondRun.processed, 0);
  assert.equal(platformApp.state.interactions.length, 3);

  await platformApp.close();
});

test("IoT tap sync runner records retryable failures without advancing checkpoints", async () => {
  const mockApp = await createMockIotApp();
  const platformApp = await createApp();
  const baseAdapter = createIotPlatformAdapter({
    baseUrl: "http://iot-mock.local",
    expectedContractVersion: "2026-04-17.1",
    expectedEnvironment: "staging",
    fetchImpl: createInjectFetch(mockApp)
  });
  const adapter = {
    ...baseAdapter,
    async listTapEvents() {
      throw new HttpError(503, "IoT staging unavailable", {
        error: {
          code: "DOWNSTREAM_UNAVAILABLE",
          retryable: true,
          details: {}
        }
      });
    }
  };

  const service = createIotTapSyncService({
    adapter,
    repos: platformApp.repos
  });

  await assert.rejects(() => service.runOnce(), /unavailable/i);
  const checkpoint = await platformApp.repos.iotSyncCheckpoints.findByIntegrationAndStream("iot_platform", "taps");

  assert.equal(checkpoint.last_cursor, null);
  assert.equal(checkpoint.metadata.last_failure_code, "DOWNSTREAM_UNAVAILABLE");
  assert.equal(checkpoint.metadata.last_failure_retryable, true);
  assert.equal(checkpoint.metadata.failure_stage, "page_fetch");

  await platformApp.close();
});

test("IoT tap sync runner keeps checkpoint pinned to page start on partial-page ingest failure", async () => {
  const mockApp = await createMockIotApp();
  const platformApp = await createApp();
  const baseAdapter = createIotPlatformAdapter({
    baseUrl: "http://iot-mock.local",
    expectedContractVersion: "2026-04-17.1",
    expectedEnvironment: "staging",
    fetchImpl: createInjectFetch(mockApp)
  });

  let breakSecondItem = true;
  const adapter = {
    ...baseAdapter,
    async listTapEvents(options = {}) {
      const page = await baseAdapter.listTapEvents(options);
      if (breakSecondItem && !options.afterCursor && page.items.length > 1) {
        return {
          ...page,
          items: page.items.map((item, index) =>
            index === 1
              ? {
                  ...item,
                  assignment_checksum: "broken-checksum"
                }
              : item
          )
        };
      }
      return page;
    }
  };

  const service = createIotTapSyncService({
    adapter,
    repos: platformApp.repos,
    pageLimit: 2
  });

  await assert.rejects(() => service.runOnce(), /assignment checksum mismatch/i);
  const failedCheckpoint = await platformApp.repos.iotSyncCheckpoints.findByIntegrationAndStream("iot_platform", "taps");
  assert.equal(failedCheckpoint.last_cursor, null);
  assert.equal(failedCheckpoint.metadata.failure_stage, "item_ingest");
  assert.equal(failedCheckpoint.metadata.failed_cursor, "tap-cursor-1010");
  assert.equal(platformApp.state.interactions.length, 1);

  breakSecondItem = false;
  const recovery = await service.runOnce();
  assert.equal(recovery.created, 2);
  assert.equal(recovery.duplicates, 2);
  const recoveredCheckpoint = await platformApp.repos.iotSyncCheckpoints.findByIntegrationAndStream("iot_platform", "taps");
  assert.equal(recoveredCheckpoint.last_cursor, "tap-cursor-1012");

  await platformApp.close();
});

test("IoT heartbeat and incident sync services persist operational streams and expose organizer ops status", async () => {
  const mockApp = await createMockIotApp();
  const platformApp = await createApp();
  const adapter = createIotPlatformAdapter({
    baseUrl: "http://iot-mock.local",
    expectedContractVersion: "2026-04-17.1",
    expectedEnvironment: "staging",
    fetchImpl: createInjectFetch(mockApp)
  });

  const heartbeatService = createIotHeartbeatSyncService({
    adapter,
    repos: platformApp.repos,
    pageLimit: 1
  });
  const incidentService = createIotIncidentSyncService({
    adapter,
    repos: platformApp.repos,
    pageLimit: 1
  });

  const heartbeatRun = await heartbeatService.runOnce();
  const incidentRun = await incidentService.runOnce();

  assert.equal(heartbeatRun.created, 1);
  assert.equal(incidentRun.created, 1);

  const heartbeatCheckpoint = await platformApp.repos.iotSyncCheckpoints.findByIntegrationAndStream(
    "iot_platform",
    "heartbeats"
  );
  const incidentCheckpoint = await platformApp.repos.iotSyncCheckpoints.findByIntegrationAndStream(
    "iot_platform",
    "incidents"
  );
  assert.equal(heartbeatCheckpoint.last_cursor, "heartbeat-cursor-2001");
  assert.equal(incidentCheckpoint.last_cursor, "incident-cursor-3001");

  const organizerOverview = await platformApp.inject({
    method: "GET",
    path: "/organizer/events/event-demo/overview",
    headers: { authorization: "Bearer organizer-token" }
  });

  assert.equal(organizerOverview.statusCode, 200);
  assert.equal(organizerOverview.body.open_incidents, 1);
  assert.equal(organizerOverview.body.iot_integration.certification.status, "certified");
  assert.equal(organizerOverview.body.iot_integration.streams.heartbeats.status, "synced");
  assert.equal(organizerOverview.body.iot_integration.streams.incidents.status, "synced");

  await platformApp.close();
});

test("IoT device ops sync reconciles assignment and diagnostics for organizer fleet view", async () => {
  const mockApp = await createMockIotApp();
  const platformApp = await createApp();
  const adapter = createIotPlatformAdapter({
    baseUrl: "http://iot-mock.local",
    expectedContractVersion: "2026-04-17.1",
    expectedEnvironment: "staging",
    fetchImpl: createInjectFetch(mockApp)
  });

  const service = createIotDeviceOpsSyncService({
    adapter,
    repos: platformApp.repos
  });

  const summary = await service.runForEvent({
    tenantId: "tenant-demo",
    eventId: "event-demo"
  });
  assert.equal(summary.checked_devices, 1);
  assert.equal(summary.matched_devices, 1);

  const snapshot = await platformApp.repos.iotDeviceStatusSnapshots.findByDevice(
    "tenant-demo",
    "iot_platform",
    "device-01"
  );
  assert.equal(snapshot.assignment_status, "matched");
  assert.equal(snapshot.diagnostics_status, "degraded");
  assert.equal(snapshot.open_incident_code, "READER_DISCONNECTED");

  const fleet = await platformApp.inject({
    method: "GET",
    path: "/organizer/events/event-demo/device-fleet",
    headers: { authorization: "Bearer organizer-token" }
  });

  assert.equal(fleet.statusCode, 200);
  assert.equal(fleet.body.items.length, 1);
  assert.equal(fleet.body.items[0].assignment_status, "matched");
  assert.equal(fleet.body.items[0].diagnostics_status, "degraded");
  assert.equal(fleet.body.items[0].open_incident.code, "READER_DISCONNECTED");

  await platformApp.close();
});

test("IoT integration orchestrator persists run summaries and organizer run history", async () => {
  const mockApp = await createMockIotApp();
  const platformApp = await createApp();
  const adapter = createIotPlatformAdapter({
    baseUrl: "http://iot-mock.local",
    expectedContractVersion: "2026-04-17.1",
    expectedEnvironment: "staging",
    fetchImpl: createInjectFetch(mockApp)
  });

  const orchestrator = createIotIntegrationOrchestrator({
    adapter,
    repos: platformApp.repos
  });

  const run = await orchestrator.runForEvent({
    tenantId: "tenant-demo",
    eventId: "event-demo",
    triggerMode: "manual",
    initiatedBy: "tester"
  });

  assert.equal(run.status, "completed_with_warnings");
  assert.equal(run.step_count, 7);
  assert.equal(run.summary.contract_version, "2026-04-17.1");
  assert.ok(run.steps.some((entry) => entry.name === "contract_certification"));
  assert.ok(run.steps.some((entry) => entry.name === "health_refresh"));
  assert.ok(run.steps.some((entry) => entry.name === "parity_check"));

  const history = await platformApp.inject({
    method: "GET",
    path: "/organizer/events/event-demo/iot-runs",
    headers: { authorization: "Bearer organizer-token" }
  });

  assert.equal(history.statusCode, 200);
  assert.equal(history.body.items.length, 1);
  assert.equal(history.body.items[0].id, run.id);

  const health = await platformApp.inject({
    method: "GET",
    path: "/organizer/events/event-demo/iot-health",
    headers: { authorization: "Bearer organizer-token" }
  });
  assert.equal(health.statusCode, 200);
  assert.equal(health.body.iot_integration.latest_run.id, run.id);

  await platformApp.close();
});

test("organizer manual IoT run trigger executes orchestrator and surfaces parity in organizer ops", async () => {
  const stagingIotApp = await createMockIotApp();
  const productionIotApp = await createMockIotApp({
    environment: "production",
    buildVersion: "iot-mock-2026.04.17.1"
  });
  const platformApp = await createApp({
    iot: {
      baseUrl: "http://iot-staging.local",
      productionBaseUrl: "http://iot-production.local",
      fetchImpl: createDispatchFetch({
        "iot-staging.local": stagingIotApp,
        "iot-production.local": productionIotApp
      })
    }
  });

  const response = await platformApp.inject({
    method: "POST",
    path: "/organizer/events/event-demo/iot-runs/trigger",
    headers: { authorization: "Bearer organizer-token" }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.run.step_count, 7);
  assert.equal(response.body.iot_integration.parity.status, "passed");
  assert.equal(response.body.iot_integration.latest_run.id, response.body.run.id);

  await platformApp.close();
});

test("parity failures route alerts and expose them in organizer ops", async () => {
  const stagingIotApp = await createMockIotApp();
  const productionIotApp = await createMockIotApp({
    environment: "production",
    buildVersion: "iot-mock-2026.04.18.9"
  });
  const deliveredAlerts = [];
  const platformApp = await createApp({
    iot: {
      baseUrl: "http://iot-staging.local",
      productionBaseUrl: "http://iot-production.local",
      alertWebhookUrl: "http://alerts.local/webhook",
      fetchImpl: createDispatchFetch({
        "iot-staging.local": stagingIotApp,
        "iot-production.local": productionIotApp,
        "alerts.local": async (_url, init = {}) => {
          deliveredAlerts.push(JSON.parse(init.body));
          return {
            ok: true,
            status: 202,
            async json() {
              return { accepted: true };
            }
          };
        }
      })
    }
  });

  await platformApp.repos.iotCertificationStatuses.upsert({
    id: "cert-demo",
    integration_name: "iot_platform",
    status: "certified",
    contract_version: "2026-04-17.1",
    environment: "staging",
    build_version: "iot-mock-2026.04.17.1",
    last_checked_at: new Date().toISOString(),
    last_certified_at: new Date().toISOString(),
    last_failure_at: null,
    last_failure_message: null,
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });

  const parityTrigger = await platformApp.inject({
    method: "POST",
    path: "/organizer/events/event-demo/iot-parity/trigger",
    headers: { authorization: "Bearer organizer-token" }
  });

  assert.equal(parityTrigger.statusCode, 200);
  assert.equal(parityTrigger.body.parity.status, "failed");
  assert.ok(parityTrigger.body.parity.issues.some((entry) => entry.code === "BUILD_VERSION_MISMATCH"));

  const alerts = await platformApp.inject({
    method: "GET",
    path: "/organizer/events/event-demo/iot-alerts",
    headers: { authorization: "Bearer organizer-token" }
  });

  assert.equal(alerts.statusCode, 200);
  assert.equal(alerts.body.open_count, 1);
  assert.equal(alerts.body.items[0].code, "IOT_PARITY_FAILED");
  assert.equal(alerts.body.items[0].delivery_status, "delivered");
  assert.equal(deliveredAlerts.length, 1);
  assert.equal(deliveredAlerts[0].code, "IOT_PARITY_FAILED");

  await platformApp.close();
});

test("environment-aware alert routing fans parity failures out to parity, staging, production, and critical destinations", async () => {
  const repos = {
    iotAlertEvents: {
      store: [],
      async upsert(record) {
        const index = this.store.findIndex((entry) => entry.dedupe_key === record.dedupe_key);
        if (index === -1) {
          this.store.push(record);
          return record;
        }
        this.store[index] = { ...this.store[index], ...record };
        return this.store[index];
      },
      async resolveOpenByCodes() {
        return 0;
      }
    }
  };
  const delivered = [];
  const { createIotAlertRouter } = await import("../src/iot/alert-router.mjs");
  const router = createIotAlertRouter({
    repos,
    destinations: {
      staging: ["http://alerts.local/staging"],
      production: ["http://alerts.local/production"],
      parity: ["http://alerts.local/parity"],
      critical: ["http://alerts.local/critical"]
    },
    fetchImpl: async (url, init = {}) => {
      delivered.push({ url: String(url), body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 202,
        async json() {
          return { accepted: true };
        }
      };
    }
  });

  const result = await router.routeForEventState({
    tenantId: "tenant-demo",
    eventId: "event-demo",
    parity: {
      status: "failed",
      checked_at: "2026-04-18T12:00:00.000Z",
      staging_contract_version: "2026-04-17.1",
      production_contract_version: "2026-04-17.1",
      staging_build_version: "build-a",
      production_build_version: "build-b",
      issues: [{ code: "BUILD_VERSION_MISMATCH" }]
    }
  });

  assert.equal(result.triggered_count, 1);
  assert.deepEqual(
    result.items[0].routed_destinations.sort(),
    [
      "http://alerts.local/critical",
      "http://alerts.local/parity",
      "http://alerts.local/production",
      "http://alerts.local/staging"
    ].sort()
  );
  assert.equal(delivered.length, 4);
});

test("admin cleanup trigger deletes old IoT run history, alerts, snapshots, and parity statuses", async () => {
  const platformApp = await createApp();
  const oldIso = "2026-01-01T00:00:00.000Z";
  const nowIso = "2026-04-18T12:00:00.000Z";

  platformApp.state.iotIntegrationRuns.push({
    id: "old-run",
    integration_name: "iot_platform",
    tenant_id: "tenant-demo",
    event_id: "event-demo",
    trigger_mode: "manual",
    initiated_by: "tester",
    status: "failed",
    step_count: 1,
    failed_step_count: 1,
    warning_count: 0,
    started_at: oldIso,
    finished_at: oldIso,
    steps: [],
    summary: {},
    error_summary: "old",
    created_at: oldIso,
    updated_at: oldIso
  });
  platformApp.state.iotAlertEvents.push({
    id: "old-alert",
    integration_name: "iot_platform",
    tenant_id: "tenant-demo",
    event_id: "event-demo",
    source_type: "run",
    source_id: "old-run",
    dedupe_key: "old-run-failed",
    severity: "critical",
    status: "resolved",
    code: "IOT_RUN_FAILED",
    message: "old",
    details: {},
    delivery_status: "delivered",
    routed_destinations: [],
    last_delivery_at: oldIso,
    delivery_error: null,
    created_at: oldIso,
    updated_at: oldIso
  });
  platformApp.state.iotDeviceStatusSnapshots.push({
    id: "old-snapshot",
    integration_name: "iot_platform",
    tenant_id: "tenant-demo",
    event_id: "event-demo",
    device_id: "device-99",
    platform_event_id: "event-demo",
    platform_stall_id: "stall-a1",
    platform_assignment_checksum: "old",
    iot_event_id: "event-demo",
    iot_stall_id: "stall-a1",
    iot_assignment_checksum: "old",
    lease_expires_at: null,
    assignment_status: "matched",
    diagnostics_status: "healthy",
    connectivity_status: "online",
    reader_status: "connected",
    app_version: "1.0.0",
    firmware_version: "1.0.0",
    local_queue_depth: 0,
    last_heartbeat_at: oldIso,
    open_incident_code: null,
    open_incident_status: null,
    open_incident_severity: null,
    checked_at: oldIso,
    metadata: {}
  });
  platformApp.state.iotEnvironmentParityStatuses.push({
    id: "old-parity",
    integration_name: "iot_platform",
    tenant_id: "tenant-demo",
    event_id: "event-demo",
    status: "failed",
    staging_contract_version: "2026-04-17.1",
    staging_environment: "staging",
    staging_build_version: "build-a",
    production_contract_version: "2026-04-17.1",
    production_environment: "production",
    production_build_version: "build-b",
    checked_at: oldIso,
    issues: [],
    details: {},
    created_at: oldIso,
    updated_at: oldIso
  });

  const response = await platformApp.state.iotOperations.retentionManager.cleanupEventData({
    tenantId: "tenant-demo",
    eventId: "event-demo",
    now: nowIso
  });

  assert.deepEqual(response.deleted, {
    runs: 1,
    alerts: 1,
    device_snapshots: 1,
    parity_statuses: 1
  });

  const cleanupRoute = await platformApp.inject({
    method: "POST",
    path: "/admin/events/event-demo/iot-cleanup/trigger",
    headers: { authorization: "Bearer platform-token" }
  });
  assert.equal(cleanupRoute.statusCode, 200);

  await platformApp.close();
});

test("vendor cannot manually trigger organizer IoT operations", async () => {
  const platformApp = await createApp();

  const response = await platformApp.inject({
    method: "POST",
    path: "/organizer/events/event-demo/iot-runs/trigger",
    headers: { authorization: "Bearer vendor-token" }
  });

  assert.equal(response.statusCode, 403);

  await platformApp.close();
});

test("release manifest enforcement blocks parity when approved versions do not match", async () => {
  const stagingIotApp = await createMockIotApp();
  const productionIotApp = await createMockIotApp({
    environment: "production",
    buildVersion: "iot-mock-2026.04.17.1"
  });
  const platformApp = await createApp({
    iot: {
      baseUrl: "http://iot-staging.local",
      productionBaseUrl: "http://iot-production.local",
      requireReleaseManifest: true,
      releaseManifest: {
        release_id: "pilot-2026-04-18",
        approved: true,
        iot_platform: {
          staging: {
            contract_version: "2026-04-17.1",
            build_version: "wrong-build"
          },
          production: {
            contract_version: "2026-04-17.1",
            build_version: "iot-mock-2026.04.17.1"
          }
        }
      },
      fetchImpl: createDispatchFetch({
        "iot-staging.local": stagingIotApp,
        "iot-production.local": productionIotApp
      })
    }
  });

  await platformApp.repos.iotCertificationStatuses.upsert({
    id: "cert-demo",
    integration_name: "iot_platform",
    status: "certified",
    contract_version: "2026-04-17.1",
    environment: "staging",
    build_version: "iot-mock-2026.04.17.1",
    last_checked_at: new Date().toISOString(),
    last_certified_at: new Date().toISOString(),
    last_failure_at: null,
    last_failure_message: null,
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });

  const response = await platformApp.inject({
    method: "POST",
    path: "/organizer/events/event-demo/iot-parity/trigger",
    headers: { authorization: "Bearer organizer-token" }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.parity.status, "failed");
  assert.ok(
    response.body.parity.issues.some((entry) => entry.code === "STAGING_MANIFEST_BUILD_MISMATCH")
  );

  await platformApp.close();
});

test("go-live readiness endpoint reports blockers from health, parity, alerts, and latest run", async () => {
  const stagingIotApp = await createMockIotApp();
  const productionIotApp = await createMockIotApp({
    environment: "production",
    buildVersion: "iot-mock-2026.04.18.9"
  });
  const platformApp = await createApp({
    iot: {
      baseUrl: "http://iot-staging.local",
      productionBaseUrl: "http://iot-production.local",
      requireReleaseManifest: true,
      releaseManifest: {
        release_id: "pilot-2026-04-18",
        approved: false,
        iot_platform: {
          staging: {
            contract_version: "2026-04-17.1",
            build_version: "iot-mock-2026.04.17.1"
          },
          production: {
            contract_version: "2026-04-17.1",
            build_version: "iot-mock-2026.04.17.1"
          }
        }
      },
      fetchImpl: createDispatchFetch({
        "iot-staging.local": stagingIotApp,
        "iot-production.local": productionIotApp
      })
    }
  });

  const orchestratorResponse = await platformApp.inject({
    method: "POST",
    path: "/organizer/events/event-demo/iot-runs/trigger",
    headers: { authorization: "Bearer organizer-token" }
  });
  assert.equal(orchestratorResponse.statusCode, 200);

  const readiness = await platformApp.inject({
    method: "GET",
    path: "/organizer/events/event-demo/iot-go-live-readiness",
    headers: { authorization: "Bearer organizer-token" }
  });

  assert.equal(readiness.statusCode, 200);
  assert.equal(readiness.body.readiness.ready, false);
  assert.ok(
    readiness.body.readiness.blockers.some((entry) =>
      entry.includes("approved release manifest")
    )
  );
  assert.ok(readiness.body.readiness.runbook_links.pilot_go_live_runbook);

  await platformApp.close();
});

test("IoT health runner persists warnings for stream drift and device degradation", async () => {
  const mockApp = await createMockIotApp();
  const platformApp = await createApp();
  const adapter = createIotPlatformAdapter({
    baseUrl: "http://iot-mock.local",
    expectedContractVersion: "2026-04-17.1",
    expectedEnvironment: "staging",
    fetchImpl: createInjectFetch(mockApp)
  });

  const tapService = createIotTapSyncService({ adapter, repos: platformApp.repos, pageLimit: 2 });
  const heartbeatService = createIotHeartbeatSyncService({ adapter, repos: platformApp.repos, pageLimit: 1 });
  const incidentService = createIotIncidentSyncService({ adapter, repos: platformApp.repos, pageLimit: 1 });
  await tapService.runOnce();
  await heartbeatService.runOnce();
  await incidentService.runOnce();

  const tapCheckpoint = await platformApp.repos.iotSyncCheckpoints.findByIntegrationAndStream("iot_platform", "taps");
  await platformApp.repos.iotSyncCheckpoints.upsert({
    ...tapCheckpoint,
    last_contract_version: "2026-01-01.1"
  });

  const runner = createIotCertificationHealthRunner({
    adapter,
    repos: platformApp.repos,
    thresholds: {
      certificationStaleAfterSeconds: 900,
      streamStaleAfterSeconds: {
        taps: 900,
        heartbeats: 300,
        incidents: 900
      }
    }
  });

  const health = await runner.runForEvent({
    tenantId: "tenant-demo",
    eventId: "event-demo"
  });

  assert.equal(health.overall_status, "warning");
  assert.equal(health.certification_status, "certified");
  assert.ok(health.warnings.some((entry) => entry.code === "TAPS_CONTRACT_DRIFT"));
  assert.ok(health.warnings.some((entry) => entry.code === "DEVICE_DIAGNOSTICS_DEGRADED"));
  assert.ok(health.warnings.some((entry) => entry.code === "OPEN_INCIDENTS_PRESENT"));

  const overview = await platformApp.inject({
    method: "GET",
    path: "/organizer/events/event-demo/iot-health",
    headers: { authorization: "Bearer organizer-token" }
  });

  assert.equal(overview.statusCode, 200);
  assert.equal(overview.body.iot_integration.health.status, "warning");
  assert.ok(overview.body.iot_integration.health.warnings.some((entry) => entry.code === "TAPS_CONTRACT_DRIFT"));

  await platformApp.close();
});

test("IoT health runner escalates repeated stream failures in organizer ops", async () => {
  const mockApp = await createMockIotApp();
  const platformApp = await createApp();
  const baseAdapter = createIotPlatformAdapter({
    baseUrl: "http://iot-mock.local",
    expectedContractVersion: "2026-04-17.1",
    expectedEnvironment: "staging",
    fetchImpl: createInjectFetch(mockApp)
  });
  const failingAdapter = {
    ...baseAdapter,
    async listTapEvents() {
      throw new HttpError(503, "IoT staging unavailable", {
        error: {
          code: "DOWNSTREAM_UNAVAILABLE",
          retryable: true,
          details: {}
        }
      });
    }
  };

  const failingTapService = createIotTapSyncService({
    adapter: failingAdapter,
    repos: platformApp.repos
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(() => failingTapService.runOnce(), /unavailable/i);
  }

  const heartbeatService = createIotHeartbeatSyncService({ adapter: baseAdapter, repos: platformApp.repos, pageLimit: 1 });
  const incidentService = createIotIncidentSyncService({ adapter: baseAdapter, repos: platformApp.repos, pageLimit: 1 });
  await heartbeatService.runOnce();
  await incidentService.runOnce();

  const runner = createIotCertificationHealthRunner({
    adapter: baseAdapter,
    repos: platformApp.repos,
    thresholds: {
      repeatedFailureThreshold: 3,
      repeatedMismatchThreshold: 3,
      certificationStaleAfterSeconds: 900,
      streamStaleAfterSeconds: { taps: 900, heartbeats: 300, incidents: 900 }
    }
  });
  const health = await runner.runForEvent({
    tenantId: "tenant-demo",
    eventId: "event-demo"
  });

  assert.ok(health.warnings.some((entry) => entry.code === "TAPS_REPEATED_FAILURES"));
  assert.equal(health.overall_status, "critical");

  const response = await platformApp.inject({
    method: "GET",
    path: "/organizer/events/event-demo/iot-health",
    headers: { authorization: "Bearer organizer-token" }
  });
  assert.equal(response.statusCode, 200);
  assert.ok(response.body.iot_integration.health.warnings.some((entry) => entry.code === "TAPS_REPEATED_FAILURES"));

  await platformApp.close();
});

test("organizer IoT health view marks stale health checks explicitly", async () => {
  const platformApp = await createApp();
  await platformApp.repos.iotIntegrationHealthStatuses.upsert({
    id: "health-stale-1",
    integration_name: "iot_platform",
    tenant_id: "tenant-demo",
    event_id: "event-demo",
    overall_status: "healthy",
    certification_status: "certified",
    contract_version: "2026-04-17.1",
    environment: "staging",
    build_version: "iot-2026.04.17.3",
    stale_after_seconds: 60,
    warning_count: 0,
    checked_at: "2026-04-18T00:00:00.000Z",
    warnings: [],
    metrics: {},
    created_at: "2026-04-18T00:00:00.000Z",
    updated_at: "2026-04-18T00:00:00.000Z"
  });

  const response = await platformApp.inject({
    method: "GET",
    path: "/organizer/events/event-demo/iot-health",
    headers: { authorization: "Bearer organizer-token" }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.iot_integration.health.is_stale, true);
  assert.equal(response.body.iot_integration.health.status, "warning");
  assert.ok(response.body.iot_integration.health.warnings.some((entry) => entry.code === "HEALTH_CHECK_STALE"));

  await platformApp.close();
});

test("IoT tap sync service stops before ingestion when contract certification fails", async () => {
  const mockApp = await createMockIotApp();
  const platformApp = await createApp();
  const adapter = createIotPlatformAdapter({
    baseUrl: "http://iot-mock.local",
    expectedContractVersion: "2099-01-01.1",
    expectedEnvironment: "staging",
    fetchImpl: createInjectFetch(mockApp)
  });

  const service = createIotTapSyncService({
    adapter,
    repos: platformApp.repos
  });

  await assert.rejects(() => service.runOnce(), /contract version mismatch/i);
  assert.equal(platformApp.state.interactions.length, 0);
  const certification = await platformApp.repos.iotCertificationStatuses.findByIntegration("iot_platform");
  assert.equal(certification.status, "failed");
  assert.match(certification.last_failure_message, /contract version mismatch/i);

  await platformApp.close();
});
