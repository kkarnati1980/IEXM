import { createApp } from "../app.mjs";

const tenantId = process.env.IOT_SYNC_TENANT_ID;
const eventId = process.env.IOT_SYNC_EVENT_ID;

if (!tenantId || !eventId) {
  throw new Error("IOT_SYNC_TENANT_ID and IOT_SYNC_EVENT_ID are required");
}

const app = await createApp();

try {
  const parityRunner = app.state.iotOperations?.parityRunner;
  if (!parityRunner) {
    throw new Error("IoT environment parity runner is not configured");
  }

  const result = await parityRunner.runForEvent({ tenantId, eventId });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await app.close();
}
