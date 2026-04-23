import { nextId } from "../store.mjs";

export function createIotEnvironmentParityRunner(options = {}) {
  const repos = options.repos;
  const stagingAdapter = options.stagingAdapter;
  const productionAdapter = options.productionAdapter;
  if (!repos || !stagingAdapter || !productionAdapter) {
    throw new Error("IoT environment parity runner requires repositories and both adapters");
  }

  const integrationName = options.integrationName ?? "iot_platform";
  const releaseManifest = options.releaseManifest ?? null;
  const requireReleaseManifest = options.requireReleaseManifest ?? false;

  return {
    async runForEvent({ tenantId, eventId }) {
      const tenantRepos = repos.scope?.({
        tenantId,
        actorId: "iot_environment_parity_runner",
        actorRole: "system"
      }) ?? repos;
      await tenantRepos.events.findById(tenantId, eventId);

      const now = new Date().toISOString();
      const certification = await tenantRepos.iotCertificationStatuses.findByIntegration(integrationName);

      try {
        const [staging, production] = await Promise.all([
          stagingAdapter.getContractMetadata(),
          productionAdapter.getContractMetadata()
        ]);

        const issues = buildIssues({
          certification,
          staging,
          production,
          releaseManifest,
          requireReleaseManifest
        });
        return tenantRepos.iotEnvironmentParityStatuses.upsert({
          id: nextId("iot-parity"),
          integration_name: integrationName,
          tenant_id: tenantId,
          event_id: eventId,
          status: issues.length ? "failed" : "passed",
          staging_contract_version: staging.contract_version,
          staging_environment: staging.environment,
          staging_build_version: staging.build_version,
          production_contract_version: production.contract_version,
          production_environment: production.environment,
          production_build_version: production.build_version,
          checked_at: now,
          issues,
          details: {
            certification_status: certification?.status ?? "unknown",
            release_id: releaseManifest?.release_id ?? null,
            release_approved: releaseManifest?.approved ?? null
          },
          created_at: now,
          updated_at: now
        });
      } catch (error) {
        return tenantRepos.iotEnvironmentParityStatuses.upsert({
          id: nextId("iot-parity"),
          integration_name: integrationName,
          tenant_id: tenantId,
          event_id: eventId,
          status: "failed",
          staging_contract_version: null,
          staging_environment: null,
          staging_build_version: null,
          production_contract_version: null,
          production_environment: null,
          production_build_version: null,
          checked_at: now,
          issues: [
            {
              code: "PARITY_CHECK_FAILED",
              severity: "critical",
              message: error.message ?? "Parity check failed"
            }
          ],
          details: {
            error: error.details ?? null
          },
          created_at: now,
          updated_at: now
        });
      }
    }
  };
}

function buildIssues({ certification, staging, production, releaseManifest, requireReleaseManifest }) {
  const issues = [];
  const manifestIntegration = releaseManifest ?? null;

  if (certification?.status !== "certified") {
    issues.push({
      code: "STAGING_NOT_CERTIFIED",
      severity: "critical",
      message: "Staging certification must pass before production parity is considered valid"
    });
  }

  if (staging.environment !== "staging") {
    issues.push({
      code: "STAGING_ENVIRONMENT_INVALID",
      severity: "critical",
      message: "Staging adapter did not report environment=staging"
    });
  }

  if (production.environment !== "production") {
    issues.push({
      code: "PRODUCTION_ENVIRONMENT_INVALID",
      severity: "critical",
      message: "Production adapter did not report environment=production"
    });
  }

  if (certification?.contract_version && certification.contract_version !== staging.contract_version) {
    issues.push({
      code: "STAGING_CERTIFICATION_DRIFT",
      severity: "critical",
      message: "Staging contract metadata no longer matches the last certified contract version",
      details: {
        certified_contract_version: certification.contract_version,
        staging_contract_version: staging.contract_version
      }
    });
  }

  if (staging.contract_version !== production.contract_version) {
    issues.push({
      code: "CONTRACT_VERSION_MISMATCH",
      severity: "critical",
      message: "Staging and production contract versions do not match",
      details: {
        staging_contract_version: staging.contract_version,
        production_contract_version: production.contract_version
      }
    });
  }

  if (staging.build_version !== production.build_version) {
    issues.push({
      code: "BUILD_VERSION_MISMATCH",
      severity: "critical",
      message: "Staging and production build versions do not match",
      details: {
        staging_build_version: staging.build_version,
        production_build_version: production.build_version
      }
    });
  }

  if (requireReleaseManifest && !manifestIntegration) {
    issues.push({
      code: "RELEASE_MANIFEST_MISSING",
      severity: "critical",
      message: "Release manifest is required before parity can pass"
    });
  }

  if (manifestIntegration) {
    if (manifestIntegration.approved !== true) {
      issues.push({
        code: "RELEASE_MANIFEST_NOT_APPROVED",
        severity: "critical",
        message: "Release manifest is not marked approved for pilot go-live"
      });
    }

    const stagingManifest = manifestIntegration.staging ?? {};
    const productionManifest = manifestIntegration.production ?? {};

    if (
      stagingManifest.contract_version &&
      stagingManifest.contract_version !== staging.contract_version
    ) {
      issues.push({
        code: "STAGING_MANIFEST_CONTRACT_MISMATCH",
        severity: "critical",
        message: "Staging contract version does not match the approved release manifest",
        details: {
          manifest_contract_version: stagingManifest.contract_version,
          staging_contract_version: staging.contract_version
        }
      });
    }

    if (
      productionManifest.contract_version &&
      productionManifest.contract_version !== production.contract_version
    ) {
      issues.push({
        code: "PRODUCTION_MANIFEST_CONTRACT_MISMATCH",
        severity: "critical",
        message: "Production contract version does not match the approved release manifest",
        details: {
          manifest_contract_version: productionManifest.contract_version,
          production_contract_version: production.contract_version
        }
      });
    }

    if (stagingManifest.build_version && stagingManifest.build_version !== staging.build_version) {
      issues.push({
        code: "STAGING_MANIFEST_BUILD_MISMATCH",
        severity: "critical",
        message: "Staging build version does not match the approved release manifest",
        details: {
          manifest_build_version: stagingManifest.build_version,
          staging_build_version: staging.build_version
        }
      });
    }

    if (
      productionManifest.build_version &&
      productionManifest.build_version !== production.build_version
    ) {
      issues.push({
        code: "PRODUCTION_MANIFEST_BUILD_MISMATCH",
        severity: "critical",
        message: "Production build version does not match the approved release manifest",
        details: {
          manifest_build_version: productionManifest.build_version,
          production_build_version: production.build_version
        }
      });
    }
  }

  return issues;
}
