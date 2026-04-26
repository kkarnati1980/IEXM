import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.mjs";
import { createSeedState } from "../src/store.mjs";
import { issuePlatformToken } from "../src/auth/platform-jwt.mjs";
import { buildUserPrincipal } from "../src/auth/principals.mjs";

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

async function appAs(role) {
  const state = createSeedState();
  const secret = state.sessionSecret;
  const user = state.users.find((u) => u.role === role);
  const assignments = state.userRoleAssignments.filter((a) => a.user_id === user.id);
  const principal = buildUserPrincipal(user, [], assignments);
  const jwt = issuePlatformToken(principal, secret);
  const app = await createApp({ state });
  return { app, user, jwt, state, secret };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/api-clients — create with one-time secret
// ─────────────────────────────────────────────────────────────────────────────

test("POST /admin/api-clients: returns client_id and client_secret once", async () => {
  const { app, jwt } = await appAs("platform_admin");
  const res = await app.inject({
    method: "POST",
    path: "/admin/api-clients",
    headers: bearer(jwt),
    body: { name: "Test Client", scopes: ["interactions:read", "events:read"] }
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.ok(res.body.client_id, "client_id should be returned");
  assert.ok(res.body.client_secret, "client_secret should be returned on creation");
  assert.equal(typeof res.body.client_secret, "string");
  assert.ok(res.body.client_secret.length >= 32, "secret should be at least 32 chars");
});

test("POST /admin/api-clients: secret is not stored in plaintext", async () => {
  const { app, jwt, state } = await appAs("platform_admin");
  const res = await app.inject({
    method: "POST",
    path: "/admin/api-clients",
    headers: bearer(jwt),
    body: { name: "Secret Test Client", scopes: ["analytics:read"] }
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));

  const plaintext = res.body.client_secret;
  const stored = state.apiClients[0];
  assert.ok(stored, "client should be in state");
  assert.notEqual(stored.client_secret_hash, plaintext, "hash must differ from plaintext");
  assert.ok(!("client_secret" in stored), "plaintext secret must not be stored");
});

test("POST /admin/api-clients: rejects invalid scopes", async () => {
  const { app, jwt } = await appAs("platform_admin");
  const res = await app.inject({
    method: "POST",
    path: "/admin/api-clients",
    headers: bearer(jwt),
    body: { name: "Bad Scopes", scopes: ["invalid:scope"] }
  });
  assert.equal(res.statusCode, 400, JSON.stringify(res.body));
});

test("POST /admin/api-clients: requires name", async () => {
  const { app, jwt } = await appAs("platform_admin");
  const res = await app.inject({
    method: "POST",
    path: "/admin/api-clients",
    headers: bearer(jwt),
    body: { scopes: ["events:read"] }
  });
  assert.equal(res.statusCode, 400, JSON.stringify(res.body));
});

test("POST /admin/api-clients: organizer_admin is forbidden", async () => {
  const { app, jwt } = await appAs("organizer_admin");
  const res = await app.inject({
    method: "POST",
    path: "/admin/api-clients",
    headers: bearer(jwt),
    body: { name: "Org Client", scopes: ["events:read"] }
  });
  assert.equal(res.statusCode, 403, JSON.stringify(res.body));
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/api-clients/:id — detail without secret exposure
// ─────────────────────────────────────────────────────────────────────────────

test("GET /admin/api-clients/:id: returns detail without client_secret", async () => {
  const { app, jwt } = await appAs("platform_admin");

  const createRes = await app.inject({
    method: "POST",
    path: "/admin/api-clients",
    headers: bearer(jwt),
    body: { name: "Detail Client", scopes: ["leads:export"] }
  });
  assert.equal(createRes.statusCode, 201);
  const clientId = createRes.body.client_id;

  // List to get id
  const listRes = await app.inject({
    method: "GET",
    path: "/admin/api-clients",
    headers: bearer(jwt)
  });
  assert.equal(listRes.statusCode, 200);
  const record = listRes.body.find((c) => c.client_id === clientId);
  assert.ok(record, "client should appear in list");

  const getRes = await app.inject({
    method: "GET",
    path: `/admin/api-clients/${record.id}`,
    headers: bearer(jwt)
  });
  assert.equal(getRes.statusCode, 200, JSON.stringify(getRes.body));
  assert.equal(getRes.body.client_id, clientId);
  assert.ok(!("client_secret" in getRes.body), "client_secret must not appear in detail response");
  assert.ok(!("client_secret_hash" in getRes.body), "hash must not be exposed");
  assert.ok("scopes" in getRes.body);
  assert.ok("status" in getRes.body);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/api-clients/:id/rotate-secret — new secret, old invalidated
// ─────────────────────────────────────────────────────────────────────────────

test("POST rotate-secret: returns new client_secret; hash changes", async () => {
  const { app, jwt, state } = await appAs("platform_admin");

  const createRes = await app.inject({
    method: "POST",
    path: "/admin/api-clients",
    headers: bearer(jwt),
    body: { name: "Rotate Client", scopes: ["webhooks:write"] }
  });
  assert.equal(createRes.statusCode, 201, JSON.stringify(createRes.body));
  const originalSecret = createRes.body.client_secret;
  const clientId = createRes.body.client_id;

  const storedBefore = state.apiClients.find((c) => c.client_id === clientId);
  const hashBefore = storedBefore.client_secret_hash;

  const rotateRes = await app.inject({
    method: "POST",
    path: `/admin/api-clients/${storedBefore.id}/rotate-secret`,
    headers: bearer(jwt),
    body: {}
  });
  assert.equal(rotateRes.statusCode, 200, JSON.stringify(rotateRes.body));
  assert.ok(rotateRes.body.client_secret, "new secret should be returned");
  assert.notEqual(rotateRes.body.client_secret, originalSecret, "new secret must differ from old");

  const storedAfter = state.apiClients.find((c) => c.client_id === clientId);
  assert.notEqual(storedAfter.client_secret_hash, hashBefore, "hash must change after rotation");
  assert.equal(storedAfter.last_used_at, null, "last_used_at reset to null after rotation");
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/api-clients/:id/revoke — sets status revoked
// ─────────────────────────────────────────────────────────────────────────────

test("POST revoke: status becomes revoked", async () => {
  const { app, jwt } = await appAs("platform_admin");

  const createRes = await app.inject({
    method: "POST",
    path: "/admin/api-clients",
    headers: bearer(jwt),
    body: { name: "Revoke Client", scopes: ["interactions:read"] }
  });
  assert.equal(createRes.statusCode, 201, JSON.stringify(createRes.body));
  const clientId = createRes.body.client_id;

  const listRes = await app.inject({ method: "GET", path: "/admin/api-clients", headers: bearer(jwt) });
  const record = listRes.body.find((c) => c.client_id === clientId);

  const revokeRes = await app.inject({
    method: "POST",
    path: `/admin/api-clients/${record.id}/revoke`,
    headers: bearer(jwt),
    body: {}
  });
  assert.equal(revokeRes.statusCode, 200, JSON.stringify(revokeRes.body));
  assert.equal(revokeRes.body.status, "revoked");
  assert.equal(revokeRes.body.id, record.id);
});

test("POST revoke: revoked client cannot rotate secret", async () => {
  const { app, jwt } = await appAs("platform_admin");

  const createRes = await app.inject({
    method: "POST",
    path: "/admin/api-clients",
    headers: bearer(jwt),
    body: { name: "Revoke Rotate Client", scopes: ["events:read"] }
  });
  assert.equal(createRes.statusCode, 201, JSON.stringify(createRes.body));
  const clientId = createRes.body.client_id;
  const listRes = await app.inject({ method: "GET", path: "/admin/api-clients", headers: bearer(jwt) });
  const record = listRes.body.find((c) => c.client_id === clientId);

  await app.inject({ method: "POST", path: `/admin/api-clients/${record.id}/revoke`, headers: bearer(jwt), body: {} });

  const rotateRes = await app.inject({
    method: "POST",
    path: `/admin/api-clients/${record.id}/rotate-secret`,
    headers: bearer(jwt),
    body: {}
  });
  assert.equal(rotateRes.statusCode, 400, JSON.stringify(rotateRes.body));
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/api-clients — list by tenant
// ─────────────────────────────────────────────────────────────────────────────

test("GET /admin/api-clients: lists clients for tenant", async () => {
  const { app, jwt } = await appAs("platform_admin");

  await app.inject({
    method: "POST", path: "/admin/api-clients", headers: bearer(jwt),
    body: { name: "Client A", scopes: ["events:read"] }
  });
  await app.inject({
    method: "POST", path: "/admin/api-clients", headers: bearer(jwt),
    body: { name: "Client B", scopes: ["analytics:read"] }
  });

  const res = await app.inject({ method: "GET", path: "/admin/api-clients", headers: bearer(jwt) });
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length >= 2);
  for (const client of res.body) {
    assert.ok(!("client_secret" in client), "list must not expose secrets");
    assert.ok(!("client_secret_hash" in client), "list must not expose hash");
  }
});
