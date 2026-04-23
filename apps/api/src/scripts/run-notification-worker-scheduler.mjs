import { createApp } from "../app.mjs";
import { processNotificationQueueBatch } from "../notification-worker.mjs";
import { resolveNotificationWorkerSchedule } from "../notification-providers.mjs";

const schedule = resolveNotificationWorkerSchedule(process.env);

if (!schedule.enabled) {
  throw new Error("NOTIFICATION_WORKER_ENABLED=true is required to run the notification worker scheduler");
}
if (schedule.status !== "ready") {
  throw new Error("Notification worker scheduler is misconfigured; check tenant scope, interval, and batch settings");
}

const app = await createApp();
let shuttingDown = false;

process.on("SIGINT", () => {
  shuttingDown = true;
});
process.on("SIGTERM", () => {
  shuttingDown = true;
});

try {
  while (!shuttingDown) {
    const startedAt = new Date();
    const result = await processNotificationQueueBatch({
      repos: app.repos,
      tenantId: schedule.tenant_id,
      eventId: schedule.event_id,
      env: process.env,
      limit: schedule.batch_limit,
      initiatedBy: process.env.NOTIFICATION_WORKER_INITIATED_BY ?? "notification-worker-scheduler"
    });
    console.log(JSON.stringify({
      loop_started_at: startedAt.toISOString(),
      loop_finished_at: new Date().toISOString(),
      scheduler: schedule,
      processed_count: result.processed_count,
      skipped_count: result.skipped_count,
      sent_count: result.sent_count,
      temporary_failure_count: result.temporary_failure_count,
      failed_count: result.failed_count,
      dead_letter_count: result.dead_letter_count,
      cancelled_count: result.cancelled_count
    }));

    if (shuttingDown) {
      break;
    }
    await sleep(schedule.interval_seconds * 1000);
  }
} finally {
  await app.close();
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const cleanup = () => {
      clearTimeout(timeoutId);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    };
    const onSignal = () => {
      cleanup();
      resolve();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}
