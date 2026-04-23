import { nextId } from "../store.mjs";
import { HttpError } from "../http-error.mjs";
import { certifyIotContract, runPagedIotSync } from "./sync-support.mjs";

export function createIotIncidentSyncService(options = {}) {
  const adapter = options.adapter;
  const repos = options.repos;
  if (!adapter || !repos) {
    throw new Error("IoT incident sync service requires adapter and repos");
  }

  const integrationName = options.integrationName ?? "iot_platform";
  const streamName = options.streamName ?? "incidents";
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
        listPage: ({ afterCursor, limit }) => adapter.listIncidentEvents({ afterCursor, limit }),
        ingestItem: (item) => ingestNormalizedIncidentItem(repos, item)
      });
    }
  };
}

export async function ingestNormalizedIncidentItem(repos, normalizedIncident) {
  const tenantRepos = repos.scope?.({
    tenantId: normalizedIncident.tenant_id,
    actorId: "iot_incident_sync",
    actorRole: "system"
  }) ?? repos;

  const existing = await tenantRepos.incidents.findBySourceCursor(normalizedIncident.cursor);
  if (existing) {
    return { mode: "duplicate", record: existing };
  }

  const device = await tenantRepos.devices.findById(normalizedIncident.tenant_id, normalizedIncident.device_id);
  const assignment = await tenantRepos.deviceAssignments.findActiveByDeviceId(normalizedIncident.tenant_id, device.id);

  if (normalizedIncident.assignment_checksum !== assignment.assignment_checksum) {
    throw new HttpError(409, "IoT incident assignment checksum mismatch", {
      expected_assignment_checksum: assignment.assignment_checksum,
      received_assignment_checksum: normalizedIncident.assignment_checksum,
      device_id: normalizedIncident.device_id,
      cursor: normalizedIncident.cursor
    });
  }
  if (assignment.event_id !== normalizedIncident.event_id || assignment.stall_id !== normalizedIncident.stall_id) {
    throw new HttpError(403, "IoT incident event/stall must match active assignment", {
      device_id: normalizedIncident.device_id,
      expected_event_id: assignment.event_id,
      expected_stall_id: assignment.stall_id,
      received_event_id: normalizedIncident.event_id,
      received_stall_id: normalizedIncident.stall_id
    });
  }

  await tenantRepos.events.findById(normalizedIncident.tenant_id, normalizedIncident.event_id);
  await tenantRepos.stalls.findById(normalizedIncident.tenant_id, normalizedIncident.stall_id);

  const record = await tenantRepos.incidents.create({
    id: nextId("incident"),
    tenant_id: normalizedIncident.tenant_id,
    device_id: normalizedIncident.device_id,
    event_id: normalizedIncident.event_id,
    stall_id: normalizedIncident.stall_id,
    severity: normalizedIncident.severity,
    code: normalizedIncident.code,
    message: normalizedIncident.message,
    status: normalizedIncident.status,
    assignment_checksum: normalizedIncident.assignment_checksum,
    metadata: normalizedIncident.metadata,
    occurred_at: normalizedIncident.occurred_at,
    resolved_at: normalizedIncident.resolved_at,
    source_cursor: normalizedIncident.cursor,
    raw_payload: normalizedIncident.raw,
    created_at: normalizedIncident.occurred_at ?? new Date().toISOString()
  });

  return { mode: "created", record };
}
