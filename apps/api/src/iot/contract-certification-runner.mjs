export function createIotContractCertificationRunner(options = {}) {
  const adapter = options.adapter;
  if (!adapter) {
    throw new Error("IoT contract certification runner requires adapter");
  }

  return {
    async run() {
      const checks = [];
      checks.push(await runCheck("contract_metadata", async () => {
        const metadata = await adapter.getContractMetadata();
        requireString(metadata.contract_version, "contract_version");
        requireString(metadata.environment, "environment");
        requireString(metadata.build_version, "build_version");
        return {
          contract_version: metadata.contract_version,
          environment: metadata.environment,
          build_version: metadata.build_version
        };
      }));

      checks.push(await runCheck("tap_stream_schema", async () => {
        const page = await adapter.listTapEvents({ limit: 1 });
        const item = page.items[0];
        requireString(item.cursor, "cursor");
        requireString(item.tenant_id, "tenant_id");
        requireString(item.localTapEvent.device_id, "device_id");
        requireString(item.localTapEvent.event_id, "event_id");
        requireString(item.localTapEvent.stall_id, "stall_id");
        requireString(item.localTapEvent.local_event_id, "local_event_id");
        requireEnum(item.localTapEvent.tap_type, ["phone_ndef", "card_uid", "qr"], "tap_type");
        requireEnum(item.delivery_mode, ["online_single", "offline_replay"], "delivery_mode");
        return {
          cursor: item.cursor,
          tap_type: item.localTapEvent.tap_type,
          delivery_mode: item.delivery_mode
        };
      }));

      checks.push(await runCheck("heartbeat_stream_schema", async () => {
        const page = await adapter.listHeartbeatEvents({ limit: 1 });
        const item = page.items[0];
        requireString(item.cursor, "cursor");
        requireString(item.device_id, "device_id");
        requireString(item.event_id, "event_id");
        requireString(item.stall_id, "stall_id");
        requireNumber(item.battery_level, "battery_level");
        requireNumber(item.local_queue_depth, "local_queue_depth");
        requireString(item.connectivity_status, "connectivity_status");
        requireString(item.reader_status, "reader_status");
        return {
          cursor: item.cursor,
          connectivity_status: item.connectivity_status,
          reader_status: item.reader_status
        };
      }));

      checks.push(await runCheck("incident_stream_schema", async () => {
        const page = await adapter.listIncidentEvents({ limit: 1 });
        const item = page.items[0];
        requireString(item.cursor, "cursor");
        requireString(item.device_id, "device_id");
        requireString(item.event_id, "event_id");
        requireString(item.stall_id, "stall_id");
        requireEnum(item.severity, ["P0", "P1", "P2", "P3"], "severity");
        requireString(item.code, "code");
        requireString(item.message, "message");
        requireEnum(item.status, ["open", "resolved"], "status");
        return {
          cursor: item.cursor,
          severity: item.severity,
          code: item.code
        };
      }));

      checks.push(await runCheck("cursor_invalid_error", async () => {
        await assertCatalogError(
          () => adapter.listTapEvents({ afterCursor: "unknown-cursor", limit: 1 }),
          {
            statusCode: 400,
            code: "CURSOR_INVALID",
            retryable: false
          }
        );
        return { validated: true };
      }));

      checks.push(await runCheck("device_not_found_error", async () => {
        await assertCatalogError(
          () => adapter.getDeviceDiagnostics("missing-device"),
          {
            statusCode: 404,
            code: "DEVICE_NOT_FOUND",
            retryable: false
          }
        );
        return { validated: true };
      }));

      const passed = checks.filter((entry) => entry.status === "passed").length;
      const failed = checks.filter((entry) => entry.status === "failed").length;

      return {
        status: failed === 0 ? "passed" : "failed",
        checked_at: new Date().toISOString(),
        total_checks: checks.length,
        passed_checks: passed,
        failed_checks: failed,
        checks
      };
    }
  };
}

async function runCheck(name, fn) {
  try {
    const details = await fn();
    return { name, status: "passed", details };
  } catch (error) {
    return {
      name,
      status: "failed",
      error: {
        message: error.message,
        code: error.details?.error?.code ?? error.details?.code ?? null,
        details: error.details ?? {}
      }
    };
  }
}

async function assertCatalogError(fn, expectation) {
  try {
    await fn();
    throw new Error(`Expected error ${expectation.code}`);
  } catch (error) {
    if (error.statusCode !== expectation.statusCode) {
      throw new Error(`Expected status ${expectation.statusCode}, received ${error.statusCode}`);
    }
    const code = error.details?.error?.code;
    const retryable = error.details?.error?.retryable;
    if (code !== expectation.code) {
      throw new Error(`Expected code ${expectation.code}, received ${code}`);
    }
    if (retryable !== expectation.retryable) {
      throw new Error(`Expected retryable=${expectation.retryable}, received ${retryable}`);
    }
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected non-empty string for ${label}`);
  }
}

function requireNumber(value, label) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`Expected number for ${label}`);
  }
}

function requireEnum(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new Error(`Expected ${label} in [${allowed.join(", ")}]`);
  }
}
