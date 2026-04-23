import { nextId } from "../store.mjs";
import { createIotContractCertificationRunner } from "./contract-certification-runner.mjs";
import { createIotTapSyncService } from "./tap-sync-service.mjs";
import { createIotHeartbeatSyncService } from "./heartbeat-sync-service.mjs";
import { createIotIncidentSyncService } from "./incident-sync-service.mjs";
import { createIotDeviceOpsSyncService } from "./device-ops-sync-service.mjs";
import { createIotCertificationHealthRunner } from "./certification-health-runner.mjs";
import { certifyIotContract, classifyIotError } from "./sync-support.mjs";

export function createIotIntegrationOrchestrator(options = {}) {
  const adapter = options.adapter;
  const repos = options.repos;
  if (!adapter || !repos) {
    throw new Error("IoT integration orchestrator requires adapter and repos");
  }

  const integrationName = options.integrationName ?? "iot_platform";
  const thresholds = options.thresholds ?? {};
  const alertRouter = options.alertRouter ?? null;
  const parityRunner = options.parityRunner ?? null;

  return {
    async runForEvent({ tenantId, eventId, triggerMode = "manual", initiatedBy = "system" }) {
      const tenantRepos = repos.scope?.({
        tenantId,
        actorId: "iot_integration_orchestrator",
        actorRole: "system"
      }) ?? repos;
      await tenantRepos.events.findById(tenantId, eventId);

      const startedAt = new Date().toISOString();
      let run = await tenantRepos.iotIntegrationRuns.create({
        id: nextId("iot-run"),
        integration_name: integrationName,
        tenant_id: tenantId,
        event_id: eventId,
        trigger_mode: triggerMode,
        initiated_by: initiatedBy,
        status: "running",
        step_count: 0,
        failed_step_count: 0,
        warning_count: 0,
        started_at: startedAt,
        finished_at: null,
        steps: [],
        summary: {},
        error_summary: null,
        created_at: startedAt,
        updated_at: startedAt
      });

      const steps = [];
      let contract = null;
      let latestHealth = null;
      let latestParity = null;
      let abortAfterCertification = false;

      const certificationPack = createIotContractCertificationRunner({ adapter });
      const tapService = createIotTapSyncService({ adapter, repos, certificationPack });
      const heartbeatService = createIotHeartbeatSyncService({ adapter, repos, certificationPack });
      const incidentService = createIotIncidentSyncService({ adapter, repos, certificationPack });
      const deviceOpsService = createIotDeviceOpsSyncService({ adapter, repos });
      const healthRunner = createIotCertificationHealthRunner({ adapter, repos, thresholds });

      const certificationStep = await runStep("contract_certification", async () => {
        contract = await certifyIotContract({ adapter, repos, integrationName, certificationPack });
        const certification = await repos.iotCertificationStatuses.findByIntegration(integrationName);
        return {
          contract_version: contract.contract_version,
          environment: contract.environment,
          build_version: contract.build_version,
          certification_pack: certification?.metadata?.certification_pack ?? null
        };
      });
      steps.push(certificationStep);
      if (certificationStep.status === "failed") {
        abortAfterCertification = true;
      }

      if (!abortAfterCertification) {
        steps.push(await runStep("tap_sync", async () => tapService.runOnce({ skipCertification: true, contract })));
        steps.push(
          await runStep("heartbeat_sync", async () =>
            heartbeatService.runOnce({ skipCertification: true, contract })
          )
        );
        steps.push(
          await runStep("incident_sync", async () =>
            incidentService.runOnce({ skipCertification: true, contract })
          )
        );
        steps.push(
          await runStep("device_ops_sync", async () =>
            deviceOpsService.runForEvent({
              tenantId,
              eventId,
              skipCertification: true
            })
          )
        );
      } else {
        steps.push(skippedStep("tap_sync", "Skipped because contract certification failed"));
        steps.push(skippedStep("heartbeat_sync", "Skipped because contract certification failed"));
        steps.push(skippedStep("incident_sync", "Skipped because contract certification failed"));
        steps.push(skippedStep("device_ops_sync", "Skipped because contract certification failed"));
      }

      const healthStep = await runStep("health_refresh", async () => {
        latestHealth = await healthRunner.runForEvent({
          tenantId,
          eventId,
          refreshDeviceOps: false,
          skipCertification: true,
          contractOverride: contract
        });
        return {
          overall_status: latestHealth.overall_status,
          certification_status: latestHealth.certification_status,
          warning_count: latestHealth.warning_count
        };
      });
      steps.push(healthStep);

      if (parityRunner) {
        const parityStep = await runStep("parity_check", async () => {
          latestParity = await parityRunner.runForEvent({ tenantId, eventId });
          return {
            status: latestParity.status,
            checked_at: latestParity.checked_at,
            issue_count: latestParity.issues?.length ?? 0
          };
        });
        steps.push(parityStep);
      } else {
        steps.push(skippedStep("parity_check", "Skipped because production parity adapter is not configured"));
      }

      const failedSteps = steps.filter((entry) => entry.status === "failed");
      const parityFailure = latestParity?.status === "failed";
      const finalStatus =
        failedSteps.length > 0 || parityFailure
          ? "failed"
          : latestHealth?.warning_count > 0
            ? "completed_with_warnings"
            : "completed";
      const finishedAt = new Date().toISOString();

      run = await tenantRepos.iotIntegrationRuns.update({
        ...run,
        status: finalStatus,
        step_count: steps.length,
        failed_step_count: failedSteps.length,
        warning_count: latestHealth?.warning_count ?? 0,
        finished_at: finishedAt,
        steps,
        summary: {
          latest_health_status: latestHealth?.overall_status ?? null,
          latest_health_warning_count: latestHealth?.warning_count ?? 0,
          latest_parity_status: latestParity?.status ?? null,
          contract_version: contract?.contract_version ?? null,
          environment: contract?.environment ?? null,
          build_version: contract?.build_version ?? null,
          completed_step_names: steps.filter((entry) => entry.status === "completed").map((entry) => entry.name),
          failed_step_names: failedSteps.map((entry) => entry.name)
        },
        error_summary:
          failedSteps[0]?.error?.message ??
          (parityFailure ? "IoT staging-to-production parity check failed" : null),
        updated_at: finishedAt
      });

      if (alertRouter) {
        await alertRouter.routeForEventState({
          tenantId,
          eventId,
          run,
          health: latestHealth,
          parity: latestParity
        });
      }

      return run;
    }
  };
}

async function runStep(name, fn) {
  const startedAt = new Date().toISOString();
  try {
    const result = await fn();
    return {
      name,
      status: "completed",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      retryable: false,
      result
    };
  } catch (error) {
    const classification = classifyIotError(error);
    return {
      name,
      status: "failed",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      retryable: classification.retryable,
      error: {
        code: classification.code,
        message: classification.message,
        failure_type: classification.failureType,
        details: classification.details
      }
    };
  }
}

function skippedStep(name, reason) {
  const now = new Date().toISOString();
  return {
    name,
    status: "skipped",
    started_at: now,
    finished_at: now,
    retryable: false,
    result: {
      reason
    }
  };
}
