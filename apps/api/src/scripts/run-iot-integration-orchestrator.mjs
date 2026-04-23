import { createApp } from "../app.mjs";
import { createIotPlatformAdapter } from "../iot/platform-adapter.mjs";
import { createIotIntegrationOrchestrator } from "../iot/integration-orchestrator.mjs";

const tenantId = process.env.IOT_SYNC_TENANT_ID;
const eventId = process.env.IOT_SYNC_EVENT_ID;

if (!tenantId || !eventId) {
  throw new Error("IOT_SYNC_TENANT_ID and IOT_SYNC_EVENT_ID are required");
}

const app = await createApp();

try {
  const adapter = createIotPlatformAdapter({
    baseUrl: process.env.IOT_BASE_URL,
    authToken: process.env.IOT_AUTH_TOKEN ?? null,
    expectedContractVersion: process.env.IOT_EXPECTED_CONTRACT_VERSION ?? "2026-04-17.1",
    expectedEnvironment: process.env.IOT_EXPECTED_ENVIRONMENT ?? "staging"
  });

  const orchestrator = createIotIntegrationOrchestrator({
    adapter,
    repos: app.repos,
    thresholds: {
      certificationStaleAfterSeconds: Number(process.env.IOT_CERT_STALE_AFTER_SECONDS ?? 900),
      streamStaleAfterSeconds: {
        taps: Number(process.env.IOT_STREAM_STALE_TAPS_SECONDS ?? 900),
        heartbeats: Number(process.env.IOT_STREAM_STALE_HEARTBEATS_SECONDS ?? 300),
        incidents: Number(process.env.IOT_STREAM_STALE_INCIDENTS_SECONDS ?? 900)
      },
      repeatedFailureThreshold: Number(process.env.IOT_REPEATED_FAILURE_THRESHOLD ?? 3),
      repeatedMismatchThreshold: Number(process.env.IOT_REPEATED_MISMATCH_THRESHOLD ?? 3)
    }
  });

  const run = await orchestrator.runForEvent({
    tenantId,
    eventId,
    triggerMode: process.env.IOT_TRIGGER_MODE ?? "manual",
    initiatedBy: process.env.IOT_INITIATED_BY ?? "script"
  });
  console.log(JSON.stringify(run, null, 2));
} finally {
  await app.close();
}
