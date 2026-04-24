import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.mjs";
import { createSeedState } from "../src/store.mjs";
import { issuePlatformToken } from "../src/auth/platform-jwt.mjs";
import { buildUserPrincipal } from "../src/auth/principals.mjs";
import { enforceRoleScope } from "../src/policy.mjs";
import { HttpError } from "../src/http-error.mjs";
import { ERROR_CODES } from "../src/errors.mjs";

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
  return { app, user, jwt, state, secret, principal };
}

// Helper: build a minimal ctx for direct enforceRoleScope unit tests
function mockCtx({ role, event_ids = [], stall_ids = [], sponsor_package_ids = [], allowedRoles, params = {} }) {
  const principal = {
    role,
    event_ids,
    stall_ids,
    sponsor_package_ids,
    user_id: "u-test",
    actor_id: "u-test",
    tenant_id: "tenant-demo"
  };
  return {
    route: { id: "mock-route", allowedRoles },
    principal,
    params,
    resources: {},
    state: { organizations: [] },
    breakGlass: null
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 5.1 — Event scope enforcement
// ─────────────────────────────────────────────────────────────────────────────

test("vendor_manager with event AAA in JWT denied access to event BBB", async () => {
  const { app, jwt } = await appAs("vendor_manager");
  // vendor_manager has event_ids: ["event-demo"]; event-other is NOT in scope
  const res = await app.inject({
    method: "GET",
    path: "/events/event-other",
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 403, JSON.stringify(res.body));
  assert.ok(res.body.error.includes("EVENT_SCOPE_FORBIDDEN"));
});

test("vendor_manager with event AAA in JWT permitted access to event AAA", async () => {
  const { app, jwt } = await appAs("vendor_manager");
  // vendor_manager has event_ids: ["event-demo"]
  const res = await app.inject({
    method: "GET",
    path: "/events/event-demo",
    headers: bearer(jwt)
  });
  // Should reach the handler — 200 with event data
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.id, "event-demo");
});

test("platform_admin passes event scope check regardless of event_ids", async () => {
  const { app, jwt } = await appAs("platform_admin");
  // platform_admin has no event_ids but is exempt from scope check
  const res = await app.inject({
    method: "GET",
    path: "/events/event-other",
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});

test("organizer_admin with event AAA in JWT denied access to event BBB", async () => {
  const { app, jwt } = await appAs("organizer_admin");
  // organizer has event_ids: ["event-demo"]; event-other is NOT in scope
  const res = await app.inject({
    method: "GET",
    path: "/events/event-other",
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 403, JSON.stringify(res.body));
  assert.ok(res.body.error.includes("EVENT_SCOPE_FORBIDDEN"));
});

test("ops_user without event AAA in JWT denied access to event AAA", async () => {
  const state = createSeedState();
  const secret = state.sessionSecret;
  const user = state.users.find((u) => u.role === "ops_user");
  // ops_user has no role assignments in seed → event_ids = []
  const principal = buildUserPrincipal(user, [], []);
  assert.deepEqual(principal.event_ids, [], "ops_user should have no event_ids");
  const jwt = issuePlatformToken(principal, secret);
  const app = await createApp({ state });

  const res = await app.inject({
    method: "GET",
    path: "/events/event-demo",
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 403, JSON.stringify(res.body));
  assert.ok(res.body.error.includes("EVENT_SCOPE_FORBIDDEN"));
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 5.2 — Stall scope enforcement (vendor_manager)
// ─────────────────────────────────────────────────────────────────────────────

test("vendor_manager with stall SSS denied access to stall TTT", async () => {
  const { app, jwt } = await appAs("vendor_manager");
  // vendor_manager has stall_ids: ["stall-a1"]; stall-b1 is NOT in scope
  const res = await app.inject({
    method: "GET",
    path: "/stalls/stall-b1/leads",
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 403, JSON.stringify(res.body));
  assert.ok(res.body.error.includes("STALL_SCOPE_FORBIDDEN"));
});

test("vendor_manager with stall SSS permitted access to stall SSS", async () => {
  const { app, jwt } = await appAs("vendor_manager");
  // vendor_manager has stall_ids: ["stall-a1"]
  const res = await app.inject({
    method: "GET",
    path: "/stalls/stall-a1/leads",
    headers: bearer(jwt)
  });
  // Reaches handler — empty leads for this stall (no interactions in seed)
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 5.3 — Sponsor package scope enforcement (sponsor_user) — unit tests
// These test enforceRoleScope directly because no HTTP route currently exposes
// a :packageId param to sponsor_user (routes added in Phase 12/13).
// ─────────────────────────────────────────────────────────────────────────────

test("sponsor_user with package PPP denied access to package QQQ (unit test)", () => {
  const ctx = mockCtx({
    role: "sponsor_user",
    sponsor_package_ids: ["pkg-ppp"],
    allowedRoles: ["sponsor_user"],
    params: { packageId: "pkg-qqq" }
  });
  assert.throws(
    () => enforceRoleScope(ctx),
    (err) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.statusCode, 403);
      assert.ok(err.message.includes(ERROR_CODES.PACKAGE_SCOPE_FORBIDDEN));
      return true;
    }
  );
});

test("sponsor_user with package PPP permitted access to package PPP (unit test)", () => {
  const ctx = mockCtx({
    role: "sponsor_user",
    sponsor_package_ids: ["pkg-ppp"],
    allowedRoles: ["sponsor_user"],
    params: { packageId: "pkg-ppp" }
  });
  // Should not throw
  assert.doesNotThrow(() => enforceRoleScope(ctx));
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 5.4 — Error code constants are exported correctly
// ─────────────────────────────────────────────────────────────────────────────

test("ERROR_CODES exports all three Phase 5 scope error codes", () => {
  assert.equal(ERROR_CODES.EVENT_SCOPE_FORBIDDEN, "EVENT_SCOPE_FORBIDDEN");
  assert.equal(ERROR_CODES.STALL_SCOPE_FORBIDDEN, "STALL_SCOPE_FORBIDDEN");
  assert.equal(ERROR_CODES.PACKAGE_SCOPE_FORBIDDEN, "PACKAGE_SCOPE_FORBIDDEN");
});
