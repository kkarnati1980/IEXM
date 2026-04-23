export function createIotRetentionManager(options = {}) {
  const repos = options.repos;
  if (!repos) {
    throw new Error("IoT retention manager requires repositories");
  }

  const policies = {
    runRetentionDays: Number(options.runRetentionDays ?? 30),
    alertRetentionDays: Number(options.alertRetentionDays ?? 30),
    snapshotRetentionDays: Number(options.snapshotRetentionDays ?? 14),
    parityRetentionDays: Number(options.parityRetentionDays ?? 30)
  };

  return {
    async cleanupEventData({ tenantId, eventId, now = new Date().toISOString() }) {
      const tenantRepos = repos.scope?.({
        tenantId,
        actorId: "iot_retention_manager",
        actorRole: "system"
      }) ?? repos;
      await tenantRepos.events.findById(tenantId, eventId);

      const deletedRuns = await tenantRepos.iotIntegrationRuns.deleteOlderThanByEvent(
        tenantId,
        eventId,
        daysAgo(now, policies.runRetentionDays)
      );
      const deletedAlerts = await tenantRepos.iotAlertEvents.deleteOlderThanByEvent(
        tenantId,
        eventId,
        daysAgo(now, policies.alertRetentionDays)
      );
      const deletedSnapshots = await tenantRepos.iotDeviceStatusSnapshots.deleteOlderThanByEvent(
        tenantId,
        eventId,
        daysAgo(now, policies.snapshotRetentionDays)
      );
      const deletedParityStatuses = await tenantRepos.iotEnvironmentParityStatuses.deleteOlderThanByEvent(
        tenantId,
        eventId,
        daysAgo(now, policies.parityRetentionDays)
      );

      return {
        event_id: eventId,
        cleaned_at: now,
        policies,
        deleted: {
          runs: deletedRuns,
          alerts: deletedAlerts,
          device_snapshots: deletedSnapshots,
          parity_statuses: deletedParityStatuses
        }
      };
    }
  };
}

function daysAgo(nowIso, days) {
  return new Date(Date.parse(nowIso) - days * 24 * 60 * 60 * 1000).toISOString();
}
