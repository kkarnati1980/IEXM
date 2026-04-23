import { createApp } from "../app.mjs";
import { createIotPlatformAdapter } from "../iot/platform-adapter.mjs";
import { createIotTapSyncService } from "../iot/tap-sync-service.mjs";

const app = await createApp();

try {
  const adapter = createIotPlatformAdapter({
    baseUrl: process.env.IOT_BASE_URL,
    authToken: process.env.IOT_AUTH_TOKEN ?? null,
    expectedContractVersion: process.env.IOT_EXPECTED_CONTRACT_VERSION ?? "2026-04-17.1",
    expectedEnvironment: process.env.IOT_EXPECTED_ENVIRONMENT ?? "staging"
  });

  const service = createIotTapSyncService({
    adapter,
    repos: app.repos,
    pageLimit: Number(process.env.IOT_TAP_PAGE_LIMIT ?? 100)
  });

  const summary = await service.runOnce();
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await app.close();
}

