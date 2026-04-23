import { createApp } from "../app.mjs";

const tenantId = process.env.IOT_SYNC_TENANT_ID;
const eventId = process.env.IOT_SYNC_EVENT_ID;

if (!tenantId || !eventId) {
  throw new Error("IOT_SYNC_TENANT_ID and IOT_SYNC_EVENT_ID are required");
}

const app = await createApp();

try {
  const retentionManager = app.state.iotOperations?.retentionManager;
  if (!retentionManager) {
    throw new Error("IoT retention manager is not configured");
  }

  const result = await retentionManager.cleanupEventData({ tenantId, eventId });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await app.close();
}
