import { createIotPlatformAdapter } from "./platform-adapter.mjs";
import { createIotAlertRouter } from "./alert-router.mjs";
import { createIotEnvironmentParityRunner } from "./environment-parity-runner.mjs";
import { createIotIntegrationOrchestrator } from "./integration-orchestrator.mjs";
import { createIotRetentionManager } from "./retention-manager.mjs";
import { loadReleaseManifest, selectIntegrationManifest } from "./release-manifest.mjs";

export function createIotOperationsRuntime(options = {}) {
  const repos = options.repos;
  if (!repos) {
    throw new Error("IoT operations runtime requires repositories");
  }
  const releaseManifest = loadReleaseManifest(options);
  const integrationManifest = selectIntegrationManifest(
    releaseManifest,
    options.integrationName ?? "iot_platform"
  );

  const stagingAdapter =
    options.stagingAdapter ??
    createAdapter({
      baseUrl: options.baseUrl ?? process.env.IOT_BASE_URL,
      authToken: options.authToken ?? process.env.IOT_AUTH_TOKEN ?? null,
      expectedContractVersion:
        options.expectedContractVersion ?? process.env.IOT_EXPECTED_CONTRACT_VERSION ?? "2026-04-17.1",
      expectedEnvironment:
        options.expectedEnvironment ?? process.env.IOT_EXPECTED_ENVIRONMENT ?? "staging",
      fetchImpl: options.fetchImpl
    });

  const productionAdapter =
    options.productionAdapter ??
    createAdapter({
      baseUrl: options.productionBaseUrl ?? process.env.IOT_PRODUCTION_BASE_URL,
      authToken: options.productionAuthToken ?? process.env.IOT_PRODUCTION_AUTH_TOKEN ?? null,
      expectedContractVersion:
        options.productionExpectedContractVersion ??
        process.env.IOT_PRODUCTION_EXPECTED_CONTRACT_VERSION ??
        process.env.IOT_EXPECTED_CONTRACT_VERSION ??
        "2026-04-17.1",
      expectedEnvironment:
        options.productionExpectedEnvironment ??
        process.env.IOT_PRODUCTION_EXPECTED_ENVIRONMENT ??
        "production",
      fetchImpl: options.fetchImpl
    });

  const thresholds = {
    certificationStaleAfterSeconds: Number(
      options.certificationStaleAfterSeconds ?? process.env.IOT_CERT_STALE_AFTER_SECONDS ?? 900
    ),
    streamStaleAfterSeconds: {
      taps: Number(options.tapStreamStaleAfterSeconds ?? process.env.IOT_STREAM_STALE_TAPS_SECONDS ?? 900),
      heartbeats: Number(
        options.heartbeatStreamStaleAfterSeconds ?? process.env.IOT_STREAM_STALE_HEARTBEATS_SECONDS ?? 300
      ),
      incidents: Number(
        options.incidentStreamStaleAfterSeconds ?? process.env.IOT_STREAM_STALE_INCIDENTS_SECONDS ?? 900
      )
    },
    repeatedFailureThreshold: Number(
      options.repeatedFailureThreshold ?? process.env.IOT_REPEATED_FAILURE_THRESHOLD ?? 3
    ),
    repeatedMismatchThreshold: Number(
      options.repeatedMismatchThreshold ?? process.env.IOT_REPEATED_MISMATCH_THRESHOLD ?? 3
    )
  };

  const alertRouter = createIotAlertRouter({
    repos,
    webhookUrl: options.alertWebhookUrl ?? process.env.IOT_ALERT_WEBHOOK_URL ?? null,
    destinations: {
      default: options.alertWebhookUrls ?? process.env.IOT_ALERT_WEBHOOK_URLS ?? null,
      staging: options.alertWebhookUrlStaging ?? process.env.IOT_ALERT_WEBHOOK_URL_STAGING ?? null,
      production:
        options.alertWebhookUrlProduction ?? process.env.IOT_ALERT_WEBHOOK_URL_PRODUCTION ?? null,
      parity: options.alertWebhookUrlParity ?? process.env.IOT_ALERT_WEBHOOK_URL_PARITY ?? null,
      critical:
        options.alertWebhookUrlCritical ?? process.env.IOT_ALERT_WEBHOOK_URL_CRITICAL ?? null
    },
    minSeverity: options.alertMinSeverity ?? process.env.IOT_ALERT_MIN_SEVERITY ?? "warning",
    fetchImpl: options.fetchImpl,
    defaultEnvironment: options.expectedEnvironment ?? process.env.IOT_EXPECTED_ENVIRONMENT ?? "staging"
  });

  const parityRunner =
    stagingAdapter && productionAdapter
      ? createIotEnvironmentParityRunner({
          repos,
          stagingAdapter,
          productionAdapter,
          releaseManifest: integrationManifest,
          requireReleaseManifest:
            options.requireReleaseManifest ?? process.env.IOT_REQUIRE_RELEASE_MANIFEST === "true"
        })
      : null;

  const orchestrator =
    stagingAdapter
      ? createIotIntegrationOrchestrator({
          adapter: stagingAdapter,
          repos,
          thresholds,
          alertRouter,
          parityRunner
        })
      : null;

  const retentionManager = createIotRetentionManager({
    repos,
    runRetentionDays: options.runRetentionDays ?? process.env.IOT_RUN_RETENTION_DAYS ?? 30,
    alertRetentionDays: options.alertRetentionDays ?? process.env.IOT_ALERT_RETENTION_DAYS ?? 30,
    snapshotRetentionDays: options.snapshotRetentionDays ?? process.env.IOT_SNAPSHOT_RETENTION_DAYS ?? 14,
    parityRetentionDays: options.parityRetentionDays ?? process.env.IOT_PARITY_RETENTION_DAYS ?? 30
  });

  return {
    stagingAdapter,
    productionAdapter,
    alertRouter,
    parityRunner,
    orchestrator,
    retentionManager,
    releaseManifest: integrationManifest
  };
}

function createAdapter({ baseUrl, authToken, expectedContractVersion, expectedEnvironment, fetchImpl }) {
  if (!baseUrl) {
    return null;
  }

  return createIotPlatformAdapter({
    baseUrl,
    authToken,
    expectedContractVersion,
    expectedEnvironment,
    fetchImpl
  });
}
