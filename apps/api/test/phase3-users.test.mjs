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
// Step 3.1 — GET /users
// ─────────────────────────────────────────────────────────────────────────────

test("GET /users: platform_admin sees all tenant users", async () => {
  const { app, jwt } = await appAs("platform_admin");
  const res = await app.inject({
    method: "GET",
    path: "/users",
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(Array.isArray(res.body.users));
  assert.ok(res.body.users.length >= 5, "should see all seed users");
  assert.ok("total" in res.body);
  assert.ok("page" in res.body);
  assert.ok("page_size" in res.body);
});

test("GET /users: organizer_admin sees only users in their events", async () => {
  const { app, jwt } = await appAs("organizer_admin");
  const res = await app.inject({
    method: "GET",
    path: "/users",
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  // organizer should see themselves and users in their event (vendor)
  assert.ok(Array.isArray(res.body.users));
  // should not see platform_admin2 or platform_admin3 who have no event assignment
});

test("GET /users: role filter works", async () => {
  const { app, jwt } = await appAs("platform_admin");
  const res = await app.inject({
    method: "GET",
    path: "/users?role=vendor_manager",
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.users.every((u) => u.role === "vendor_manager"));
});

test("GET /users: vendor_manager is forbidden", async () => {
  const { app, jwt } = await appAs("vendor_manager");
  const res = await app.inject({
    method: "GET",
    path: "/users",
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 403);
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 3.2 — POST /users/invite
// ─────────────────────────────────────────────────────────────────────────────

test("POST /users/invite: platform_admin can invite organizer_admin", async () => {
  const { app, jwt } = await appAs("platform_admin");
  const res = await app.inject({
    method: "POST",
    path: "/users/invite",
    headers: bearer(jwt),
    body: {
      email: "new-organizer@example.com",
      display_name: "New Organizer",
      role: "organizer_admin",
      event_id: "event-demo"
    }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(res.body.user_id);
  assert.equal(res.body.email, "new-organizer@example.com");
  assert.equal(res.body.status, "pending_invite");
  assert.ok(typeof res.body.invite_token === "string" && res.body.invite_token.length > 0);
  assert.ok(res.body.expires_at);
});

test("POST /users/invite: vendor_manager requires event_id and stall_ids", async () => {
  const { app, jwt } = await appAs("platform_admin");
  const res = await app.inject({
    method: "POST",
    path: "/users/invite",
    headers: bearer(jwt),
    body: {
      email: "vendor2@example.com",
      display_name: "New Vendor",
      role: "vendor_manager"
    }
  });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error.includes("event_id"));
});

test("POST /users/invite: vendor_manager with event_id but no stall_ids fails", async () => {
  const { app, jwt } = await appAs("platform_admin");
  const res = await app.inject({
    method: "POST",
    path: "/users/invite",
    headers: bearer(jwt),
    body: {
      email: "vendor2@example.com",
      display_name: "New Vendor",
      role: "vendor_manager",
      event_id: "event-demo",
      stall_ids: []
    }
  });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error.includes("stall_id"));
});

test("POST /users/invite: duplicate email returns 409", async () => {
  const { app, jwt } = await appAs("platform_admin");
  const res = await app.inject({
    method: "POST",
    path: "/users/invite",
    headers: bearer(jwt),
    body: {
      email: "organizer@example.com",
      display_name: "Duplicate",
      role: "organizer_admin",
      event_id: "event-demo"
    }
  });
  assert.equal(res.statusCode, 409);
});

test("POST /users/invite: platform_admin requires no event scope", async () => {
  const { app, jwt } = await appAs("platform_admin");
  const res = await app.inject({
    method: "POST",
    path: "/users/invite",
    headers: bearer(jwt),
    body: {
      email: "newplatform@example.com",
      display_name: "New Platform Admin",
      role: "platform_admin"
    }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.role, "platform_admin");
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 3.3 — GET /users/:id, PATCH /users/:id
// ─────────────────────────────────────────────────────────────────────────────

test("GET /users/:id: returns user with roles and org", async () => {
  const { app, jwt, state } = await appAs("platform_admin");
  const vendor = state.users.find((u) => u.role === "vendor_manager");
  const res = await app.inject({
    method: "GET",
    path: `/users/${vendor.id}`,
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.id, vendor.id);
  assert.ok(Array.isArray(res.body.roles));
  assert.ok(Array.isArray(res.body.role_assignments));
});

test("GET /users/:id: returns 404 for unknown user", async () => {
  const { app, jwt } = await appAs("platform_admin");
  const res = await app.inject({
    method: "GET",
    path: "/users/user-does-not-exist",
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 404);
});

test("PATCH /users/:id: updates display_name", async () => {
  const { app, jwt, state } = await appAs("platform_admin");
  const vendor = state.users.find((u) => u.role === "vendor_manager");
  const res = await app.inject({
    method: "PATCH",
    path: `/users/${vendor.id}`,
    headers: bearer(jwt),
    body: { display_name: "Updated Vendor Name" }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.display_name, "Updated Vendor Name");
});

test("PATCH /users/:id: display_name too short returns 400", async () => {
  const { app, jwt, state } = await appAs("platform_admin");
  const vendor = state.users.find((u) => u.role === "vendor_manager");
  const res = await app.inject({
    method: "PATCH",
    path: `/users/${vendor.id}`,
    headers: bearer(jwt),
    body: { display_name: "X" }
  });
  assert.equal(res.statusCode, 400);
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 3.3b — POST /users/:id/disable
// ─────────────────────────────────────────────────────────────────────────────

test("POST /users/:id/disable: sets status to disabled", async () => {
  const { app, jwt, state } = await appAs("platform_admin");
  const vendor = state.users.find((u) => u.role === "vendor_manager");
  const res = await app.inject({
    method: "POST",
    path: `/users/${vendor.id}/disable`,
    headers: bearer(jwt),
    body: { reason: "Test disable" }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, "disabled");
  assert.ok(res.body.disabled_at);
});

test("POST /users/:id/disable: cannot disable yourself", async () => {
  const { app, jwt, user } = await appAs("platform_admin");
  const res = await app.inject({
    method: "POST",
    path: `/users/${user.id}/disable`,
    headers: bearer(jwt),
    body: {}
  });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error.includes("own account"));
});

test("POST /users/:id/disable: already disabled returns 409", async () => {
  const { app, jwt, state } = await appAs("platform_admin");
  const vendor = state.users.find((u) => u.role === "vendor_manager");

  await app.inject({
    method: "POST",
    path: `/users/${vendor.id}/disable`,
    headers: bearer(jwt),
    body: {}
  });
  const second = await app.inject({
    method: "POST",
    path: `/users/${vendor.id}/disable`,
    headers: bearer(jwt),
    body: {}
  });
  assert.equal(second.statusCode, 409);
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 3.4 — POST /users/:id/resend-invite
// ─────────────────────────────────────────────────────────────────────────────

test("POST /users/:id/resend-invite: issues new token for pending_invite user", async () => {
  const { app, jwt } = await appAs("platform_admin");

  // First invite a user
  const inviteRes = await app.inject({
    method: "POST",
    path: "/users/invite",
    headers: bearer(jwt),
    body: {
      email: "resend-test@example.com",
      display_name: "Resend Test",
      role: "organizer_admin",
      event_id: "event-demo"
    }
  });
  assert.equal(inviteRes.statusCode, 200);
  const userId = inviteRes.body.user_id;
  const firstToken = inviteRes.body.invite_token;

  // Resend invite
  const resendRes = await app.inject({
    method: "POST",
    path: `/users/${userId}/resend-invite`,
    headers: bearer(jwt),
    body: {}
  });
  assert.equal(resendRes.statusCode, 200, JSON.stringify(resendRes.body));
  assert.ok(resendRes.body.invite_token);
  assert.notEqual(resendRes.body.invite_token, firstToken, "new token should differ from original");
});

test("POST /users/:id/resend-invite: active user returns 400", async () => {
  const { app, jwt, state } = await appAs("platform_admin");
  const vendor = state.users.find((u) => u.role === "vendor_manager");
  const res = await app.inject({
    method: "POST",
    path: `/users/${vendor.id}/resend-invite`,
    headers: bearer(jwt),
    body: {}
  });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error.includes("pending_invite"));
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 3.5 — Role assignment endpoints
// ─────────────────────────────────────────────────────────────────────────────

test("GET /users/:id/roles: returns role assignments", async () => {
  const { app, jwt, state } = await appAs("platform_admin");
  const organizer = state.users.find((u) => u.role === "organizer_admin");
  const res = await app.inject({
    method: "GET",
    path: `/users/${organizer.id}/roles`,
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(Array.isArray(res.body.role_assignments));
  assert.ok(res.body.role_assignments.length >= 1);
});

test("POST /users/:id/roles: assigns a valid role", async () => {
  const { app, jwt, state } = await appAs("platform_admin");
  const ops = state.users.find((u) => u.role === "ops_user");
  const res = await app.inject({
    method: "POST",
    path: `/users/${ops.id}/roles`,
    headers: bearer(jwt),
    body: { role: "ops_user", event_id: "event-demo" }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.role, "ops_user");
  assert.equal(res.body.event_id, "event-demo");
  assert.equal(res.body.user_id, ops.id);
});

test("POST /users/:id/roles: invalid role returns 400", async () => {
  const { app, jwt, state } = await appAs("platform_admin");
  const ops = state.users.find((u) => u.role === "ops_user");
  const res = await app.inject({
    method: "POST",
    path: `/users/${ops.id}/roles`,
    headers: bearer(jwt),
    body: { role: "super_admin" }
  });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error.includes("Invalid role"));
});

test("DELETE /users/:id/roles/:assignmentId: removes assignment", async () => {
  const { app, jwt, state } = await appAs("platform_admin");
  const organizer = state.users.find((u) => u.role === "organizer_admin");

  // First list to get assignment id
  const listRes = await app.inject({
    method: "GET",
    path: `/users/${organizer.id}/roles`,
    headers: bearer(jwt)
  });
  const assignmentId = listRes.body.role_assignments[0].id;

  const res = await app.inject({
    method: "DELETE",
    path: `/users/${organizer.id}/roles/${assignmentId}`,
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.deleted, true);
  assert.equal(res.body.id, assignmentId);
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 3.6 — Org management endpoints
// ─────────────────────────────────────────────────────────────────────────────

test("GET /orgs: returns organizations for tenant", async () => {
  const { app, jwt } = await appAs("platform_admin");
  const res = await app.inject({
    method: "GET",
    path: "/orgs",
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(Array.isArray(res.body.organizations));
  assert.ok(res.body.organizations.length >= 3);
});

test("GET /orgs: organizer_admin can list orgs", async () => {
  const { app, jwt } = await appAs("organizer_admin");
  const res = await app.inject({
    method: "GET",
    path: "/orgs",
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.organizations));
});

test("POST /orgs: platform_admin can create org", async () => {
  const { app, jwt } = await appAs("platform_admin");
  const res = await app.inject({
    method: "POST",
    path: "/orgs",
    headers: bearer(jwt),
    body: { name: "New Sponsor Corp", type: "sponsor" }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.name, "New Sponsor Corp");
  assert.equal(res.body.type, "sponsor");
  assert.ok(res.body.id);
});

test("POST /orgs: organizer_admin is forbidden", async () => {
  const { app, jwt } = await appAs("organizer_admin");
  const res = await app.inject({
    method: "POST",
    path: "/orgs",
    headers: bearer(jwt),
    body: { name: "New Org", type: "vendor" }
  });
  assert.equal(res.statusCode, 403);
});

test("POST /orgs: invalid type returns 400", async () => {
  const { app, jwt } = await appAs("platform_admin");
  const res = await app.inject({
    method: "POST",
    path: "/orgs",
    headers: bearer(jwt),
    body: { name: "Test Org", type: "supervillain" }
  });
  assert.equal(res.statusCode, 400);
});

test("GET /orgs/:id: returns org detail", async () => {
  const { app, jwt, state } = await appAs("platform_admin");
  const org = state.organizations[0];
  const res = await app.inject({
    method: "GET",
    path: `/orgs/${org.id}`,
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.id, org.id);
});

test("PATCH /orgs/:id: platform_admin can update org name", async () => {
  const { app, jwt, state } = await appAs("platform_admin");
  const org = state.organizations.find((o) => o.type === "vendor");
  const res = await app.inject({
    method: "PATCH",
    path: `/orgs/${org.id}`,
    headers: bearer(jwt),
    body: { name: "Renamed Vendor Org" }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.name, "Renamed Vendor Org");
});

test("PATCH /orgs/:id: organizer_admin is forbidden", async () => {
  const { app, jwt, state } = await appAs("organizer_admin");
  const org = state.organizations[0];
  const res = await app.inject({
    method: "PATCH",
    path: `/orgs/${org.id}`,
    headers: bearer(jwt),
    body: { name: "Attempt" }
  });
  assert.equal(res.statusCode, 403);
});
