import { nextId } from "../store.mjs";
import { HttpError } from "../http-error.mjs";
import { certifyIotContract, runPagedIotSync } from "./sync-support.mjs";

export function createIotHeartbeatSyncService(options = {}) {
  const adapter = options.adapter;
  const repos = options.repos;
  if (!adapter || !repos) {
    throw new Error("IoT heartbeat sync service requires adapter and repos");
  }

  const integrationName = options.integrationName ?? "iot_platform";
  const streamName = options.streamName ?? "heartbeats";
  const pageLimit = options.pageLimit ?? 100;
  const certificationPack = options.certificationPack ?? null;

  return {
    async certifyContract() {
      return certifyIotContract({ adapter, repos, integrationName, certificationPack });
    },

    async runOnce(options = {}) {
      const contract =
        options.skipCertification && options.contract
          ? options.contract
          : await this.certifyContract();
      return runPagedIotSync({
        repos,
        integrationName,
        streamName,
        pageLimit,
        contract,
        listPage: ({ afterCursor, limit }) => adapter.listHeartbeatEvents({ afterCursor, limit }),
        ingestItem: (item) => ingestNormalizedHeartbeatItem(repos, item)
      });
    }
  };
}

export async function ingestNormalizedHeartbeatItem(repos, normalizedHeartbeat) {
  const tenantRepos = repos.scope?.({
    tenantId: normalizedHeartbeat.tenant_id,
    actorId: "iot_heartbeat_sync",
    actorRole: "system"
  }) ?? repos;

  const existing = await tenantRepos.heartbeats.findBySourceCursor(normalizedHeartbeat.cursor);
  if (existing) {
    return { mode: "duplicate", record: existing };
  }

  const device = await tenantRepos.devices.findById(normalizedHeartbeat.tenant_id, normalizedHeartbeat.device_id);
  const assignment = await tenantRepos.deviceAssignments.findActiveByDeviceId(normalizedHeartbeat.tenant_id, device.id);

  if (normalizedHeartbeat.assignment_checksum !== assignment.assignment_checksum) {
    throw new HttpError(409, "IoT heartbeat assignment checksum mismatch", {
      expected_assignment_checksum: assignment.assignment_checksum,
      received_assignment_checksum: normalizedHeartbeat.assignment_checksum,
      device_id: normalizedHeartbeat.device_id,
      cursor: normalizedHeartbeat.cursor
    });
  }
  if (assignment.event_id !== normalizedHeartbeat.event_id || assignment.stall_id !== normalizedHeartbeat.stall_id) {
    throw new HttpError(403, "IoT heartbeat event/stall must match active assignment", {
      device_id: normalizedHeartbeat.device_id,
      expected_event_id: assignment.event_id,
      expected_stall_id: assignment.stall_id,
      received_event_id: normalizedHeartbeat.event_id,
      received_stall_id: normalizedHeartbeat.stall_id
    });
  }

  await tenantRepos.events.findById(normalizedHeartbeat.tenant_id, normalizedHeartbeat.event_id);
  await tenantRepos.stalls.findById(normalizedHeartbeat.tenant_id, normalizedHeartbeat.stall_id);

  const record = await tenantRepos.heartbeats.create({
    id: nextId("heartbeat"),
    tenant_id: normalizedHeartbeat.tenant_id,
    device_id: normalizedHeartbeat.device_id,
    event_id: normalizedHeartbeat.event_id,
    stall_id: normalizedHeartbeat.stall_id,
    battery_level: normalizedHeartbeat.battery_level,
    local_queue_depth: normalizedHeartbeat.local_queue_depth,
    assignment_checksum: normalizedHeartbeat.assignment_checksum,
    connectivity_status: normalizedHeartbeat.connectivity_status,
    reader_status: normalizedHeartbeat.reader_status,
    app_version: normalizedHeartbeat.app_version,
    firmware_version: normalizedHeartbeat.firmware_version,
    source_cursor: normalizedHeartbeat.cursor,
    raw_payload: normalizedHeartbeat.raw,
    recorded_at: normalizedHeartbeat.recorded_at
  });

  return { mode: "created", record };
}
