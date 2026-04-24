import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.mjs";
import { createSeedState } from "../src/store.mjs";
import { hashPassword } from "../src/auth/passwords.mjs";
import { issuePlatformToken } from "../src/auth/platform-jwt.mjs";
import { hashToken } from "../src/auth/invite-tokens.mjs";
import { buildUserPrincipal } from "../src/auth/principals.mjs";

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function appWithPasswordUser(overrides = {}) {
  const state = createSeedState();
  const secret = state.sessionSecret;
  const passwordHash = await hashPassword("ValidPass1");
  const user = state.users.find((u) => u.role === "organizer_admin");
  user.password_hash = passwordHash;
  Object.assign(user, overrides);
  const app = await createApp({ state });
  return { app, user, secret };
}

async function appWithInvitedUser() {
  const state = createSeedState();
  const secret = state.sessionSecret;
  const user = state.users.find((u) => u.role === "vendor_manager");
  const plaintext = "invite-plaintext-token-fixture";
  user.invitation_token_hash = hashToken(plaintext, secret);
  user.invitation_expires_at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  user.status = "pending_invite";
  const app = await createApp({ state });
  return { app, user, secret, plaintext };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2.1 — JWT payload fields
// ─────────────────────────────────────────────────────────────────────────────

test("JWT payload contains all 7 required fields", async () => {
  const state = createSeedState();
  const secret = state.sessionSecret;
  const user = state.users.find((u) => u.role === "organizer_admin");
  const principal = buildUserPrincipal(user, [], []);
  const token = issuePlatformToken(principal, secret);

  const parts = token.split(".");
  assert.equal(parts.length, 3, "token must be a 3-part JWT");
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());

  assert.ok("actor_id" in payload, "missing actor_id");
  assert.ok("tenant_id" in payload, "missing tenant_id");
  assert.ok("org_id" in payload, "missing org_id");
  assert.ok("roles" in payload, "missing roles");
  assert.ok("event_ids" in payload, "missing event_ids");
  assert.ok("stall_ids" in payload, "missing stall_ids");
  assert.ok("sponsor_package_ids" in payload, "missing sponsor_package_ids");

  assert.equal(typeof payload.actor_id, "string");
  assert.equal(typeof payload.tenant_id, "string");
  assert.ok(Array.isArray(payload.roles));
  assert.ok(Array.isArray(payload.event_ids));
  assert.ok(Array.isArray(payload.stall_ids));
  assert.ok(Array.isArray(payload.sponsor_package_ids));
});

test("JWT payload emits empty arrays when user has no role assignments", async () => {
  const state = createSeedState();
  const secret = state.sessionSecret;
  const user = state.users.find((u) => u.role === "ops_user");
  // No role assignments for ops user in seed
  const principal = buildUserPrincipal(user, [], []);
  const token = issuePlatformToken(principal, secret);
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());

  assert.deepEqual(payload.event_ids, []);
  assert.deepEqual(payload.stall_ids, []);
  assert.deepEqual(payload.sponsor_package_ids, []);
  // roles still contains the base role
  assert.ok(payload.roles.includes("ops_user"));
});

test("buildUserPrincipal merges role assignments into principal", () => {
  const state = createSeedState();
  const user = state.users.find((u) => u.role === "vendor_manager");
  const assignments = [
    {
      id: "ura-test",
      user_id: user.id,
      role: "vendor_manager",
      event_id: "event-demo",
      stall_ids: ["stall-a1", "stall-a2"],
      sponsor_package_id: null
    }
  ];
  const principal = buildUserPrincipal(user, [], assignments);
  assert.ok(principal.roles.includes("vendor_manager"));
  assert.ok(principal.event_ids.includes("event-demo"));
  assert.ok(principal.stall_ids.includes("stall-a1"));
  assert.ok(principal.stall_ids.includes("stall-a2"));
  assert.deepEqual(principal.sponsor_package_ids, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 2.3 — POST /auth/accept-invite
// ─────────────────────────────────────────────────────────────────────────────

test("accept-invite: valid token returns 200 with JWT", async () => {
  const { app, plaintext } = await appWithInvitedUser();
  const res = await app.inject({
    method: "POST",
    path: "/auth/accept-invite",
    body: { token: plaintext, password: "StrongPass1" }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(res.body.token, "should return a JWT token");
  assert.ok(typeof res.body.token === "string");
  // token must be a valid 3-part JWT
  assert.equal(res.body.token.split(".").length, 3);
});

test("accept-invite: expired token returns 400 INVITE_TOKEN_INVALID_OR_EXPIRED", async () => {
  const state = createSeedState();
  const secret = state.sessionSecret;
  const user = state.users.find((u) => u.role === "vendor_manager");
  const plaintext = "expired-token";
  user.invitation_token_hash = hashToken(plaintext, secret);
  // expired 1 hour ago
  user.invitation_expires_at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  user.status = "pending_invite";
  const app = await createApp({ state });

  const res = await app.inject({
    method: "POST",
    path: "/auth/accept-invite",
    body: { token: plaintext, password: "StrongPass1" }
  });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error.includes("INVITE_TOKEN_INVALID_OR_EXPIRED"));
});

test("accept-invite: weak password returns 400 PASSWORD_TOO_WEAK", async () => {
  const { app, plaintext } = await appWithInvitedUser();
  const res = await app.inject({
    method: "POST",
    path: "/auth/accept-invite",
    body: { token: plaintext, password: "weak" }
  });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error.includes("PASSWORD_TOO_WEAK"));
});

test("accept-invite: token is single-use — second attempt returns 400", async () => {
  const { app, plaintext } = await appWithInvitedUser();

  const first = await app.inject({
    method: "POST",
    path: "/auth/accept-invite",
    body: { token: plaintext, password: "StrongPass1" }
  });
  assert.equal(first.statusCode, 200);

  const second = await app.inject({
    method: "POST",
    path: "/auth/accept-invite",
    body: { token: plaintext, password: "StrongPass1" }
  });
  assert.equal(second.statusCode, 400);
  assert.ok(second.body.error.includes("INVITE_TOKEN_INVALID_OR_EXPIRED"));
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 2.5 — POST /auth/forgot-password
// ─────────────────────────────────────────────────────────────────────────────

test("forgot-password: always returns 200 regardless of email existence", async () => {
  const { app } = await appWithPasswordUser();

  const known = await app.inject({
    method: "POST",
    path: "/auth/forgot-password",
    body: { email: "organizer@example.com" }
  });
  assert.equal(known.statusCode, 200);
  assert.ok(known.body.message.includes("If an account exists"));

  const unknown = await app.inject({
    method: "POST",
    path: "/auth/forgot-password",
    body: { email: "nobody@nowhere.invalid" }
  });
  assert.equal(unknown.statusCode, 200);
  assert.equal(known.body.message, unknown.body.message);
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 2.5 — POST /auth/reset-password
// ─────────────────────────────────────────────────────────────────────────────

async function appWithResetToken() {
  const state = createSeedState();
  const secret = state.sessionSecret;
  const user = state.users.find((u) => u.role === "organizer_admin");
  const plaintext = "reset-token-fixture";
  user.password_reset_token_hash = hashToken(plaintext, secret);
  user.password_reset_expires_at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const app = await createApp({ state });
  return { app, user, secret, plaintext };
}

test("reset-password: valid token changes password, token no longer works", async () => {
  const { app, plaintext } = await appWithResetToken();

  const res = await app.inject({
    method: "POST",
    path: "/auth/reset-password",
    body: { token: plaintext, password: "NewStrongPass1" }
  });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.message.includes("reset successfully"));

  // Token is now consumed — second attempt should fail
  const retry = await app.inject({
    method: "POST",
    path: "/auth/reset-password",
    body: { token: plaintext, password: "NewStrongPass1" }
  });
  assert.equal(retry.statusCode, 400);
  assert.ok(retry.body.error.includes("RESET_TOKEN_INVALID_OR_EXPIRED"));
});

test("reset-password: expired token returns 400", async () => {
  const state = createSeedState();
  const secret = state.sessionSecret;
  const user = state.users.find((u) => u.role === "organizer_admin");
  const plaintext = "expired-reset-token";
  user.password_reset_token_hash = hashToken(plaintext, secret);
  user.password_reset_expires_at = new Date(Date.now() - 1000).toISOString();
  const app = await createApp({ state });

  const res = await app.inject({
    method: "POST",
    path: "/auth/reset-password",
    body: { token: plaintext, password: "NewStrongPass1" }
  });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error.includes("RESET_TOKEN_INVALID_OR_EXPIRED"));
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 2.5 — POST /auth/change-password
// ─────────────────────────────────────────────────────────────────────────────

test("change-password: correct current password succeeds", async () => {
  const { app, user, secret } = await appWithPasswordUser();
  const principal = buildUserPrincipal(user, [], []);
  const jwt = issuePlatformToken(principal, secret);

  const res = await app.inject({
    method: "POST",
    path: "/auth/change-password",
    headers: bearer(jwt),
    body: { current_password: "ValidPass1", new_password: "NewStrongPass2" }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(res.body.message.includes("Password updated"));
});

test("change-password: wrong current password returns 401", async () => {
  const { app, user, secret } = await appWithPasswordUser();
  const principal = buildUserPrincipal(user, [], []);
  const jwt = issuePlatformToken(principal, secret);

  const res = await app.inject({
    method: "POST",
    path: "/auth/change-password",
    headers: bearer(jwt),
    body: { current_password: "WrongPassword9", new_password: "NewStrongPass2" }
  });
  assert.equal(res.statusCode, 401);
  assert.ok(res.body.error.includes("CURRENT_PASSWORD_INCORRECT"));
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 2.4 — Redirect resolver
// ─────────────────────────────────────────────────────────────────────────────

test("redirect resolver: single role returns direct route", async () => {
  const { resolveRedirectTarget } = await import("../src/auth/redirect-resolver.mjs");
  const state = createSeedState();
  const app = await createApp({ state });

  // platform1 has one role assignment (platform_admin)
  const user = state.users.find((u) => u.role === "platform_admin");
  const result = await resolveRedirectTarget(user.id, user.tenant_id, app.repos);
  assert.equal(result.redirect_to, "/admin/tenants");
});

test("redirect resolver: no role assignments returns /onboarding/no-role", async () => {
  const { resolveRedirectTarget } = await import("../src/auth/redirect-resolver.mjs");
  const state = createSeedState();
  // Remove all assignments for ops user
  state.userRoleAssignments = state.userRoleAssignments.filter(
    (a) => state.users.find((u) => u.id === a.user_id)?.role !== "ops_user"
  );
  const app = await createApp({ state });
  const user = state.users.find((u) => u.role === "ops_user");
  const result = await resolveRedirectTarget(user.id, user.tenant_id, app.repos);
  assert.equal(result.redirect_to, "/onboarding/no-role");
});

test("redirect resolver: multiple events returns requires_context_selection", async () => {
  const { resolveRedirectTarget } = await import("../src/auth/redirect-resolver.mjs");
  const state = createSeedState();
  const user = state.users.find((u) => u.role === "organizer_admin");
  // Add a second assignment to a different event
  state.userRoleAssignments.push({
    id: "ura-organizer-event-other",
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
  const result = await resolveRedirectTarget(user.id, user.tenant_id, app.repos);
  assert.equal(result.requires_context_selection, true);
  assert.ok(Array.isArray(result.events));
  assert.ok(result.events.length >= 2);
});
