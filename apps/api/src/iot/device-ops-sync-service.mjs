import { nextId } from "../store.mjs";
import { certifyIotContract } from "./sync-support.mjs";

export function createIotDeviceOpsSyncService(options = {}) {
  const adapter = options.adapter;
  const repos = options.repos;
  if (!adapter || !repos) {
    throw new Error("IoT device ops sync service requires adapter and repos");
  }

  const integrationName = options.integrationName ?? "iot_platform";

  return {
    async certifyContract() {
      return certifyIotContract({ adapter, repos, integrationName });
    },

    async runForEvent({ tenantId, eventId, skipCertification = false }) {
      const contract = skipCertification ? null : await this.certifyContract();
      const tenantRepos = repos.scope?.({
        tenantId,
        actorId: "iot_device_ops_sync",
        actorRole: "system"
      }) ?? repos;

      await tenantRepos.events.findById(tenantId, eventId);
      const assignments = await tenantRepos.deviceAssignments.listByEvent(tenantId, eventId);

      let checked = 0;
      let matched = 0;
      let mismatched = 0;
      let errors = 0;

      for (const assignment of assignments) {
        const result = await syncDeviceSnapshot({
          adapter,
          repos: tenantRepos,
          integrationName,
          tenantId,
          eventId,
          assignment
        });

        checked += 1;
        if (result.assignment_status === "matched") {
          matched += 1;
        } else if (result.assignment_status === "mismatched" || result.assignment_status === "missing") {
          mismatched += 1;
        } else {
          errors += 1;
        }
      }

      return {
        integration_name: integrationName,
        tenant_id: tenantId,
        event_id: eventId,
        checked_devices: checked,
        matched_devices: matched,
        mismatched_devices: mismatched,
        errored_devices: errors,
        contract_version: contract?.contract_version ?? null,
        environment: contract?.environment ?? null,
        build_version: contract?.build_version ?? null
      };
    }
  };
}

async function syncDeviceSnapshot({ adapter, repos, integrationName, tenantId, eventId, assignment }) {
  const existing = await repos.iotDeviceStatusSnapshots.findByDevice(tenantId, integrationName, assignment.device_id);
  const device = await repos.devices.findById(tenantId, assignment.device_id);
  const now = new Date().toISOString();

  let assignmentResponse = null;
  let diagnosticsResponse = null;
  let assignmentStatus = "matched";
  let diagnosticsStatus = "unknown";
  let errorMessage = null;

  try {
    assignmentResponse = await adapter.getDeviceAssignment(device.id);
    assignmentStatus = deriveAssignmentStatus({ platformAssignment: assignment, iotAssignment: assignmentResponse.assignment });

    diagnosticsResponse = await adapter.getDeviceDiagnostics(device.id);
    diagnosticsStatus = deriveDiagnosticsStatus(diagnosticsResponse);
  } catch (error) {
    assignmentStatus = classifyAssignmentError(error);
    diagnosticsStatus = "error";
    errorMessage = error.message;
  }

  const snapshot = await repos.iotDeviceStatusSnapshots.upsert({
    id: existing?.id ?? nextId("iot-device-status"),
    integration_name: integrationName,
    tenant_id: tenantId,
    event_id: eventId,
    device_id: device.id,
    platform_event_id: assignment.event_id,
    platform_stall_id: assignment.stall_id,
    platform_assignment_checksum: assignment.assignment_checksum,
    iot_event_id: assignmentResponse?.assignment?.event_id ?? diagnosticsResponse?.assignment?.event_id ?? null,
    iot_stall_id: assignmentResponse?.assignment?.stall_id ?? diagnosticsResponse?.assignment?.stall_id ?? null,
    iot_assignment_checksum:
      assignmentResponse?.assignment?.assignment_checksum ??
      diagnosticsResponse?.assignment?.assignment_checksum ??
      null,
    lease_expires_at: assignmentResponse?.assignment?.lease_expires_at ?? null,
    assignment_status: assignmentStatus,
    diagnostics_status: diagnosticsStatus,
    connectivity_status: diagnosticsResponse?.connectivity_status ?? null,
    reader_status: diagnosticsResponse?.reader_status ?? null,
    app_version: diagnosticsResponse?.app_version ?? null,
    firmware_version: diagnosticsResponse?.firmware_version ?? null,
    local_queue_depth: diagnosticsResponse?.local_queue_depth ?? null,
    last_heartbeat_at: diagnosticsResponse?.last_heartbeat_at ?? null,
    open_incident_code: diagnosticsResponse?.open_incident?.code ?? null,
    open_incident_status: diagnosticsResponse?.open_incident?.status ?? null,
    open_incident_severity: diagnosticsResponse?.open_incident?.severity ?? null,
    checked_at: now,
    metadata: {
      consecutive_assignment_mismatch_count:
        assignmentStatus === "mismatched"
          ? (existing?.metadata?.consecutive_assignment_mismatch_count ?? 0) + 1
          : 0,
      consecutive_assignment_visibility_failure_count:
        assignmentStatus === "missing" || assignmentStatus === "error"
          ? (existing?.metadata?.consecutive_assignment_visibility_failure_count ?? 0) + 1
          : 0,
      consecutive_degraded_diagnostics_count:
        diagnosticsStatus === "degraded"
          ? (existing?.metadata?.consecutive_degraded_diagnostics_count ?? 0) + 1
          : 0,
      error_message: errorMessage,
      assignment: assignmentResponse?.assignment ?? null,
      diagnostics: diagnosticsResponse
        ? {
            assignment: diagnosticsResponse.assignment ?? null,
            open_incident: diagnosticsResponse.open_incident ?? null
          }
        : null
    }
  });

  return snapshot;
}

function deriveAssignmentStatus({ platformAssignment, iotAssignment }) {
  if (!iotAssignment) {
    return "missing";
  }
  if (
    iotAssignment.event_id !== platformAssignment.event_id ||
    iotAssignment.stall_id !== platformAssignment.stall_id ||
    iotAssignment.assignment_checksum !== platformAssignment.assignment_checksum
  ) {
    return "mismatched";
  }
  return "matched";
}

function deriveDiagnosticsStatus(diagnosticsResponse) {
  const connectivity = diagnosticsResponse.connectivity_status;
  const reader = diagnosticsResponse.reader_status;
  const hasOpenIncident = diagnosticsResponse.open_incident?.status === "open";
  if (connectivity === "online" && reader === "connected" && !hasOpenIncident) {
    return "healthy";
  }
  return "degraded";
}

function classifyAssignmentError(error) {
  if (error.statusCode === 404) {
    return "missing";
  }
  return "error";
}
