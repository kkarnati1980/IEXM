import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.mjs";
import { createSeedState } from "../src/store.mjs";
import { issuePlatformToken } from "../src/auth/platform-jwt.mjs";
import { buildUserPrincipal } from "../src/auth/principals.mjs";
import { hashPassword } from "../src/auth/passwords.mjs";

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

async function appWithLoginUser(role = "platform_admin") {
  const state = createSeedState();
  const passwordHash = await hashPassword("ValidPass1!");
  const user = state.users.find((u) => u.role === role);
  user.password_hash = passwordHash;
  const app = await createApp({ state });
  return { app, user, state };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 11.1 — POST /auth/login extended response
// ─────────────────────────────────────────────────────────────────────────────

test("POST /auth/login: returns token, user, and redirect_to for platform_admin", async () => {
  const { app, user } = await appWithLoginUser("platform_admin");
  const res = await app.inject({
    method: "POST",
    path: "/auth/login",
    body: { email: user.email, password: "ValidPass1!" }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(res.body.token, "token should be returned");
  assert.ok(res.body.user, "user object should be returned");
  assert.equal(res.body.user.email, user.email);
  assert.ok("full_name" in res.body.user);
  assert.ok("id" in res.body.user);
  assert.equal(res.body.redirect_to, "/admin/tenants");
});

test("POST /auth/login: returns token and redirect_to for organizer_admin", async () => {
  const { app, user } = await appWithLoginUser("organizer_admin");
  const res = await app.inject({
    method: "POST",
    path: "/auth/login",
    body: { email: user.email, password: "ValidPass1!" }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(res.body.token);
  assert.equal(res.body.redirect_to, "/organizer/events");
  assert.ok(res.body.user.role === "organizer_admin");
});

test("POST /auth/login: returns requires_context_selection when user has multiple events", async () => {
  const state = createSeedState();
  const passwordHash = await hashPassword("ValidPass1!");
  const user = state.users.find((u) => u.role === "organizer_admin");
  user.password_hash = passwordHash;
  // Add second event assignment
  state.userRoleAssignments.push({
    id: "ura-organizer-event-other-login",
    tenant_id: user.tenant_id,
    user_id: user.id,
    role: "organizer_admin",
    event_id: "event-other",
    stall_ids: [],
    sponsor_package_id: null,
    assigned_by_user_id: user.id,
    created_at: new Date().toISOString()
  });
  const app = await createApp({ state });

  const res = await app.inject({
    method: "POST",
    path: "/auth/login",
    body: { email: user.email, password: "ValidPass1!" }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(res.body.token);
  assert.equal(res.body.requires_context_selection, true);
  assert.ok(Array.isArray(res.body.events));
  assert.ok(res.body.events.length >= 2, "should list multiple events");
  assert.ok(!res.body.redirect_to, "redirect_to should not be set when context selection needed");
});

test("POST /auth/login: returns 401 for wrong password", async () => {
  const { app, user } = await appWithLoginUser("platform_admin");
  const res = await app.inject({
    method: "POST",
    path: "/auth/login",
    body: { email: user.email, password: "WrongPassword!" }
  });
  assert.equal(res.statusCode, 401, JSON.stringify(res.body));
});

test("POST /auth/login: returns 403 for disabled user", async () => {
  const state = createSeedState();
  const passwordHash = await hashPassword("ValidPass1!");
  const user = state.users.find((u) => u.role === "organizer_admin");
  user.password_hash = passwordHash;
  user.status = "disabled";
  const app = await createApp({ state });

  const res = await app.inject({
    method: "POST",
    path: "/auth/login",
    body: { email: user.email, password: "ValidPass1!" }
  });
  assert.equal(res.statusCode, 403, JSON.stringify(res.body));
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveRedirectTarget: all roles
// ─────────────────────────────────────────────────────────────────────────────

test("resolveRedirectTarget: platform_admin → /admin/tenants", async () => {
  const { resolveRedirectTarget } = await import("../src/auth/redirect-resolver.mjs");
  const state = createSeedState();
  const app = await createApp({ state });
  const user = state.users.find((u) => u.role === "platform_admin");
  const result = await resolveRedirectTarget(user.id, user.tenant_id, app.repos);
  assert.equal(result.redirect_to, "/admin/tenants");
});

test("resolveRedirectTarget: organizer_admin with 1 event → /organizer/events", async () => {
  const { resolveRedirectTarget } = await import("../src/auth/redirect-resolver.mjs");
  const state = createSeedState();
  const app = await createApp({ state });
  const user = state.users.find((u) => u.role === "organizer_admin");
  const result = await resolveRedirectTarget(user.id, user.tenant_id, app.repos);
  assert.equal(result.redirect_to, "/organizer/events");
});

test("resolveRedirectTarget: vendor_manager → /vendor/inbox", async () => {
  const { resolveRedirectTarget } = await import("../src/auth/redirect-resolver.mjs");
  const state = createSeedState();
  const app = await createApp({ state });
  const user = state.users.find((u) => u.role === "vendor_manager");
  const result = await resolveRedirectTarget(user.id, user.tenant_id, app.repos);
  assert.equal(result.redirect_to, "/vendor/inbox");
});

test("resolveRedirectTarget: no role assignments → /onboarding/no-role", async () => {
  const { resolveRedirectTarget } = await import("../src/auth/redirect-resolver.mjs");
  const state = createSeedState();
  // Clear all assignments for ops_user
  const user = state.users.find((u) => u.role === "ops_user");
  state.userRoleAssignments = state.userRoleAssignments.filter((a) => a.user_id !== user.id);
  const app = await createApp({ state });
  const result = await resolveRedirectTarget(user.id, user.tenant_id, app.repos);
  assert.equal(result.redirect_to, "/onboarding/no-role");
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /stalls/:id/users — scoped vendor manager list
// ─────────────────────────────────────────────────────────────────────────────

test("GET /stalls/:id/users: returns only vendor_managers scoped to this stall", async () => {
  const { app, jwt, state } = await appAs("organizer_admin");
  const stall = state.stalls[0];

  const res = await app.inject({
    method: "GET",
    path: `/stalls/${stall.id}/users`,
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(Array.isArray(res.body.users), "should return users array");

  // Verify all returned users have vendor_manager role assignment to this stall
  for (const u of res.body.users) {
    assert.ok("id" in u);
    assert.ok("email" in u);
    assert.ok("assignment_id" in u);
    const assignment = state.userRoleAssignments.find((a) => a.id === u.assignment_id);
    assert.ok(assignment, "assignment_id should reference real assignment");
    assert.equal(assignment.role, "vendor_manager");
    assert.ok(assignment.stall_ids.includes(stall.id), "stall_ids must include this stall");
  }
});

test("GET /stalls/:id/users: does not return vendor_managers scoped to other stalls", async () => {
  const { app, jwt, state } = await appAs("organizer_admin");
  const stalls = state.stalls;
  if (stalls.length < 2) return; // skip if only one stall

  const stall1 = stalls[0];
  const stall2 = stalls[1];

  // Ensure a vendor_manager exists only for stall2
  const vendorUser = state.users.find((u) => u.role === "vendor_manager");
  const assignment = state.userRoleAssignments.find(
    (a) => a.user_id === vendorUser.id && a.role === "vendor_manager"
  );
  if (assignment) {
    // Make sure vendor is only in stall2, not stall1
    assignment.stall_ids = [stall2.id];
  }

  const res = await app.inject({
    method: "GET",
    path: `/stalls/${stall1.id}/users`,
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const userIds = res.body.users.map((u) => u.id);
  assert.ok(!userIds.includes(vendorUser.id), "vendor scoped to stall2 must not appear for stall1");
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /sponsor-packages/:id/users — scoped sponsor user list
// ─────────────────────────────────────────────────────────────────────────────

test("GET /sponsor-packages/:id/users: returns only sponsor_users scoped to this package", async () => {
  const { app, jwt, state } = await appAs("organizer_admin");

  // Create a sponsor package first
  const event = state.events.find((e) => e.status === "draft" || e.status === "live" || e.status === "published");
  const pkg = {
    id: "pkg-test-scope",
    tenant_id: state.tenants[0].id,
    event_id: event.id,
    name: "Test Package",
    tier: "gold",
    sponsor_organization_id: null,
    created_at: new Date().toISOString()
  };
  state.sponsorPackages.push(pkg);

  // Create a sponsor_user assignment to this package
  const sponsorUser = state.users.find((u) => u.role === "sponsor_user");
  const testAssignment = {
    id: "ura-sponsor-pkg-test",
    tenant_id: state.tenants[0].id,
    user_id: sponsorUser.id,
    role: "sponsor_user",
    event_id: event.id,
    stall_ids: [],
    sponsor_package_id: pkg.id,
    assigned_by_user_id: state.users.find((u) => u.role === "organizer_admin").id,
    created_at: new Date().toISOString()
  };
  state.userRoleAssignments.push(testAssignment);

  const res = await app.inject({
    method: "GET",
    path: `/sponsor-packages/${pkg.id}/users`,
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(Array.isArray(res.body.users));
  const found = res.body.users.find((u) => u.id === sponsorUser.id);
  assert.ok(found, "sponsor user should appear in the package users list");
  assert.equal(found.assignment_id, testAssignment.id);
});

test("GET /sponsor-packages/:id/users: does not return sponsor_users from other packages", async () => {
  const { app, jwt, state } = await appAs("organizer_admin");

  const event = state.events[0];
  const pkg = {
    id: "pkg-test-isolation",
    tenant_id: state.tenants[0].id,
    event_id: event.id,
    name: "Isolated Package",
    tier: "silver",
    sponsor_organization_id: null,
    created_at: new Date().toISOString()
  };
  state.sponsorPackages.push(pkg);

  // Do NOT add any assignment to this package
  const sponsorUser = state.users.find((u) => u.role === "sponsor_user");

  const res = await app.inject({
    method: "GET",
    path: `/sponsor-packages/${pkg.id}/users`,
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const userIds = res.body.users.map((u) => u.id);
  assert.ok(!userIds.includes(sponsorUser.id), "sponsor user from another package must not appear");
});
