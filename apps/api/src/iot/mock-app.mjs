import { createServer } from "node:http";

import { createRouter } from "../router.mjs";
import { HttpError } from "../http-error.mjs";
import { loadMockFixturePack, buildMockIotState } from "./mock-fixtures.mjs";

export async function createMockIotApp(options = {}) {
  const router = createRouter();
  const metadata = {
    contract_version: options.contractVersion ?? "2026-04-17.1",
    environment: options.environment ?? "staging",
    build_version: options.buildVersion ?? "iot-mock-2026.04.17.1"
  };
  const fixtures = options.fixtures ?? (await loadMockFixturePack());
  const state = buildMockIotState(fixtures, metadata);

  registerMockRoutes(router, state);

  return {
    router,
    state,
    async inject(request) {
      return dispatch({ router, state, request });
    }
  };
}

export async function createMockIotServer(options = {}) {
  const app = await createMockIotApp(options);
  const port = Number(options.port ?? process.env.IOT_MOCK_PORT ?? 4010);
  const host = options.host ?? process.env.IOT_MOCK_HOST ?? "127.0.0.1";

  const server = createServer(async (req, res) => {
    const bodyChunks = [];
    for await (const chunk of req) {
      bodyChunks.push(chunk);
    }
    const rawBody = Buffer.concat(bodyChunks).toString("utf8");
    const parsedBody = rawBody ? JSON.parse(rawBody) : {};
    const response = await app.inject({
      method: req.method,
      path: req.url,
      headers: req.headers,
      body: parsedBody
    });

    res.writeHead(response.statusCode, response.headers);
    res.end(JSON.stringify(response.body, null, 2));
  });

  return {
    app,
    server,
    listen() {
      return new Promise((resolve) => {
        server.listen(port, host, () => resolve({ host, port }));
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

function registerMockRoutes(router, state) {
  router.addRoute({
    id: "iot-contract-meta",
    method: "GET",
    path: "/iot/v1/meta/contract",
    handler: async () => state.metadata
  });

  router.addRoute({
    id: "iot-device-credential-provision",
    method: "POST",
    path: "/iot/v1/device-credentials/provision",
    handler: async ({ body }) => {
      requireFields(body, ["tenant_id", "device_id", "credential_label", "requested_by"]);
      if (!state.assignments.has(body.device_id)) {
        throw errorEnvelope(state.metadata, 404, "DEVICE_NOT_FOUND", "Device does not exist in IoT staging");
      }

      const credentialId = `iot-cred-${state.credentials.size + 1}`;
      const credential = {
        credential_id: credentialId,
        device_id: body.device_id,
        bearer_token: `dvc_mock_${body.device_id}_${state.credentials.size + 1}`,
        issued_at: new Date().toISOString(),
        status: "active"
      };
      state.credentials.set(credentialId, credential);
      return {
        ...state.metadata,
        credential_id: credential.credential_id,
        device_id: credential.device_id,
        bearer_token: credential.bearer_token,
        issued_at: credential.issued_at
      };
    },
    statusCode: 201
  });

  router.addRoute({
    id: "iot-device-credential-revoke",
    method: "POST",
    path: "/iot/v1/device-credentials/:credentialId/revoke",
    handler: async ({ params }) => {
      const credential = state.credentials.get(params.credentialId);
      if (!credential) {
        throw errorEnvelope(state.metadata, 404, "CREDENTIAL_NOT_FOUND", "Credential does not exist");
      }
      credential.status = "revoked";
      return {
        ...state.metadata,
        credential_id: credential.credential_id,
        device_id: credential.device_id,
        status: "revoked",
        revoked_at: new Date().toISOString()
      };
    }
  });

  router.addRoute({
    id: "iot-device-assignment",
    method: "GET",
    path: "/iot/v1/devices/:deviceId/assignment",
    handler: async ({ params }) => {
      const assignment = state.assignments.get(params.deviceId);
      if (!assignment) {
        throw errorEnvelope(state.metadata, 404, "ASSIGNMENT_NOT_FOUND", "Device has no active assignment");
      }
      return {
        ...state.metadata,
        assignment
      };
    }
  });

  router.addRoute({
    id: "iot-device-diagnostics",
    method: "GET",
    path: "/iot/v1/devices/:deviceId/diagnostics",
    handler: async ({ params }) => {
      const assignment = state.assignments.get(params.deviceId);
      if (!assignment) {
        throw errorEnvelope(state.metadata, 404, "DEVICE_NOT_FOUND", "Device not found");
      }
      const latestHeartbeat = state.heartbeats
        .filter((entry) => entry.device_id === params.deviceId)
        .sort((left, right) => Date.parse(right.recorded_at) - Date.parse(left.recorded_at))[0];
      const openIncident = state.incidents
        .filter((entry) => entry.device_id === params.deviceId && entry.status === "open")
        .sort((left, right) => Date.parse(right.occurred_at) - Date.parse(left.occurred_at))[0] ?? null;

      return {
        ...state.metadata,
        device_id: params.deviceId,
        assignment,
        connectivity_status: latestHeartbeat?.connectivity_status ?? "online",
        reader_status: latestHeartbeat?.reader_status ?? "connected",
        app_version: latestHeartbeat?.app_version ?? "kiosk-2.4.1",
        firmware_version: latestHeartbeat?.firmware_version ?? "reader-fw-1.9.0",
        local_queue_depth: latestHeartbeat?.local_queue_depth ?? 0,
        last_heartbeat_at: latestHeartbeat?.recorded_at ?? null,
        open_incident: openIncident
      };
    }
  });

  router.addRoute({
    id: "iot-tap-stream",
    method: "GET",
    path: "/iot/v1/streams/taps",
    handler: async ({ query }) => makeStreamPage(state.metadata, state.taps, query)
  });

  router.addRoute({
    id: "iot-heartbeat-stream",
    method: "GET",
    path: "/iot/v1/streams/heartbeats",
    handler: async ({ query }) => makeStreamPage(state.metadata, state.heartbeats, query)
  });

  router.addRoute({
    id: "iot-incident-stream",
    method: "GET",
    path: "/iot/v1/streams/incidents",
    handler: async ({ query }) => makeStreamPage(state.metadata, state.incidents, query)
  });
}

async function dispatch({ router, state, request }) {
  const method = request.method.toUpperCase();
  const url = new URL(request.path, "http://localhost");
  const match = router.match(method, url.pathname);

  if (!match) {
    return jsonResponse(404, {
      ...state.metadata,
      error: {
        code: "NOT_FOUND",
        message: "Mock IoT route not found",
        retryable: false,
        details: {}
      }
    });
  }

  const ctx = {
    params: match.params,
    query: Object.fromEntries(url.searchParams.entries()),
    headers: request.headers ?? {},
    body: request.body ?? {}
  };

  try {
    const payload = await match.route.handler(ctx);
    return jsonResponse(match.route.statusCode ?? 200, payload);
  } catch (error) {
    if (error instanceof HttpError && error.details?.error) {
      return jsonResponse(error.statusCode, error.details);
    }
    if (error instanceof HttpError) {
      return jsonResponse(error.statusCode, {
        ...state.metadata,
        error: {
          code: "INTERNAL_ERROR",
          message: error.message,
          retryable: error.statusCode >= 500,
          details: error.details ?? {}
        }
      });
    }
    return jsonResponse(500, {
      ...state.metadata,
      error: {
        code: "INTERNAL_ERROR",
        message: error.message ?? "Unhandled mock IoT error",
        retryable: true,
        details: {}
      }
    });
  }
}

function makeStreamPage(metadata, items, query) {
  const limit = Math.min(Number(query.limit ?? 100), 500);
  const afterCursor = query.after_cursor;
  let startIndex = 0;

  if (afterCursor) {
    startIndex = items.findIndex((entry) => entry.stream_cursor === afterCursor);
    if (startIndex === -1) {
      throw errorEnvelope(metadata, 400, "CURSOR_INVALID", "after_cursor is malformed or unknown", {
        after_cursor: afterCursor
      });
    }
    startIndex += 1;
  }

  const pageItems = items.slice(startIndex, startIndex + limit);
  const nextItem = items[startIndex + limit] ?? null;

  return {
    ...metadata,
    next_cursor: nextItem?.stream_cursor ?? null,
    items: pageItems
  };
}

function requireFields(body, fields) {
  for (const field of fields) {
    if (!(field in body)) {
      throw errorEnvelope(
        {
          contract_version: "2026-04-17.1",
          environment: "staging",
          build_version: "iot-mock-2026.04.17.1"
        },
        400,
        "VALIDATION_FAILED",
        `Missing field: ${field}`,
        { field }
      );
    }
  }
}

function errorEnvelope(metadata, statusCode, code, message, details = {}) {
  return new HttpError(statusCode, message, {
    ...metadata,
    error: {
      code,
      message,
      retryable: statusCode >= 500 || statusCode === 429 || code === "CURSOR_EXPIRED",
      details
    }
  });
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json"
    },
    body: structuredClone(body)
  };
}

