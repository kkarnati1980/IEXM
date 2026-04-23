import { createApp } from "../app.mjs";
import { processNotificationQueueBatch } from "../notification-worker.mjs";

const tenantId = process.env.NOTIFICATION_QUEUE_TENANT_ID;
const eventId = process.env.NOTIFICATION_QUEUE_EVENT_ID;

if (!tenantId) {
  throw new Error("NOTIFICATION_QUEUE_TENANT_ID is required");
}

const app = await createApp();

try {
  const result = await processNotificationQueueBatch({
    repos: app.repos,
    tenantId,
    eventId: eventId ?? null,
    env: process.env,
    limit: Number(process.env.NOTIFICATION_QUEUE_LIMIT ?? 20),
    initiatedBy: process.env.NOTIFICATION_QUEUE_INITIATED_BY ?? "notification-queue-script"
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await app.close();
}
