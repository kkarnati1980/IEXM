import { nextId } from "../store.mjs";
import { certifyIotContract } from "./sync-support.mjs";
import { createIotContractCertificationRunner } from "./contract-certification-runner.mjs";
import { createIotDeviceOpsSyncService } from "./device-ops-sync-service.mjs";

export function createIotCertificationHealthRunner(options = {}) {
  const adapter = options.adapter;
  const repos = options.repos;
  if (!adapter || !repos) {
    throw new Error("IoT certification health runner requires adapter and repos");
  }

  const integrationName = options.integrationName ?? "iot_platform";
  const thresholds = {
    certificationStaleAfterSeconds: options.thresholds?.certificationStaleAfterSeconds ?? 900,
    streamStaleAfterSeconds: {
      taps: options.thresholds?.streamStaleAfterSeconds?.taps ?? 900,
      heartbeats: options.thresholds?.streamStaleAfterSeconds?.heartbeats ?? 300,
      incidents: options.thresholds?.streamStaleAfterSeconds?.incidents ?? 900
    },
    repeatedFailureThreshold: options.thresholds?.repeatedFailureThreshold ?? 3,
    repeatedMismatchThreshold: options.thresholds?.repeatedMismatchThreshold ?? 3
  };
  const nowFactory = options.nowFactory ?? (() => new Date());

  return {
    async runForEvent({
      tenantId,
      eventId,
      refreshDeviceOps = true,
      skipCertification = false,
      contractOverride = null
    }) {
      const tenantRepos = repos.scope?.({
        tenantId,
        actorId: "iot_health_runner",
        actorRole: "system"
      }) ?? repos;
      await tenantRepos.events.findById(tenantId, eventId);

      let contract = null;
      let certificationError = null;
      if (skipCertification) {
        contract = contractOverride;
      } else {
        try {
          const certificationPack = createIotContractCertificationRunner({ adapter });
          contract = await certifyIotContract({ adapter, repos, integrationName, certificationPack });
        } catch (error) {
          certificationError = error;
        }
      }

      if (contract && refreshDeviceOps) {
        const deviceOpsService = createIotDeviceOpsSyncService({
          adapter,
          repos
        });
        await deviceOpsService.runForEvent({
          tenantId,
          eventId,
          skipCertification: true
        });
      }

      const now = nowFactory();
      const checkedAt = now.toISOString();
      const certification = await repos.iotCertificationStatuses.findByIntegration(integrationName);
      const [tapCheckpoint, heartbeatCheckpoint, incidentCheckpoint] = await Promise.all([
        repos.iotSyncCheckpoints.findByIntegrationAndStream(integrationName, "taps"),
        repos.iotSyncCheckpoints.findByIntegrationAndStream(integrationName, "heartbeats"),
        repos.iotSyncCheckpoints.findByIntegrationAndStream(integrationName, "incidents")
      ]);
      const [assignments, deviceSnapshots] = await Promise.all([
        tenantRepos.deviceAssignments.listByEvent(tenantId, eventId),
        tenantRepos.iotDeviceStatusSnapshots.listByEvent(tenantId, eventId)
      ]);

      const warnings = [];
      const certificationStatus = evaluateCertification({
        certification,
        thresholdSeconds: thresholds.certificationStaleAfterSeconds,
        now,
        warnings,
        certificationError,
        repeatedFailureThreshold: thresholds.repeatedFailureThreshold
      });
      const streamMetrics = {
        taps: evaluateStreamHealth({
          streamName: "taps",
          checkpoint: tapCheckpoint,
          currentContract: contract ?? certification,
          thresholdSeconds: thresholds.streamStaleAfterSeconds.taps,
          now,
          warnings,
          repeatedFailureThreshold: thresholds.repeatedFailureThreshold
        }),
        heartbeats: evaluateStreamHealth({
          streamName: "heartbeats",
          checkpoint: heartbeatCheckpoint,
          currentContract: contract ?? certification,
          thresholdSeconds: thresholds.streamStaleAfterSeconds.heartbeats,
          now,
          warnings,
          repeatedFailureThreshold: thresholds.repeatedFailureThreshold
        }),
        incidents: evaluateStreamHealth({
          streamName: "incidents",
          checkpoint: incidentCheckpoint,
          currentContract: contract ?? certification,
          thresholdSeconds: thresholds.streamStaleAfterSeconds.incidents,
          now,
          warnings,
          repeatedFailureThreshold: thresholds.repeatedFailureThreshold
        })
      };

      const snapshotMetrics = evaluateDeviceSnapshots({
        assignments,
        deviceSnapshots,
        warnings,
        repeatedMismatchThreshold: thresholds.repeatedMismatchThreshold
      });

      const overallStatus = deriveOverallStatus(warnings, certificationStatus);
      const existing = await tenantRepos.iotIntegrationHealthStatuses.findByEvent(
        tenantId,
        integrationName,
        eventId
      );

      const record = await tenantRepos.iotIntegrationHealthStatuses.upsert({
        id: existing?.id ?? nextId("iot-health"),
        integration_name: integrationName,
        tenant_id: tenantId,
        event_id: eventId,
        overall_status: overallStatus,
        certification_status: certificationStatus,
        contract_version: (contract ?? certification)?.contract_version ?? null,
        environment: (contract ?? certification)?.environment ?? null,
        build_version: (contract ?? certification)?.build_version ?? null,
        stale_after_seconds: thresholds.certificationStaleAfterSeconds,
        warning_count: warnings.length,
        checked_at: checkedAt,
        warnings,
        metrics: {
          stream_health: streamMetrics,
          device_health: snapshotMetrics,
          contract_error: certificationError
            ? {
                message: certificationError.message,
                details: certificationError.details ?? {}
              }
            : null
        },
        created_at: existing?.created_at ?? checkedAt,
        updated_at: checkedAt
      });

      return record;
    }
  };
}

function evaluateCertification({
  certification,
  thresholdSeconds,
  now,
  warnings,
  certificationError,
  repeatedFailureThreshold
}) {
  if (!certification) {
    warnings.push(warning("CERTIFICATION_UNKNOWN", "critical", "IoT certification has not been recorded yet"));
    return "unknown";
  }

  const certificationPack = certification.metadata?.certification_pack ?? null;
  if (certificationPack?.status === "failed") {
    warnings.push(
      warning(
        "CERTIFICATION_PACK_FAILED",
        "failed",
        "IoT contract certification pack contains failed checks",
        {
          failed_checks: certificationPack.failed_checks ?? null
        }
      )
    );
  }

  if (certification.status === "failed" || certificationError) {
    warnings.push(
      warning(
        "CONTRACT_CERTIFICATION_FAILED",
        "failed",
        certification.last_failure_message ?? certificationError?.message ?? "IoT contract certification failed"
      )
    );
    return "failed";
  }

  const repeatedFailures = certification.metadata?.consecutive_failure_count ?? 0;
  if (repeatedFailures >= repeatedFailureThreshold) {
    warnings.push(
      warning(
        "REPEATED_CONTRACT_FAILURES",
        "critical",
        `IoT contract certification has failed ${repeatedFailures} times consecutively`,
        {
          consecutive_failure_count: repeatedFailures,
          threshold: repeatedFailureThreshold
        }
      )
    );
  }

  const secondsSinceCheck = ageInSeconds(certification.last_checked_at, now);
  if (secondsSinceCheck > thresholdSeconds) {
    warnings.push(
      warning(
        "CERTIFICATION_STALE",
        "warning",
        `IoT certification is stale by ${secondsSinceCheck - thresholdSeconds} seconds`,
        {
          seconds_since_check: secondsSinceCheck,
          threshold_seconds: thresholdSeconds
        }
      )
    );
  }

  return "certified";
}

function evaluateStreamHealth({
  streamName,
  checkpoint,
  currentContract,
  thresholdSeconds,
  now,
  warnings,
  repeatedFailureThreshold
}) {
  if (!checkpoint) {
    warnings.push(
      warning(
        `${streamName.toUpperCase()}_STREAM_NEVER_SYNCED`,
        "critical",
        `IoT ${streamName} stream has never been synchronized`
      )
    );
    return {
      status: "critical",
      last_synced_at: null,
      seconds_since_sync: null,
      threshold_seconds: thresholdSeconds,
      contract_drift: false
    };
  }

  const secondsSinceSync = ageInSeconds(checkpoint.last_synced_at, now);
  const contractDrift =
    !!currentContract &&
    (checkpoint.last_contract_version !== currentContract.contract_version ||
      checkpoint.last_environment !== currentContract.environment ||
      checkpoint.last_build_version !== currentContract.build_version);

  if (secondsSinceSync > thresholdSeconds) {
    warnings.push(
      warning(
        `${streamName.toUpperCase()}_STREAM_STALE`,
        "warning",
        `IoT ${streamName} stream is stale`,
        {
          seconds_since_sync: secondsSinceSync,
          threshold_seconds: thresholdSeconds
        }
      )
    );
  }

  if (contractDrift) {
    warnings.push(
      warning(
        `${streamName.toUpperCase()}_CONTRACT_DRIFT`,
        "warning",
        `IoT ${streamName} checkpoint contract metadata does not match current certification`,
        {
          checkpoint_contract_version: checkpoint.last_contract_version,
          current_contract_version: currentContract.contract_version,
          checkpoint_build_version: checkpoint.last_build_version,
          current_build_version: currentContract.build_version
        }
      )
    );
  }

  const repeatedFailures = checkpoint.metadata?.consecutive_failure_count ?? 0;
  if (repeatedFailures >= repeatedFailureThreshold) {
    warnings.push(
      warning(
        `${streamName.toUpperCase()}_REPEATED_FAILURES`,
        "critical",
        `IoT ${streamName} stream has ${repeatedFailures} consecutive failures`,
        {
          consecutive_failure_count: repeatedFailures,
          threshold: repeatedFailureThreshold,
          last_failure_code: checkpoint.metadata?.last_failure_code ?? null,
          last_failure_retryable: checkpoint.metadata?.last_failure_retryable ?? null
        }
      )
    );
  }

  const repeatedAssignmentMismatchCount = checkpoint.metadata?.repeated_assignment_mismatch_count ?? 0;
  if (repeatedAssignmentMismatchCount >= repeatedFailureThreshold) {
    warnings.push(
      warning(
        `${streamName.toUpperCase()}_REPEATED_ASSIGNMENT_MISMATCH`,
        "critical",
        `IoT ${streamName} stream has repeated assignment mismatch failures`,
        {
          repeated_assignment_mismatch_count: repeatedAssignmentMismatchCount,
          threshold: repeatedFailureThreshold
        }
      )
    );
  }

  return {
    status: contractDrift || secondsSinceSync > thresholdSeconds ? "warning" : "healthy",
    last_synced_at: checkpoint.last_synced_at,
    seconds_since_sync: secondsSinceSync,
    threshold_seconds: thresholdSeconds,
    contract_drift: contractDrift
  };
}

function evaluateDeviceSnapshots({ assignments, deviceSnapshots, warnings, repeatedMismatchThreshold }) {
  const assignmentCount = assignments.length;
  const snapshotCount = deviceSnapshots.length;
  const mismatchedAssignments = deviceSnapshots.filter((entry) => entry.assignment_status === "mismatched").length;
  const missingAssignments = deviceSnapshots.filter((entry) => entry.assignment_status === "missing").length;
  const erroredAssignments = deviceSnapshots.filter((entry) => entry.assignment_status === "error").length;
  const degradedDiagnostics = deviceSnapshots.filter((entry) => entry.diagnostics_status === "degraded").length;
  const unknownDiagnostics = deviceSnapshots.filter((entry) => entry.diagnostics_status === "unknown").length;
  const openIncidents = deviceSnapshots.filter((entry) => entry.open_incident_status === "open").length;
  const missingSnapshots = Math.max(assignmentCount - snapshotCount, 0);

  if (missingSnapshots > 0) {
    warnings.push(
      warning(
        "DEVICE_STATUS_SNAPSHOTS_MISSING",
        "warning",
        `${missingSnapshots} device status snapshots are missing`,
        {
          expected_devices: assignmentCount,
          snapshot_count: snapshotCount
        }
      )
    );
  }
  if (mismatchedAssignments > 0) {
    warnings.push(
      warning(
        "DEVICE_ASSIGNMENT_MISMATCH",
        "critical",
        `${mismatchedAssignments} devices have assignment mismatch between platform and IoT`,
        { mismatched_devices: mismatchedAssignments }
      )
    );
  }
  const repeatedMismatches = deviceSnapshots.filter(
    (entry) => (entry.metadata?.consecutive_assignment_mismatch_count ?? 0) >= repeatedMismatchThreshold
  ).length;
  if (repeatedMismatches > 0) {
    warnings.push(
      warning(
        "REPEATED_DEVICE_ASSIGNMENT_MISMATCH",
        "critical",
        `${repeatedMismatches} devices show repeated assignment mismatch across health runs`,
        {
          repeated_mismatch_devices: repeatedMismatches,
          threshold: repeatedMismatchThreshold
        }
      )
    );
  }
  if (missingAssignments > 0 || erroredAssignments > 0) {
    warnings.push(
      warning(
        "DEVICE_ASSIGNMENT_VISIBILITY_ISSUE",
        "warning",
        `${missingAssignments + erroredAssignments} devices have missing or errored IoT assignment visibility`,
        {
          missing_assignments: missingAssignments,
          errored_assignments: erroredAssignments
        }
      )
    );
  }
  if (degradedDiagnostics > 0 || unknownDiagnostics > 0) {
    warnings.push(
      warning(
        "DEVICE_DIAGNOSTICS_DEGRADED",
        "warning",
        `${degradedDiagnostics + unknownDiagnostics} devices report degraded or unknown diagnostics`,
        {
          degraded_devices: degradedDiagnostics,
          unknown_devices: unknownDiagnostics
        }
      )
    );
  }
  if (openIncidents > 0) {
    warnings.push(
      warning(
        "OPEN_INCIDENTS_PRESENT",
        "warning",
        `${openIncidents} devices have open IoT incidents`,
        { open_incidents: openIncidents }
      )
    );
  }

  return {
    expected_devices: assignmentCount,
    snapshot_count: snapshotCount,
    missing_snapshots: missingSnapshots,
    mismatched_assignments: mismatchedAssignments,
    missing_assignments: missingAssignments,
    errored_assignments: erroredAssignments,
    degraded_diagnostics: degradedDiagnostics,
    unknown_diagnostics: unknownDiagnostics,
    open_incidents: openIncidents
  };
}

function deriveOverallStatus(warnings, certificationStatus) {
  if (certificationStatus === "failed") {
    return "failed";
  }

  const ranking = {
    healthy: 0,
    warning: 1,
    critical: 2,
    failed: 3
  };

  let status = "healthy";
  for (const entry of warnings) {
    if (ranking[entry.severity] > ranking[status]) {
      status = entry.severity;
    }
  }
  return status;
}

function warning(code, severity, message, details = {}) {
  return {
    code,
    severity,
    message,
    details
  };
}

function ageInSeconds(isoDate, now) {
  if (!isoDate) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.floor((now.getTime() - Date.parse(isoDate)) / 1000);
}
