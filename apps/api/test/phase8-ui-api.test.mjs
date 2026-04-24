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
// Step 8.11 — GET /auth/invite-info
// ─────────────────────────────────────────────────────────────────────────────

test("GET /auth/invite-info returns full_name and email for valid pending invite token", async () => {
  const { app, jwt } = await appAs("platform_admin");

  // Create an invite to get a fresh token
  const inviteRes = await app.inject({
    method: "POST",
    path: "/users/invite",
    headers: bearer(jwt),
    body: {
      email: "invite-info-test@example.com",
      display_name: "Info Test User",
      role: "platform_admin"
    }
  });
  assert.equal(inviteRes.statusCode, 200, JSON.stringify(inviteRes.body));
  const { invite_token } = inviteRes.body;
  assert.ok(invite_token, "invite_token should be returned");

  const infoRes = await app.inject({
    method: "GET",
    path: `/auth/invite-info?token=${encodeURIComponent(invite_token)}`
  });
  assert.equal(infoRes.statusCode, 200, JSON.stringify(infoRes.body));
  assert.equal(infoRes.body.full_name, "Info Test User");
  assert.equal(infoRes.body.email, "invite-info-test@example.com");
});

test("GET /auth/invite-info returns 404 for an unknown token", async () => {
  const { app } = await appAs("platform_admin");

  const res = await app.inject({
    method: "GET",
    path: "/auth/invite-info?token=invalid-token-that-does-not-exist"
  });
  assert.equal(res.statusCode, 404, JSON.stringify(res.body));
});

test("GET /auth/invite-info returns 400 when token query param is missing", async () => {
  const { app } = await appAs("platform_admin");

  const res = await app.inject({
    method: "GET",
    path: "/auth/invite-info"
  });
  assert.equal(res.statusCode, 400, JSON.stringify(res.body));
});

test("GET /auth/invite-info returns 404 after invite has been accepted (status no longer pending_invite)", async () => {
  const { app, jwt } = await appAs("platform_admin");

  const inviteRes = await app.inject({
    method: "POST",
    path: "/users/invite",
    headers: bearer(jwt),
    body: {
      email: "invite-info-accepted@example.com",
      display_name: "Accepted User",
      role: "platform_admin"
    }
  });
  assert.equal(inviteRes.statusCode, 200);
  const { invite_token } = inviteRes.body;

  // Accept the invite to consume the token
  const acceptRes = await app.inject({
    method: "POST",
    path: "/auth/accept-invite",
    body: { token: invite_token, password: "ValidPass123!" }
  });
  assert.equal(acceptRes.statusCode, 200, JSON.stringify(acceptRes.body));

  // Now the invite-info endpoint should return 404 (user status is "active" now)
  const infoRes = await app.inject({
    method: "GET",
    path: `/auth/invite-info?token=${encodeURIComponent(invite_token)}`
  });
  assert.equal(infoRes.statusCode, 404, JSON.stringify(infoRes.body));
});
