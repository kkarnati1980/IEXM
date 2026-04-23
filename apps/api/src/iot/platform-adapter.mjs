import { HttpError } from "../http-error.mjs";

export function createIotPlatformAdapter(options = {}) {
  const baseUrl = options.baseUrl;
  if (!baseUrl) {
    throw new Error("IoT adapter baseUrl is required");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const authToken = options.authToken ?? null;
  const expectedContractVersion = options.expectedContractVersion ?? null;
  const expectedEnvironment = options.expectedEnvironment ?? null;

  return {
    async getContractMetadata() {
      return requestJson("/meta/contract");
    },
    async provisionDeviceCredential(payload) {
      return requestJson("/device-credentials/provision", {
        method: "POST",
        body: payload
      });
    },
    async revokeDeviceCredential(credentialId) {
      return requestJson(`/device-credentials/${encodeURIComponent(credentialId)}/revoke`, {
        method: "POST"
      });
    },
    async getDeviceAssignment(deviceId) {
      return requestJson(`/devices/${encodeURIComponent(deviceId)}/assignment`);
    },
    async getDeviceDiagnostics(deviceId) {
      return requestJson(`/devices/${encodeURIComponent(deviceId)}/diagnostics`);
    },
    async listTapEvents({ afterCursor, limit } = {}) {
      const page = await requestJson(`/streams/taps${buildQuery({ after_cursor: afterCursor, limit })}`);
      return {
        ...page,
        items: page.items.map(normalizeTapEvent)
      };
    },
    async listHeartbeatEvents({ afterCursor, limit } = {}) {
      const page = await requestJson(`/streams/heartbeats${buildQuery({ after_cursor: afterCursor, limit })}`);
      return {
        ...page,
        items: page.items.map(normalizeHeartbeatEvent)
      };
    },
    async listIncidentEvents({ afterCursor, limit } = {}) {
      const page = await requestJson(`/streams/incidents${buildQuery({ after_cursor: afterCursor, limit })}`);
      return {
        ...page,
        items: page.items.map(normalizeIncidentEvent)
      };
    }
  };

  async function requestJson(pathname, init = {}) {
    const headers = {
      accept: "application/json",
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {})
    };

    const response = await fetchImpl(new URL(`/iot/v1${pathname}`, baseUrl), {
      method: init.method ?? "GET",
      headers,
      body: init.body ? JSON.stringify(init.body) : undefined
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new HttpError(response.status, payload.error?.message ?? "IoT adapter request failed", payload);
    }

    assertContractMetadata(payload);
    return payload;
  }

  function assertContractMetadata(payload) {
    if (!payload.contract_version || !payload.environment || !payload.build_version) {
      throw new HttpError(502, "IoT response is missing contract metadata");
    }
    if (expectedContractVersion && payload.contract_version !== expectedContractVersion) {
      throw new HttpError(502, "IoT contract version mismatch", {
        expected_contract_version: expectedContractVersion,
        received_contract_version: payload.contract_version
      });
    }
    if (expectedEnvironment && payload.environment !== expectedEnvironment) {
      throw new HttpError(502, "IoT environment mismatch", {
        expected_environment: expectedEnvironment,
        received_environment: payload.environment
      });
    }
  }
}

export function normalizeTapEvent(event) {
  return {
    cursor: event.stream_cursor,
    idempotency_key: `${event.device_id}:${event.local_event_id}`,
    raw: structuredClone(event),
    localTapEvent: {
      device_id: event.device_id,
      event_id: event.event_id,
      stall_id: event.stall_id,
      local_event_id: event.local_event_id,
      tap_type: event.tap_type,
      reader_uid: event.reader_uid,
      ndef_payload: event.ndef_payload,
      occurred_at: event.occurred_at
    },
    assignment_checksum: event.assignment_checksum,
    queue_sequence_number: event.queue_sequence_number,
    delivery_mode: event.delivery_mode,
    tenant_id: event.tenant_id,
    cloud_received_at: event.cloud_received_at
  };
}

export function normalizeHeartbeatEvent(event) {
  return {
    cursor: event.stream_cursor,
    raw: structuredClone(event),
    tenant_id: event.tenant_id,
    device_id: event.device_id,
    event_id: event.event_id,
    stall_id: event.stall_id,
    assignment_checksum: event.assignment_checksum,
    battery_level: event.battery_level,
    local_queue_depth: event.local_queue_depth,
    connectivity_status: event.connectivity_status,
    reader_status: event.reader_status,
    app_version: event.app_version,
    firmware_version: event.firmware_version,
    recorded_at: event.recorded_at
  };
}

export function normalizeIncidentEvent(event) {
  return {
    cursor: event.stream_cursor,
    raw: structuredClone(event),
    tenant_id: event.tenant_id,
    device_id: event.device_id,
    event_id: event.event_id,
    stall_id: event.stall_id,
    assignment_checksum: event.assignment_checksum,
    severity: event.severity,
    code: event.code,
    message: event.message,
    status: event.status,
    metadata: event.metadata ?? {},
    occurred_at: event.occurred_at,
    resolved_at: event.resolved_at
  };
}

function buildQuery(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : "";
}

