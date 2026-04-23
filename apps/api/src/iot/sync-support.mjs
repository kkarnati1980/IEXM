import { nextId } from "../store.mjs";

export async function certifyIotContract({
  adapter,
  repos,
  integrationName = "iot_platform",
  certificationPack = null
}) {
  try {
    const metadata = await adapter.getContractMetadata();
    let certificationPackResult = null;
    if (certificationPack) {
      certificationPackResult = await certificationPack.run();
    }

    await persistCertificationStatus({
      repos,
      integrationName,
      status: "certified",
      contract: metadata,
      lastFailureMessage: null,
      metadata: {
        source: "iot_adapter",
        certification_pack: certificationPackResult
      }
    });
    return metadata;
  } catch (error) {
    await persistCertificationStatus({
      repos,
      integrationName,
      status: "failed",
      contract: {
        contract_version: error.details?.received_contract_version ?? null,
        environment: error.details?.received_environment ?? null,
        build_version: error.details?.build_version ?? null
      },
      lastFailureMessage: error.message,
      metadata: {
        error_details: error.details ?? {}
      }
    });
    throw error;
  }
}

export async function runPagedIotSync({
  repos,
  integrationName,
  streamName,
  pageLimit,
  contract,
  listPage,
  ingestItem
}) {
  const checkpoint =
    (await repos.iotSyncCheckpoints.findByIntegrationAndStream(integrationName, streamName)) ?? null;

  let afterCursor = checkpoint?.last_cursor ?? null;
  let processed = 0;
  let created = 0;
  let duplicates = 0;
  let lastCursor = checkpoint?.last_cursor ?? null;

  while (true) {
    const pageStartCursor = afterCursor;
    let page;
    try {
      page = await listPage({ afterCursor, limit: pageLimit });
    } catch (error) {
      await persistSyncFailure({
        repos,
        checkpoint,
        integrationName,
        streamName,
        lastCursor: pageStartCursor,
        contract,
        error,
        metadata: {
          failure_stage: "page_fetch"
        }
      });
      throw error;
    }

    if (!page.items.length) {
      await persistIotCheckpoint({
        repos,
        checkpoint,
        integrationName,
        streamName,
        lastCursor,
        contract,
        metadata: {
          last_page_size: 0
        }
      });
      break;
    }

    for (const item of page.items) {
      try {
        const result = await ingestItem(item);
        processed += 1;
        if (result.mode === "created") {
          created += 1;
        } else {
          duplicates += 1;
        }
        lastCursor = item.cursor;
      } catch (error) {
        await persistSyncFailure({
          repos,
          checkpoint,
          integrationName,
          streamName,
          lastCursor: pageStartCursor,
          contract,
          error,
          metadata: {
            failure_stage: "item_ingest",
            failed_cursor: item.cursor
          }
        });
        throw error;
      }
    }

    await persistIotCheckpoint({
      repos,
      checkpoint,
      integrationName,
      streamName,
      lastCursor,
      contract,
      metadata: {
        last_page_size: page.items.length,
        next_cursor: page.next_cursor
      }
    });

    if (!page.next_cursor) {
      break;
    }
    afterCursor = lastCursor;
  }

  return {
    integration_name: integrationName,
    stream_name: streamName,
    processed,
    created,
    duplicates,
    checkpoint_cursor: lastCursor,
    contract_version: contract.contract_version,
    environment: contract.environment,
    build_version: contract.build_version
  };
}

export async function persistIotCheckpoint({
  repos,
  checkpoint,
  integrationName,
  streamName,
  lastCursor,
  contract,
  metadata
}) {
  const now = new Date().toISOString();
  const previousMetadata = checkpoint?.metadata ?? {};
  return repos.iotSyncCheckpoints.upsert({
    id: checkpoint?.id ?? nextId("iot-checkpoint"),
    integration_name: integrationName,
    stream_name: streamName,
    last_cursor: lastCursor,
    last_contract_version: contract.contract_version,
    last_environment: contract.environment,
    last_build_version: contract.build_version,
    last_synced_at: now,
    updated_at: now,
    metadata: {
      ...previousMetadata,
      ...metadata,
      last_success_at: now,
      consecutive_failure_count: 0,
      last_failure_at: null,
      last_failure_code: null,
      last_failure_message: null,
      last_failure_retryable: null,
      last_failure_type: null,
      failure_stage: null
    }
  });
}

export async function persistSyncFailure({
  repos,
  checkpoint,
  integrationName,
  streamName,
  lastCursor,
  contract,
  error,
  metadata
}) {
  const classification = classifyIotError(error);
  const now = new Date().toISOString();
  const previousMetadata = checkpoint?.metadata ?? {};
  const repeatedMismatchCount =
    classification.code === "ASSIGNMENT_SCOPE_VIOLATION" || /assignment/i.test(classification.code ?? "")
      ? (previousMetadata.repeated_assignment_mismatch_count ?? 0) + 1
      : 0;

  return repos.iotSyncCheckpoints.upsert({
    id: checkpoint?.id ?? nextId("iot-checkpoint"),
    integration_name: integrationName,
    stream_name: streamName,
    last_cursor: lastCursor,
    last_contract_version: contract?.contract_version ?? checkpoint?.last_contract_version ?? null,
    last_environment: contract?.environment ?? checkpoint?.last_environment ?? null,
    last_build_version: contract?.build_version ?? checkpoint?.last_build_version ?? null,
    last_synced_at: checkpoint?.last_synced_at ?? null,
    updated_at: now,
    metadata: {
      ...previousMetadata,
      ...metadata,
      last_failure_at: now,
      last_failure_code: classification.code,
      last_failure_message: classification.message,
      last_failure_retryable: classification.retryable,
      last_failure_type: classification.failureType,
      consecutive_failure_count: (previousMetadata.consecutive_failure_count ?? 0) + 1,
      total_failure_count: (previousMetadata.total_failure_count ?? 0) + 1,
      repeated_assignment_mismatch_count: repeatedMismatchCount
    }
  });
}

export function classifyIotError(error) {
  const code = error?.details?.error?.code ?? error?.details?.code ?? inferLocalErrorCode(error);
  const retryable =
    typeof error?.details?.error?.retryable === "boolean"
      ? error.details.error.retryable
      : error?.statusCode >= 500 || error?.statusCode === 429;
  return {
    code,
    retryable,
    failureType: retryable ? "retryable" : "terminal",
    message: error?.message ?? "Unknown IoT error",
    details: error?.details ?? {}
  };
}

async function persistCertificationStatus({
  repos,
  integrationName,
  status,
  contract,
  lastFailureMessage,
  metadata
}) {
  const existing = await repos.iotCertificationStatuses.findByIntegration(integrationName);
  const now = new Date().toISOString();
  const previousMetadata = existing?.metadata ?? {};
  return repos.iotCertificationStatuses.upsert({
    id: existing?.id ?? nextId("iot-certification"),
    integration_name: integrationName,
    status,
    contract_version: contract.contract_version ?? existing?.contract_version ?? null,
    environment: contract.environment ?? existing?.environment ?? null,
    build_version: contract.build_version ?? existing?.build_version ?? null,
    last_checked_at: now,
    last_certified_at: status === "certified" ? now : existing?.last_certified_at ?? null,
    last_failure_at: status === "failed" ? now : existing?.last_failure_at ?? null,
    last_failure_message: lastFailureMessage,
    metadata: {
      ...previousMetadata,
      ...(metadata ?? {}),
      consecutive_failure_count: status === "failed" ? (previousMetadata.consecutive_failure_count ?? 0) + 1 : 0,
      total_failure_count:
        status === "failed"
          ? (previousMetadata.total_failure_count ?? 0) + 1
          : previousMetadata.total_failure_count ?? 0
    }
  });
}

function inferLocalErrorCode(error) {
  if (!error?.message) {
    return "LOCAL_ERROR";
  }
  if (/assignment/i.test(error.message)) {
    return "ASSIGNMENT_SCOPE_VIOLATION";
  }
  if (/contract version mismatch/i.test(error.message)) {
    return "UNSUPPORTED_CONTRACT_VERSION";
  }
  if (/environment mismatch/i.test(error.message)) {
    return "ENVIRONMENT_ACCESS_DENIED";
  }
  if (/not found/i.test(error.message)) {
    return "NOT_FOUND";
  }
  return "LOCAL_ERROR";
}
