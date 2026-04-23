import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import { createApp } from "./app.mjs";

const ALLOWED_METHODS = ["GET", "POST", "PATCH", "DELETE", "OPTIONS"];
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? null;

export async function createHttpServer(options = {}) {
  const app = options.app ?? await createApp(options.appOptions ?? {});
  const handler = createHttpHandler(app, options);
  const server = createServer(handler);

  return { app, server, handler };
}

export function createHttpHandler(app, options = {}) {
  const requestBodyLimitBytes = resolvePositiveInteger(
    options.requestBodyLimitBytes ?? process.env.REQUEST_BODY_LIMIT_BYTES,
    1_048_576
  );
  const requestTimeoutMs = resolvePositiveInteger(
    options.requestTimeoutMs ?? process.env.REQUEST_TIMEOUT_MS,
    15_000
  );
  const cors = resolveCorsOptions(options);
  return async function httpHandler(req, res) {
    const corsHeaders = buildCorsHeaders(req, cors);

    if (!ALLOWED_METHODS.includes(req.method)) {
      writeJson(res, 405, { error: "Method not allowed" }, {
        ...corsHeaders,
        allow: ALLOWED_METHODS.join(",")
      });
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...corsHeaders,
        "access-control-allow-methods": ALLOWED_METHODS.join(","),
        "access-control-allow-headers": "content-type,authorization,x-tenant-id,x-break-glass-id,x-request-id",
        "access-control-max-age": "600"
      });
      res.end();
      return;
    }

    try {
      rejectDisallowedCorsOrigin(req, cors);
      validateContentType(req);

      const parsedBody = await Promise.race([
        readRequestBody(req, requestBodyLimitBytes),
        rejectAfter(requestTimeoutMs)
      ]);

      const response = await Promise.race([
        app.inject({
          method: req.method,
          path: req.url,
          headers: req.headers,
          body: parsedBody
        }),
        rejectAfter(requestTimeoutMs)
      ]);

      res.writeHead(response.statusCode, {
        ...corsHeaders,
        ...response.headers
      });
      res.end(JSON.stringify(response.body, null, 2));
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        writeJson(res, 413, { error: error.message }, corsHeaders);
        return;
      }
      if (error instanceof RequestTimeoutError) {
        writeJson(res, 408, { error: error.message }, corsHeaders);
        return;
      }
      if (error instanceof MalformedJsonError) {
        writeJson(res, 400, { error: error.message }, corsHeaders);
        return;
      }
      if (error instanceof UnsupportedMediaTypeError) {
        writeJson(res, 415, { error: error.message }, corsHeaders);
        return;
      }
      if (error instanceof CorsOriginError) {
        writeJson(res, 403, { error: error.message }, corsHeaders);
        return;
      }

      writeJson(res, 500, { error: "Internal server error" }, corsHeaders);
    }
  };
}

function resolveCorsOptions(options) {
  const configured = options.corsAllowOrigins ?? process.env.CORS_ALLOW_ORIGINS ?? "";
  const origins = String(configured)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return {
    origins,
    allowAnyOrigin: origins.includes("*")
  };
}

function buildCorsHeaders(req, cors) {
  const origin = req.headers.origin;
  if (!origin || !cors.origins.length) {
    return {};
  }
  if (!cors.allowAnyOrigin && !cors.origins.includes(origin)) {
    return {};
  }

  return {
    "access-control-allow-origin": cors.allowAnyOrigin ? "*" : origin,
    vary: "Origin"
  };
}

function rejectDisallowedCorsOrigin(req, cors) {
  const origin = req.headers.origin;
  if (!origin || !cors.origins.length || cors.allowAnyOrigin || cors.origins.includes(origin)) {
    return;
  }
  throw new CorsOriginError("CORS origin is not allowed");
}

function validateContentType(req) {
  if (!["POST", "PATCH", "DELETE"].includes(req.method)) {
    return;
  }
  const contentType = req.headers["content-type"];
  if (!contentType) {
    return;
  }
  if (!String(contentType).toLowerCase().startsWith("application/json")) {
    throw new UnsupportedMediaTypeError("Content-Type must be application/json");
  }
}

async function readRequestBody(req, limitBytes) {
  const bodyChunks = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > limitBytes) {
      throw new PayloadTooLargeError(`Request body exceeds limit of ${limitBytes} bytes`);
    }
    bodyChunks.push(chunk);
  }

  const rawBody = Buffer.concat(bodyChunks).toString("utf8");
  if (!rawBody) {
    return {};
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    throw new MalformedJsonError("Malformed JSON request body");
  }
}

function writeJson(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...headers
  });
  res.end(JSON.stringify(body, null, 2));
}

function rejectAfter(ms) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new RequestTimeoutError(`Request timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
}

function resolvePositiveInteger(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`Expected positive numeric value, received: ${value}`);
  }
  return Math.floor(numeric);
}

class MalformedJsonError extends Error {}
class PayloadTooLargeError extends Error {}
class RequestTimeoutError extends Error {}
class UnsupportedMediaTypeError extends Error {}
class CorsOriginError extends Error {}

const { app, server } = await createHttpServer();
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isEntrypoint) {
  server.listen(port, host, () => {
    console.log(`API listening on http://${host}:${port}`);
  });
}

export { app, server };
