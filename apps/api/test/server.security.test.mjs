import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { createHttpHandler } from "../src/server.mjs";

test("http handler rejects malformed JSON bodies with 400", async () => {
  const handler = createHttpHandler({
    async inject() {
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: { ok: true }
      };
    }
  });

  const response = await invokeHandler(handler, {
    method: "POST",
    url: "/consents/capture",
    headers: {
      "content-type": "application/json"
    },
    body: '{"broken":'
  });

  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /Malformed JSON/);
});

test("http handler rejects oversized request bodies with 413", async () => {
  const handler = createHttpHandler(
    {
      async inject() {
        return {
          statusCode: 200,
          headers: { "content-type": "application/json" },
          body: { ok: true }
        };
      }
    },
    {
      requestBodyLimitBytes: 32
    }
  );

  const response = await invokeHandler(handler, {
    method: "POST",
    url: "/consents/capture",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ value: "x".repeat(200) })
  });

  assert.equal(response.statusCode, 413);
  assert.match(response.body.error, /exceeds limit/);
});

test("http handler times out slow handlers with 408", async () => {
  const handler = createHttpHandler(
    {
      async inject() {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {
          statusCode: 200,
          headers: { "content-type": "application/json" },
          body: { ok: true }
        };
      }
    },
    {
      requestTimeoutMs: 25
    }
  );

  const response = await invokeHandler(handler, {
    method: "GET",
    url: "/health"
  });

  assert.equal(response.statusCode, 408);
  assert.match(response.body.error, /timed out/i);
});

test("http handler supports CORS preflight for allowed origins", async () => {
  const handler = createHttpHandler(
    {
      async inject() {
        return {
          statusCode: 200,
          headers: { "content-type": "application/json" },
          body: { ok: true }
        };
      }
    },
    {
      corsAllowOrigins: "https://console.example.com"
    }
  );

  const response = await invokeHandler(handler, {
    method: "OPTIONS",
    url: "/health",
    headers: {
      origin: "https://console.example.com"
    }
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.headers["access-control-allow-origin"], "https://console.example.com");
  assert.match(response.headers["access-control-allow-methods"], /GET,POST,PATCH,PUT,DELETE,OPTIONS/);
});

test("http handler blocks disallowed CORS origins when an allowlist is configured", async () => {
  const handler = createHttpHandler(
    {
      async inject() {
        return {
          statusCode: 200,
          headers: { "content-type": "application/json" },
          body: { ok: true }
        };
      }
    },
    {
      corsAllowOrigins: "https://console.example.com"
    }
  );

  const response = await invokeHandler(handler, {
    method: "GET",
    url: "/health",
    headers: {
      origin: "https://evil.example.com"
    }
  });

  assert.equal(response.statusCode, 403);
  assert.match(response.body.error, /CORS origin/);
});

test("http handler rejects unsupported methods and non-json mutation content types", async () => {
  const handler = createHttpHandler({
    async inject() {
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: { ok: true }
      };
    }
  });

  const unsupported = await invokeHandler(handler, {
    method: "TRACE",
    url: "/health"
  });
  assert.equal(unsupported.statusCode, 405);
  assert.match(unsupported.headers.allow, /PATCH/);

  const wrongContentType = await invokeHandler(handler, {
    method: "POST",
    url: "/consents/capture",
    headers: {
      "content-type": "text/plain"
    },
    body: "plain-text"
  });
  assert.equal(wrongContentType.statusCode, 415);
  assert.match(wrongContentType.body.error, /application\/json/);
});

test("http handler does not expose unexpected handler errors", async () => {
  const handler = createHttpHandler({
    async inject() {
      throw new Error("database password leaked in stack");
    }
  });

  const response = await invokeHandler(handler, {
    method: "GET",
    url: "/health"
  });

  assert.equal(response.statusCode, 500);
  assert.equal(response.body.error, "Internal server error");
});

async function invokeHandler(handler, { method, url, headers = {}, body = "" }) {
  const req = new PassThrough();
  req.method = method;
  req.url = url;
  req.headers = headers;

  const response = createMockResponse();
  const completion = response.done;
  handler(req, response);
  if (body) {
    req.write(body);
  }
  req.end();
  return completion;
}

function createMockResponse() {
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  return {
    statusCode: null,
    headers: {},
    body: null,
    done,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(payload = "") {
      this.body = payload ? JSON.parse(payload) : {};
      resolveDone({
        statusCode: this.statusCode,
        headers: this.headers,
        body: this.body
      });
    }
  };
}
