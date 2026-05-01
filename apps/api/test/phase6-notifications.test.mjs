import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.mjs";
import { createSeedState } from "../src/store.mjs";
import { issuePlatformToken } from "../src/auth/platform-jwt.mjs";
import { buildUserPrincipal } from "../src/auth/principals.mjs";
import { renderTemplate } from "../src/notification-templates.mjs";

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

// ─────────────────────────────────────────────────────────────────────────────
// Step 6.2-6.6 — Template unit tests
// ─────────────────────────────────────────────────────────────────────────────

test("renderTemplate: user_invitation has subject and body with invite_url", () => {
  const { subject, text, html } = renderTemplate("user_invitation", {
    display_name: "Alice",
    invite_url: "https://example.com/accept?token=abc123"
  });
  assert.ok(typeof subject === "string" && subject.length > 0);
  assert.ok(text.includes("Alice"));
  assert.ok(text.includes("https://example.com/accept?token=abc123"));
  assert.ok(html.includes("https://example.com/accept?token=abc123"));
  assert.ok(html.includes("Accept Invitation"));
});

test("renderTemplate: invite_expiry_reminder has subject and body with invite_url", () => {
  const { subject, text, html } = renderTemplate("invite_expiry_reminder", {
    display_name: "Bob",
    invite_url: "https://example.com/accept?token=xyz"
  });
  assert.ok(typeof subject === "string" && subject.length > 0);
  assert.ok(text.includes("Bob"));
  assert.ok(text.includes("https://example.com/accept?token=xyz"));
  assert.ok(html.includes("https://example.com/accept?token=xyz"));
  assert.ok(html.includes("Accept Invitation"));
});

test("renderTemplate: account_activated has subject and body with login_url", () => {
  const { subject, body } = renderTemplate("account_activated", {
    display_name: "Carol",
    login_url: "https://example.com/login"
  });
  assert.ok(typeof subject === "string" && subject.length > 0);
  assert.ok(body.includes("Carol"));
  assert.ok(body.includes("https://example.com/login"));
});

test("renderTemplate: password_reset has subject and body with reset_url", () => {
  const { subject, body } = renderTemplate("password_reset", {
    display_name: "Dan",
    reset_url: "https://example.com/reset?token=tok"
  });
  assert.ok(typeof subject === "string" && subject.length > 0);
  assert.ok(body.includes("Dan"));
  assert.ok(body.includes("https://example.com/reset?token=tok"));
});

test("renderTemplate: break_glass_pending_approval has subject and justification in body", () => {
  const { subject, body } = renderTemplate("break_glass_pending_approval", {
    requester_name: "Priya Platform",
    justification: "Emergency audit access needed"
  });
  assert.ok(typeof subject === "string" && subject.toLowerCase().includes("break-glass"));
  assert.ok(body.includes("Priya Platform"));
  assert.ok(body.includes("Emergency audit access needed"));
});

test("renderTemplate: unknown type throws", () => {
  assert.throws(
    () => renderTemplate("nonexistent_type", {}),
    (err) => {
      assert.ok(err.message.includes("Unknown notification template"));
      return true;
    }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 6.7 — Dispatch wired into routes: notification records appear in state
// ─────────────────────────────────────────────────────────────────────────────

test("POST /users/invite dispatches user_invitation notification", async () => {
  const { app, jwt, state } = await appAs("platform_admin");

  const res = await app.inject({
    method: "POST",
    path: "/users/invite",
    headers: bearer(jwt),
    body: { email: "newuser@example.com", display_name: "New User", role: "platform_admin" }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));

  const notif = state.notifications.find((n) => n.message_type === "user_invitation");
  assert.ok(notif, "user_invitation notification should be in state.notifications");
  assert.equal(notif.channel, "email");
  assert.equal(notif.status, "queued");
  assert.equal(notif.event_id, null);
  assert.equal(notif.system_payload.recipient_email, "newuser@example.com");
  assert.ok(notif.system_payload.subject.length > 0);
  assert.ok(notif.system_payload.body.includes("New User"));
});

test("POST /auth/forgot-password dispatches password_reset notification", async () => {
  const state = createSeedState();
  const app = await createApp({ state });

  const res = await app.inject({
    method: "POST",
    path: "/auth/forgot-password",
    body: { email: "platform1@example.com" }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));

  const notif = state.notifications.find((n) => n.message_type === "password_reset");
  assert.ok(notif, "password_reset notification should be in state.notifications");
  assert.equal(notif.channel, "email");
  assert.equal(notif.status, "queued");
  assert.equal(notif.event_id, null);
  assert.equal(notif.system_payload.recipient_email, "platform1@example.com");
  assert.ok(notif.system_payload.body.includes("Priya Platform"));
});

test("POST /auth/forgot-password for unknown email does not dispatch", async () => {
  const state = createSeedState();
  const app = await createApp({ state });

  const res = await app.inject({
    method: "POST",
    path: "/auth/forgot-password",
    body: { email: "nobody@example.com" }
  });
  assert.equal(res.statusCode, 200);
  const notif = state.notifications.find((n) => n.message_type === "password_reset");
  assert.equal(notif, undefined, "No notification for unknown email");
});

test("POST /auth/accept-invite dispatches account_activated notification", async () => {
  const state = createSeedState();
  const app = await createApp({ state });

  // First invite a user via platform_admin
  const platformUser = state.users.find((u) => u.role === "platform_admin");
  const platformAssignments = state.userRoleAssignments.filter((a) => a.user_id === platformUser.id);
  const platformPrincipal = buildUserPrincipal(platformUser, [], platformAssignments);
  const platformJwt = issuePlatformToken(platformPrincipal, state.sessionSecret);

  const inviteRes = await app.inject({
    method: "POST",
    path: "/users/invite",
    headers: bearer(platformJwt),
    body: { email: "newactivated@example.com", display_name: "Activated User", role: "platform_admin" }
  });
  assert.equal(inviteRes.statusCode, 200, JSON.stringify(inviteRes.body));
  const { invite_token } = inviteRes.body;

  const beforeCount = state.notifications.filter((n) => n.message_type === "account_activated").length;

  const acceptRes = await app.inject({
    method: "POST",
    path: "/auth/accept-invite",
    body: { token: invite_token, password: "ValidPass123!" }
  });
  assert.equal(acceptRes.statusCode, 200, JSON.stringify(acceptRes.body));

  const notifs = state.notifications.filter((n) => n.message_type === "account_activated");
  assert.equal(notifs.length, beforeCount + 1, "account_activated notification should appear");
  const notif = notifs.at(-1);
  assert.equal(notif.channel, "email");
  assert.equal(notif.system_payload.recipient_email, "newactivated@example.com");
  assert.ok(notif.system_payload.body.includes("Activated User"));
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 6.8 — Resend-invite dispatch
// ─────────────────────────────────────────────────────────────────────────────

test("POST /users/:id/resend-invite dispatches user_invitation notification", async () => {
  const { app, jwt, state } = await appAs("platform_admin");

  // Invite a user first
  const inviteRes = await app.inject({
    method: "POST",
    path: "/users/invite",
    headers: bearer(jwt),
    body: { email: "resendinvite@example.com", display_name: "Resend Target", role: "platform_admin" }
  });
  assert.equal(inviteRes.statusCode, 200, JSON.stringify(inviteRes.body));
  const { user_id } = inviteRes.body;

  const beforeCount = state.notifications.filter((n) => n.message_type === "user_invitation").length;

  const resendRes = await app.inject({
    method: "POST",
    path: `/users/${user_id}/resend-invite`,
    headers: bearer(jwt),
    body: {}
  });
  assert.equal(resendRes.statusCode, 200, JSON.stringify(resendRes.body));

  const notifs = state.notifications.filter((n) => n.message_type === "user_invitation");
  assert.equal(notifs.length, beforeCount + 1, "Second user_invitation notification should appear after resend");
  const notif = notifs.at(-1);
  assert.equal(notif.system_payload.recipient_email, "resendinvite@example.com");
  assert.ok(notif.system_payload.body.includes("Resend Target"));
});

// ─────────────────────────────────────────────────────────────────────────────
// Notification record shape validation
// ─────────────────────────────────────────────────────────────────────────────

test("transactional notification record has required fields", async () => {
  const state = createSeedState();
  const app = await createApp({ state });

  const platformUser = state.users.find((u) => u.role === "platform_admin");
  const platformAssignments = state.userRoleAssignments.filter((a) => a.user_id === platformUser.id);
  const platformPrincipal = buildUserPrincipal(platformUser, [], platformAssignments);
  const jwt = issuePlatformToken(platformPrincipal, state.sessionSecret);

  await app.inject({
    method: "POST",
    path: "/users/invite",
    headers: bearer(jwt),
    body: { email: "shapecheck@example.com", display_name: "Shape Check", role: "platform_admin" }
  });

  const notif = state.notifications.find((n) => n.system_payload?.recipient_email === "shapecheck@example.com");
  assert.ok(notif);
  assert.ok(typeof notif.id === "string");
  assert.ok(typeof notif.tenant_id === "string");
  assert.equal(notif.event_id, null);
  assert.equal(notif.interaction_id, null);
  assert.equal(notif.channel, "email");
  assert.equal(notif.status, "queued");
  assert.ok(typeof notif.recipient_hash === "string" && notif.recipient_hash.length === 64);
  assert.ok(notif.system_payload.subject);
  assert.ok(notif.system_payload.body);
  assert.ok(notif.created_at);
  assert.ok(notif.updated_at);
});
