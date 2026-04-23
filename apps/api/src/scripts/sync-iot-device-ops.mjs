import { createApp } from "../app.mjs";
import { createIotPlatformAdapter } from "../iot/platform-adapter.mjs";
import { createIotDeviceOpsSyncService } from "../iot/device-ops-sync-service.mjs";

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

  const service = createIotDeviceOpsSyncService({
    adapter,
    repos: app.repos
  });

  const summary = await service.runForEvent({ tenantId, eventId });
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await app.close();
}
