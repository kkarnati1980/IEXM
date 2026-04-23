import { HttpError } from "../http-error.mjs";
import { ingestTapEvent } from "../interactions/ingest-tap.mjs";
import { certifyIotContract, runPagedIotSync } from "./sync-support.mjs";

export function createIotTapSyncService(options = {}) {
  const adapter = options.adapter;
  const repos = options.repos;
  if (!adapter || !repos) {
    throw new Error("IoT tap sync service requires adapter and repos");
  }

  const integrationName = options.integrationName ?? "iot_platform";
  const streamName = options.streamName ?? "taps";
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
        listPage: ({ afterCursor, limit }) => adapter.listTapEvents({ afterCursor, limit }),
        ingestItem: (item) => ingestNormalizedTapItem(repos, item)
      });
    }
  };
}

export async function ingestNormalizedTapItem(repos, normalizedTap) {
  const tenantRepos = repos.scope?.({
    tenantId: normalizedTap.tenant_id,
    actorId: "iot_tap_sync",
    actorRole: "system"
  }) ?? repos;

  const device = await tenantRepos.devices.findById(normalizedTap.tenant_id, normalizedTap.localTapEvent.device_id);
  const assignment = await tenantRepos.deviceAssignments.findActiveByDeviceId(normalizedTap.tenant_id, device.id);
  const event = await tenantRepos.events.findById(normalizedTap.tenant_id, normalizedTap.localTapEvent.event_id);
  const stall = await tenantRepos.stalls.findById(normalizedTap.tenant_id, normalizedTap.localTapEvent.stall_id);

  if (normalizedTap.assignment_checksum !== assignment.assignment_checksum) {
    throw new HttpError(409, "IoT tap assignment checksum mismatch", {
      expected_assignment_checksum: assignment.assignment_checksum,
      received_assignment_checksum: normalizedTap.assignment_checksum,
      device_id: normalizedTap.localTapEvent.device_id,
      cursor: normalizedTap.cursor
    });
  }

  return ingestTapEvent({
    repos: tenantRepos,
    body: {
      ...normalizedTap.localTapEvent,
      assignment_checksum: normalizedTap.assignment_checksum
    },
    resources: {
      device,
      assignment,
      event,
      stall
    },
    cloudReceivedAt: normalizedTap.cloud_received_at
  });
}
