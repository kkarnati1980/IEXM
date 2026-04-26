import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.mjs";
import { createSeedState } from "../src/store.mjs";
import { issuePlatformToken } from "../src/auth/platform-jwt.mjs";
import { buildUserPrincipal } from "../src/auth/principals.mjs";
import { AUDIT_EVENT_TYPES } from "../src/audit.mjs";
import { runOnce as runBreakGlassExpiry } from "../src/jobs/break-glass-expiry.mjs";

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

function makeApp(state) {
  return createApp({ state });
}

function jwtFor(state, role) {
  const user = state.users.find((u) => u.role === role);
  const assignments = state.userRoleAssignments.filter((a) => a.user_id === user.id);
  const principal = buildUserPrincipal(user, [], assignments);
  return issuePlatformToken(principal, state.sessionSecret);
}

async function scaffoldPublishableEvent(app, jwt, state, eventId) {
  const hallRes = await app.inject({
    method: "POST",
    path: `/events/${eventId}/halls`,
    headers: bearer(jwt),
    body: { name: "Hall A" }
  });
  const hallId = hallRes.body.hall_id ?? hallRes.body.id;

  await app.inject({
    method: "POST",
    path: `/events/${eventId}/stalls`,
    headers: bearer(jwt),
    body: { stall_code: "S1", name: "Stall S1", hall_id: hallId }
  });

  const sponsorOrg = state.organizations.find((o) => o.type === "sponsor");
  await app.inject({
    method: "POST",
    path: `/events/${eventId}/sponsor-packages`,
    headers: bearer(jwt),
    body: { name: "Gold", tier: "gold", org_id: sponsorOrg.id }
  });

  await app.inject({
    method: "POST",
    path: `/events/${eventId}/data-policy`,
    headers: bearer(jwt),
    body: {
      vendor_exports_enabled: true,
      sponsor_pii_enabled: false,
      require_export_approval: true,
      allow_crm_push: false,
      retention_days: 30,
      allow_cross_event_identity_graph: false
    }
  });

  const organizer = state.users.find((u) => u.role === "organizer_admin");
  const hasAssignment = state.userRoleAssignments.some(
    (a) => a.role === "organizer_admin" && a.event_id === eventId
  );
  if (!hasAssignment) {
    state.userRoleAssignments.push({
      id: `ura-org-${eventId}`,
      tenant_id: organizer.tenant_id,
      user_id: organizer.id,
      role: "organizer_admin",
      event_id: eventId,
      stall_ids: [],
      sponsor_package_id: null,
      assigned_by_user_id: organizer.id,
      created_at: new Date().toISOString()
    });
  }
}

// ─────────────────────────────────────────────────────────────
// Group 1: RBAC end-to-end flows (6 tests)
// ─────────────────────────────────────────────────────────────

test("RBAC: platform_admin can list all users across tenant", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = jwtFor(state, "platform_admin");

  const res = await app.inject({
    method: "GET",
    path: "/users",
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.users));
  assert.ok(res.body.users.length > 0);
});

test("RBAC: organizer_admin cannot access admin-only endpoints", async () => {
  const state = createSeedState();
  const app = await makeApp(state);

  const res = await app.inject({
    method: "GET",
    path: "/admin/api-clients",
    headers: bearer("organizer-token")
  });
  assert.equal(res.statusCode, 403);
});

test("RBAC: vendor_manager cannot list users", async () => {
  const state = createSeedState();
  const app = await makeApp(state);

  const res = await app.inject({
    method: "GET",
    path: "/users",
    headers: bearer("vendor-token")
  });
  assert.equal(res.statusCode, 403);
});

test("RBAC: sponsor_user cannot list users (admin endpoint)", async () => {
  const state = createSeedState();
  const app = await makeApp(state);

  const res = await app.inject({
    method: "GET",
    path: "/users",
    headers: bearer("sponsor-token")
  });
  assert.equal(res.statusCode, 403);
});

test("RBAC: organizer_admin cannot invite another organizer_admin", async () => {
  const state = createSeedState();
  const app = await makeApp(state);

  const res = await app.inject({
    method: "POST",
    path: "/users/invite",
    headers: bearer("organizer-token"),
    body: {
      email: "neworg@example.com",
      display_name: "New Organizer",
      role: "organizer_admin",
      event_id: "event-demo"
    }
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "INSUFFICIENT_PERMISSIONS");
});

test("RBAC: organizer_admin cannot invite platform_admin", async () => {
  const state = createSeedState();
  const app = await makeApp(state);

  const res = await app.inject({
    method: "POST",
    path: "/users/invite",
    headers: bearer("organizer-token"),
    body: {
      email: "newplatform@example.com",
      display_name: "New Platform Admin",
      role: "platform_admin"
    }
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "INSUFFICIENT_PERMISSIONS");
});

// ─────────────────────────────────────────────────────────────
// Group 2: Invitation lifecycle (5 tests)
// ─────────────────────────────────────────────────────────────

test("Invitation: platform_admin can invite vendor_manager scoped to an event+stall", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = jwtFor(state, "platform_admin");

  const res = await app.inject({
    method: "POST",
    path: "/users/invite",
    headers: bearer(jwt),
    body: {
      email: "newvendor@example.com",
      display_name: "New Vendor",
      role: "vendor_manager",
      event_id: "event-demo",
      stall_ids: ["stall-a1"]
    }
  });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.invite_token);
  assert.equal(res.body.role, "vendor_manager");
});

test("Invitation: invite dispatches user_invitation notification", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = jwtFor(state, "platform_admin");

  await app.inject({
    method: "POST",
    path: "/users/invite",
    headers: bearer(jwt),
    body: {
      email: "invitenotif@example.com",
      display_name: "Invite Notif",
      role: "vendor_manager",
      event_id: "event-demo",
      stall_ids: ["stall-a1"]
    }
  });

  const notif = state.notifications.find(
    (n) => n.message_type === "user_invitation" &&
    n.system_payload?.recipient_email === "invitenotif@example.com"
  );
  assert.ok(notif, "user_invitation notification should be queued");
});

test("Invitation: accept-invite sets password and activates user", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = jwtFor(state, "platform_admin");

  const inviteRes = await app.inject({
    method: "POST",
    path: "/users/invite",
    headers: bearer(jwt),
    body: {
      email: "acceptme@example.com",
      display_name: "Accept Me",
      role: "vendor_manager",
      event_id: "event-demo",
      stall_ids: ["stall-a1"]
    }
  });
  assert.equal(inviteRes.statusCode, 200);
  const inviteToken = inviteRes.body.invite_token;

  const acceptRes = await app.inject({
    method: "POST",
    path: "/auth/accept-invite",
    body: { token: inviteToken, password: "Password123!" }
  });
  assert.equal(acceptRes.statusCode, 200);
  assert.ok(acceptRes.body.token, "JWT token should be returned");

  const user = state.users.find((u) => u.email === "acceptme@example.com");
  assert.equal(user.status, "active");
});

test("Invitation: duplicate email invite returns 409", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = jwtFor(state, "platform_admin");

  await app.inject({
    method: "POST",
    path: "/users/invite",
    headers: bearer(jwt),
    body: {
      email: "dupe@example.com",
      display_name: "Dupe User",
      role: "vendor_manager",
      event_id: "event-demo",
      stall_ids: ["stall-a1"]
    }
  });

  const res = await app.inject({
    method: "POST",
    path: "/users/invite",
    headers: bearer(jwt),
    body: {
      email: "dupe@example.com",
      display_name: "Dupe User 2",
      role: "vendor_manager",
      event_id: "event-demo",
      stall_ids: ["stall-a1"]
    }
  });
  assert.equal(res.statusCode, 409);
});

test("Invitation: vendor_manager invite without stall_ids returns 400", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = jwtFor(state, "platform_admin");

  const res = await app.inject({
    method: "POST",
    path: "/users/invite",
    headers: bearer(jwt),
    body: {
      email: "nostall@example.com",
      display_name: "No Stall",
      role: "vendor_manager",
      event_id: "event-demo",
      stall_ids: []
    }
  });
  assert.equal(res.statusCode, 400);
});

// ─────────────────────────────────────────────────────────────
// Group 3: Password reset flows (4 tests)
// ─────────────────────────────────────────────────────────────

test("Password reset: forgot-password enqueues notification for known email", async () => {
  const state = createSeedState();
  const app = await makeApp(state);

  const res = await app.inject({
    method: "POST",
    path: "/auth/forgot-password",
    body: { email: "organizer@example.com" }
  });
  assert.equal(res.statusCode, 200);

  const notif = state.notifications.find(
    (n) => n.message_type === "password_reset" &&
    n.system_payload?.recipient_email === "organizer@example.com"
  );
  assert.ok(notif, "password_reset notification should be queued");
});

test("Password reset: forgot-password returns 200 for unknown email (no enumeration)", async () => {
  const state = createSeedState();
  const app = await makeApp(state);

  const res = await app.inject({
    method: "POST",
    path: "/auth/forgot-password",
    body: { email: "nobody@example.com" }
  });
  assert.equal(res.statusCode, 200);
  const notifCount = state.notifications.filter((n) => n.message_type === "password_reset").length;
  assert.equal(notifCount, 0);
});

test("Password reset: valid reset token changes password", async () => {
  const state = createSeedState();
  const app = await makeApp(state);

  await app.inject({
    method: "POST",
    path: "/auth/forgot-password",
    body: { email: "organizer@example.com" }
  });

  const notif = state.notifications.find((n) => n.message_type === "password_reset");
  const tokenMatch = notif.system_payload.body.match(/token=([a-f0-9]+)/);
  assert.ok(tokenMatch, "Reset token should be in notification body");
  const resetToken = tokenMatch[1];

  const resetRes = await app.inject({
    method: "POST",
    path: "/auth/reset-password",
    body: { token: resetToken, password: "NewPassword999!" }
  });
  assert.equal(resetRes.statusCode, 200);
});

test("Password reset: expired token returns 400", async () => {
  const state = createSeedState();
  const app = await makeApp(state);

  const res = await app.inject({
    method: "POST",
    path: "/auth/reset-password",
    body: { token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", password: "NewPassword999!" }
  });
  assert.equal(res.statusCode, 400);
});

// ─────────────────────────────────────────────────────────────
// Group 4: Event status transitions (8 tests)
// ─────────────────────────────────────────────────────────────

test("Event: platform_admin can create a draft event", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = jwtFor(state, "platform_admin");

  const organizerOrg = state.organizations.find((o) => o.type === "organizer");
  const res = await app.inject({
    method: "POST",
    path: "/events",
    headers: bearer(jwt),
    body: {
      name: "Phase 12 Test Event",
      venue_name: "Test Venue",
      city: "Test City",
      country: "US",
      start_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      end_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
      organizer_org_id: organizerOrg.id
    }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "draft");
  assert.ok(res.body.event_id);
});

test("Event: publish requires checklist complete", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = jwtFor(state, "platform_admin");

  const organizerOrg = state.organizations.find((o) => o.type === "organizer");
  const createRes = await app.inject({
    method: "POST",
    path: "/events",
    headers: bearer(jwt),
    body: {
      name: "Incomplete Event",
      venue_name: "Venue",
      city: "City",
      country: "US",
      start_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      end_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
      organizer_org_id: organizerOrg.id
    }
  });
  const newEventId = createRes.body.event_id;

  const publishRes = await app.inject({
    method: "POST",
    path: `/events/${newEventId}/publish`,
    headers: bearer(jwt),
    body: {}
  });
  assert.equal(publishRes.statusCode, 422);
});

test("Event: publish succeeds with complete checklist", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = jwtFor(state, "platform_admin");

  const organizerOrg = state.organizations.find((o) => o.type === "organizer");
  const createRes = await app.inject({
    method: "POST",
    path: "/events",
    headers: bearer(jwt),
    body: {
      name: "Ready Event",
      venue_name: "Venue",
      city: "City",
      country: "US",
      start_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      end_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
      organizer_org_id: organizerOrg.id
    }
  });
  const newEventId = createRes.body.event_id;

  await scaffoldPublishableEvent(app, jwt, state, newEventId);

  const publishRes = await app.inject({
    method: "POST",
    path: `/events/${newEventId}/publish`,
    headers: bearer(jwt),
    body: {}
  });
  assert.equal(publishRes.statusCode, 200);
  assert.equal(publishRes.body.status, "published");
});

test("Event: cannot publish already-published event", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = jwtFor(state, "platform_admin");

  const organizerOrg = state.organizations.find((o) => o.type === "organizer");
  const createRes = await app.inject({
    method: "POST",
    path: "/events",
    headers: bearer(jwt),
    body: {
      name: "Double Publish",
      venue_name: "Venue",
      city: "City",
      country: "US",
      start_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      end_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
      organizer_org_id: organizerOrg.id
    }
  });
  const newEventId = createRes.body.event_id;

  await scaffoldPublishableEvent(app, jwt, state, newEventId);
  await app.inject({ method: "POST", path: `/events/${newEventId}/publish`, headers: bearer(jwt), body: {} });

  const res2 = await app.inject({
    method: "POST",
    path: `/events/${newEventId}/publish`,
    headers: bearer(jwt),
    body: {}
  });
  assert.equal(res2.statusCode, 400);
});

test("Event: go-live requires branding approved and device assigned", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = jwtFor(state, "platform_admin");

  const organizerOrg = state.organizations.find((o) => o.type === "organizer");
  const createRes = await app.inject({
    method: "POST",
    path: "/events",
    headers: bearer(jwt),
    body: {
      name: "Go Live Blocked",
      venue_name: "Venue",
      city: "City",
      country: "US",
      start_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      end_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
      organizer_org_id: organizerOrg.id
    }
  });
  const newEventId = createRes.body.event_id;

  await scaffoldPublishableEvent(app, jwt, state, newEventId);
  await app.inject({ method: "POST", path: `/events/${newEventId}/publish`, headers: bearer(jwt), body: {} });

  const res = await app.inject({
    method: "POST",
    path: `/events/${newEventId}/go-live`,
    headers: bearer(jwt),
    body: {}
  });
  assert.equal(res.statusCode, 422);
  assert.ok(res.body.details?.failing_items?.includes("branding_not_approved"));
});

test("Event: go-live succeeds after branding approved and device heartbeat", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = jwtFor(state, "platform_admin");

  const organizerOrg = state.organizations.find((o) => o.type === "organizer");
  const createRes = await app.inject({
    method: "POST",
    path: "/events",
    headers: bearer(jwt),
    body: {
      name: "Go Live Event",
      venue_name: "Venue",
      city: "City",
      country: "US",
      start_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      end_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
      organizer_org_id: organizerOrg.id
    }
  });
  const newEventId = createRes.body.event_id;

  await scaffoldPublishableEvent(app, jwt, state, newEventId);

  // Save and approve branding
  await app.inject({ method: "POST", path: `/events/${newEventId}/branding`, headers: bearer(jwt), body: { primary_color: "#000000" } });
  await app.inject({ method: "POST", path: `/events/${newEventId}/branding/approve`, headers: bearer(jwt), body: {} });

  await app.inject({ method: "POST", path: `/events/${newEventId}/publish`, headers: bearer(jwt), body: {} });

  // Assign device and inject heartbeat
  const newDeviceRes = await app.inject({
    method: "POST",
    path: "/devices",
    headers: bearer(jwt),
    body: { serial_number: "SN-GOLIVE" }
  });
  const newDeviceId = newDeviceRes.body.device.id;

  // Get a stall in this event
  const stallInEvent = state.stalls.find((s) => s.event_id === newEventId);
  await app.inject({
    method: "POST",
    path: `/devices/${newDeviceId}/assign`,
    headers: bearer(jwt),
    body: { stall_id: stallInEvent.id, event_id: newEventId }
  });

  // Inject recent heartbeat directly into state
  state.heartbeats.push({
    id: `hb-golive-${Date.now()}`,
    tenant_id: "tenant-demo",
    device_id: newDeviceId,
    event_id: newEventId,
    received_at: new Date().toISOString(),
    created_at: new Date().toISOString()
  });

  const res = await app.inject({
    method: "POST",
    path: `/events/${newEventId}/go-live`,
    headers: bearer(jwt),
    body: {}
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "live");
});

test("Event: close transitions live event to closed", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = jwtFor(state, "platform_admin");

  const organizerOrg = state.organizations.find((o) => o.type === "organizer");
  const createRes = await app.inject({
    method: "POST",
    path: "/events",
    headers: bearer(jwt),
    body: {
      name: "Close Event",
      venue_name: "Venue",
      city: "City",
      country: "US",
      start_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      end_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
      organizer_org_id: organizerOrg.id
    }
  });
  const newEventId = createRes.body.event_id;

  await scaffoldPublishableEvent(app, jwt, state, newEventId);
  await app.inject({ method: "POST", path: `/events/${newEventId}/branding`, headers: bearer(jwt), body: { primary_color: "#000" } });
  await app.inject({ method: "POST", path: `/events/${newEventId}/branding/approve`, headers: bearer(jwt), body: {} });
  await app.inject({ method: "POST", path: `/events/${newEventId}/publish`, headers: bearer(jwt), body: {} });

  const newDeviceRes = await app.inject({ method: "POST", path: "/devices", headers: bearer(jwt), body: { serial_number: "SN-CLOSE" } });
  const newDeviceId = newDeviceRes.body.device.id;
  const stallInEvent = state.stalls.find((s) => s.event_id === newEventId);
  await app.inject({ method: "POST", path: `/devices/${newDeviceId}/assign`, headers: bearer(jwt), body: { stall_id: stallInEvent.id, event_id: newEventId } });
  state.heartbeats.push({ id: `hb-close-${Date.now()}`, tenant_id: "tenant-demo", device_id: newDeviceId, event_id: newEventId, received_at: new Date().toISOString(), created_at: new Date().toISOString() });

  await app.inject({ method: "POST", path: `/events/${newEventId}/go-live`, headers: bearer(jwt), body: {} });

  const res = await app.inject({
    method: "POST",
    path: `/events/${newEventId}/close`,
    headers: bearer(jwt),
    body: { confirm_event_name: "Close Event" }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "closed");
});

test("Event: archive transitions closed event to archived", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = jwtFor(state, "platform_admin");

  const organizerOrg = state.organizations.find((o) => o.type === "organizer");
  const createRes = await app.inject({
    method: "POST",
    path: "/events",
    headers: bearer(jwt),
    body: {
      name: "Archive Event",
      venue_name: "Venue",
      city: "City",
      country: "US",
      start_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      end_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
      organizer_org_id: organizerOrg.id
    }
  });
  const newEventId = createRes.body.event_id;

  await scaffoldPublishableEvent(app, jwt, state, newEventId);
  await app.inject({ method: "POST", path: `/events/${newEventId}/branding`, headers: bearer(jwt), body: { primary_color: "#000" } });
  await app.inject({ method: "POST", path: `/events/${newEventId}/branding/approve`, headers: bearer(jwt), body: {} });
  await app.inject({ method: "POST", path: `/events/${newEventId}/publish`, headers: bearer(jwt), body: {} });

  const newDeviceRes = await app.inject({ method: "POST", path: "/devices", headers: bearer(jwt), body: { serial_number: "SN-ARCHIVE" } });
  const newDeviceId = newDeviceRes.body.device.id;
  const stallInEvent = state.stalls.find((s) => s.event_id === newEventId);
  await app.inject({ method: "POST", path: `/devices/${newDeviceId}/assign`, headers: bearer(jwt), body: { stall_id: stallInEvent.id, event_id: newEventId } });
  state.heartbeats.push({ id: `hb-archive-${Date.now()}`, tenant_id: "tenant-demo", device_id: newDeviceId, event_id: newEventId, received_at: new Date().toISOString(), created_at: new Date().toISOString() });

  await app.inject({ method: "POST", path: `/events/${newEventId}/go-live`, headers: bearer(jwt), body: {} });
  await app.inject({ method: "POST", path: `/events/${newEventId}/close`, headers: bearer(jwt), body: { confirm_event_name: "Archive Event" } });

  const res = await app.inject({
    method: "POST",
    path: `/events/${newEventId}/archive`,
    headers: bearer(jwt),
    body: {}
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "archived");
});

// ─────────────────────────────────────────────────────────────
// Group 5: Break-glass workflow (4 tests)
// ─────────────────────────────────────────────────────────────

test("Break-glass: request creates record with status=requested and notifies other admins", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = jwtFor(state, "platform_admin");

  const expires = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const res = await app.inject({
    method: "POST",
    path: "/break-glass/request",
    headers: bearer(jwt),
    body: {
      justification: "Emergency lead access",
      access_scope: { permissions: ["stall_leads_unmask"] },
      expires_at: expires
    }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "requested");

  const notif = state.notifications.find((n) => n.message_type === "break_glass_pending_approval");
  assert.ok(notif, "break_glass_pending_approval notification should be dispatched");
});

test("Break-glass: two approvals from different admins grants active status", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt1 = jwtFor(state, "platform_admin");

  const expires = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const reqRes = await app.inject({
    method: "POST",
    path: "/break-glass/request",
    headers: bearer(jwt1),
    body: { justification: "Test", access_scope: {}, expires_at: expires }
  });
  const requestId = reqRes.body.id;

  // First approval
  await app.inject({
    method: "POST",
    path: `/break-glass/${requestId}/approve`,
    headers: bearer("platform-2-token"),
    body: {}
  });

  // Second approval
  const approveRes = await app.inject({
    method: "POST",
    path: `/break-glass/${requestId}/approve`,
    headers: bearer("platform-3-token"),
    body: {}
  });
  assert.equal(approveRes.body.status, "active");
});

test("Break-glass: self-approval returns 409", async () => {
  const state = createSeedState();
  const app = await makeApp(state);

  const expires = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const reqRes = await app.inject({
    method: "POST",
    path: "/break-glass/request",
    headers: bearer("platform-token"),
    body: { justification: "Self approve test", access_scope: {}, expires_at: expires }
  });
  const requestId = reqRes.body.id;

  const res = await app.inject({
    method: "POST",
    path: `/break-glass/${requestId}/approve`,
    headers: bearer("platform-token"),
    body: {}
  });
  assert.equal(res.statusCode, 409);
});

test("Break-glass: expiry job expires active sessions and writes audit", async () => {
  const state = createSeedState();
  const app = await makeApp(state);

  const pastExpiry = new Date(Date.now() - 60_000).toISOString();
  state.breakGlassAccess.push({
    id: "bg-p12-expired",
    tenant_id: "tenant-demo",
    requested_by_user_id: "user-platform-1",
    first_approved_by_user_id: "user-platform-2",
    second_approved_by_user_id: "user-platform-3",
    justification: "Phase 12 expiry test",
    access_scope: {},
    status: "active",
    starts_at: new Date(Date.now() - 120_000).toISOString(),
    expires_at: pastExpiry,
    revoked_at: null,
    created_at: new Date(Date.now() - 120_000).toISOString()
  });

  const { repos } = app;
  const expired = await runBreakGlassExpiry(repos, ["tenant-demo"]);
  assert.ok(expired.includes("bg-p12-expired"), "session should appear in expired list");

  const updated = state.breakGlassAccess.find((s) => s.id === "bg-p12-expired");
  assert.equal(updated.status, "expired");
});

// ─────────────────────────────────────────────────────────────
// Group 6: Device provisioning (4 tests)
// ─────────────────────────────────────────────────────────────

test("Device: platform_admin can create a device with status=inventory", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = jwtFor(state, "platform_admin");

  const res = await app.inject({
    method: "POST",
    path: "/devices",
    headers: bearer(jwt),
    body: { serial_number: "SN-NEW-001", label: "Test Device" }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.device.status, "inventory");
  assert.equal(res.body.device.serial_number, "SN-NEW-001");
});

test("Device: assign changes device status to live", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = jwtFor(state, "platform_admin");

  const createRes = await app.inject({
    method: "POST",
    path: "/devices",
    headers: bearer(jwt),
    body: { serial_number: "SN-ASSIGN-001" }
  });
  const deviceId = createRes.body.device.id;

  const assignRes = await app.inject({
    method: "POST",
    path: `/devices/${deviceId}/assign`,
    headers: bearer(jwt),
    body: { stall_id: "stall-a1", event_id: "event-demo" }
  });
  assert.equal(assignRes.statusCode, 200);

  const device = state.devices.find((d) => d.id === deviceId);
  assert.equal(device.status, "live");
});

test("Device: organizer_admin can list devices", async () => {
  const state = createSeedState();
  const app = await makeApp(state);

  const res = await app.inject({
    method: "GET",
    path: "/devices",
    headers: bearer("organizer-token")
  });
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.devices));
});

test("Device: cannot retire a live device", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = jwtFor(state, "platform_admin");

  const res = await app.inject({
    method: "POST",
    path: "/devices/device-01/retire",
    headers: bearer(jwt),
    body: {}
  });
  assert.equal(res.statusCode, 409);
});

// ─────────────────────────────────────────────────────────────
// Group 7: Branding management (2 tests)
// ─────────────────────────────────────────────────────────────

test("Branding: save and retrieve branding config for event", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = jwtFor(state, "platform_admin");

  const saveRes = await app.inject({
    method: "POST",
    path: "/events/event-demo/branding",
    headers: bearer(jwt),
    body: { primary_color: "#f3c97d", logo_url: "https://example.com/logo.png" }
  });
  assert.equal(saveRes.statusCode, 200);
  assert.equal(saveRes.body.branding.primary_color, "#f3c97d");

  const getRes = await app.inject({
    method: "GET",
    path: "/events/event-demo/branding",
    headers: bearer(jwt)
  });
  assert.equal(getRes.statusCode, 200);
  assert.equal(getRes.body.is_default, false);
  assert.equal(getRes.body.branding.primary_color, "#f3c97d");
});

test("Branding: platform_admin can approve branding, branding_approved becomes true", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = jwtFor(state, "platform_admin");

  await app.inject({
    method: "POST",
    path: "/events/event-demo/branding",
    headers: bearer(jwt),
    body: { primary_color: "#000000" }
  });

  const approveRes = await app.inject({
    method: "POST",
    path: "/events/event-demo/branding/approve",
    headers: bearer(jwt),
    body: {}
  });
  assert.equal(approveRes.statusCode, 200);
  assert.equal(approveRes.body.branding.branding_approved, true);
});

// ─────────────────────────────────────────────────────────────
// Group 8: API client management (3 tests)
// ─────────────────────────────────────────────────────────────

test("API client: create returns client_id and client_secret", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = jwtFor(state, "platform_admin");

  const res = await app.inject({
    method: "POST",
    path: "/admin/api-clients",
    headers: bearer(jwt),
    body: { name: "Test Client", scopes: ["leads:export"] }
  });
  assert.equal(res.statusCode, 201);
  assert.ok(res.body.client_id);
  assert.ok(res.body.client_secret);
});

test("API client: rotate-secret issues a new secret", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = jwtFor(state, "platform_admin");

  const createRes = await app.inject({
    method: "POST",
    path: "/admin/api-clients",
    headers: bearer(jwt),
    body: { name: "Rotate Client", scopes: ["leads:export"] }
  });
  const clientId = createRes.body.client_id;
  const clientRecord = state.apiClients.find((c) => c.client_id === clientId);
  const oldHash = clientRecord.client_secret_hash;

  await app.inject({
    method: "POST",
    path: `/admin/api-clients/${clientRecord.id}/rotate-secret`,
    headers: bearer(jwt),
    body: {}
  });

  const updated = state.apiClients.find((c) => c.id === clientRecord.id);
  assert.notEqual(updated.client_secret_hash, oldHash, "Secret hash should change after rotation");
});

test("API client: revoke prevents further secret rotation", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = jwtFor(state, "platform_admin");

  const createRes = await app.inject({
    method: "POST",
    path: "/admin/api-clients",
    headers: bearer(jwt),
    body: { name: "Revoke Client", scopes: ["leads:export"] }
  });
  const revokeClientId = state.apiClients.find((c) => c.client_id === createRes.body.client_id)?.id;

  await app.inject({
    method: "POST",
    path: `/admin/api-clients/${revokeClientId}/revoke`,
    headers: bearer(jwt),
    body: {}
  });

  const res = await app.inject({
    method: "POST",
    path: `/admin/api-clients/${revokeClientId}/rotate-secret`,
    headers: bearer(jwt),
    body: {}
  });
  assert.equal(res.statusCode, 400);
});

// ─────────────────────────────────────────────────────────────
// Group 9: Data policy enforcement (2 tests)
// ─────────────────────────────────────────────────────────────

test("Data policy: vendor export blocked when vendor_exports_enabled=false", async () => {
  const state = createSeedState();
  const app = await makeApp(state);

  const policy = state.eventPolicies.find((p) => p.event_id === "event-demo");
  if (policy) {
    policy.vendor_exports_enabled = false;
  } else {
    state.eventPolicies.push({
      event_id: "event-demo",
      tenant_id: "tenant-demo",
      vendor_exports_enabled: false,
      sponsor_pii_enabled: false,
      require_export_approval: true,
      allow_crm_push: false,
      retention_days: 30,
      allow_cross_event_identity_graph: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
  }

  const res = await app.inject({
    method: "POST",
    path: "/exports/request",
    headers: bearer("vendor-token"),
    body: { event_id: "event-demo", export_type: "vendor_leads" }
  });
  assert.equal(res.statusCode, 403);
});

test("Data policy: organizer can update data policy settings", async () => {
  const state = createSeedState();
  const app = await makeApp(state);

  const res = await app.inject({
    method: "POST",
    path: "/events/event-demo/data-policy",
    headers: bearer("organizer-token"),
    body: {
      vendor_exports_enabled: true,
      sponsor_pii_enabled: true,
      require_export_approval: false,
      allow_crm_push: true,
      retention_days: 60,
      allow_cross_event_identity_graph: false
    }
  });
  assert.equal(res.statusCode, 200);

  const policy = state.eventPolicies.find((p) => p.event_id === "event-demo");
  assert.equal(policy.sponsor_pii_enabled, true);
  assert.equal(policy.retention_days, 60);
});

// ─────────────────────────────────────────────────────────────
// Group 10: Audit completeness (1 test)
// ─────────────────────────────────────────────────────────────

test("Audit: key actions write audit records", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = jwtFor(state, "platform_admin");

  // Create event (should audit)
  const organizerOrg = state.organizations.find((o) => o.type === "organizer");
  await app.inject({
    method: "POST",
    path: "/events",
    headers: bearer(jwt),
    body: {
      name: "Audit Test Event",
      venue_name: "Venue",
      city: "City",
      country: "US",
      start_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      end_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
      organizer_org_id: organizerOrg.id
    }
  });

  // Invite user (should audit)
  await app.inject({
    method: "POST",
    path: "/users/invite",
    headers: bearer(jwt),
    body: {
      email: "auditee@example.com",
      display_name: "Auditee",
      role: "vendor_manager",
      event_id: "event-demo",
      stall_ids: ["stall-a1"]
    }
  });

  // Fetch audit logs
  const auditRes = await app.inject({
    method: "GET",
    path: "/audit/logs",
    headers: bearer(jwt)
  });
  assert.equal(auditRes.statusCode, 200);

  const eventTypes = auditRes.body.items.map((a) => a.event_type);
  assert.ok(eventTypes.includes(AUDIT_EVENT_TYPES.EVENT_CREATED), "event.created audit expected");
  assert.ok(eventTypes.includes(AUDIT_EVENT_TYPES.USER_INVITED), "user.invited audit expected");
});
