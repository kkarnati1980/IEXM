import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.mjs";
import { createSeedState } from "../src/store.mjs";
import { issuePlatformToken } from "../src/auth/platform-jwt.mjs";
import { buildUserPrincipal } from "../src/auth/principals.mjs";
import { AUDIT_EVENT_TYPES } from "../src/audit.mjs";
import { runOnce } from "../src/jobs/break-glass-expiry.mjs";

const FUTURE_START = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
const FUTURE_END = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString();

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

function findAudit(state, eventType) {
  return state.auditLogs.find((a) => a.event_type === eventType);
}

// Scaffold a publishable draft event (mirrors phase4 helper)
async function scaffoldPublishableEvent(app, jwt, state, eventId) {
  const hallRes = await app.inject({
    method: "POST",
    path: `/events/${eventId}/halls`,
    headers: bearer(jwt),
    body: { name: "Audit Hall" }
  });
  const hallId = hallRes.body.hall_id;

  await app.inject({
    method: "POST",
    path: `/events/${eventId}/stalls`,
    headers: bearer(jwt),
    body: { stall_code: "A1", name: "Stall A1", hall_id: hallId }
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
    body: { vendor_exports_enabled: true, sponsor_pii_enabled: false, require_export_approval: true, allow_crm_push: false, retention_days: 30, allow_cross_event_identity_graph: false }
  });

  const organizer = state.users.find((u) => u.role === "organizer_admin");
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

// ─────────────────────────────────────────────────────────────────────────────
// Step 7.4 — user.invited fires when POST /users/invite succeeds
// ─────────────────────────────────────────────────────────────────────────────

test("user.invited audit event fires on POST /users/invite", async () => {
  const { app, jwt, state, user } = await appAs("platform_admin");

  const res = await app.inject({
    method: "POST",
    path: "/users/invite",
    headers: bearer(jwt),
    body: { email: "audit-invited@example.com", display_name: "Audit Invited", role: "platform_admin" }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));

  const audit = findAudit(state, AUDIT_EVENT_TYPES.USER_INVITED);
  assert.ok(audit, "user.invited audit record should exist");
  assert.equal(audit.actor_id, user.id);
  assert.equal(audit.actor_type, "user");
  assert.equal(audit.target_type, "user");
  assert.equal(audit.target_id, res.body.user_id);
  assert.equal(audit.metadata.role, "platform_admin");
  assert.equal(audit.metadata.invited_by, user.id);
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 7.3 — user.activated fires when POST /auth/accept-invite succeeds
// ─────────────────────────────────────────────────────────────────────────────

test("user.activated audit event fires on POST /auth/accept-invite", async () => {
  const { app, jwt, state } = await appAs("platform_admin");

  const inviteRes = await app.inject({
    method: "POST",
    path: "/users/invite",
    headers: bearer(jwt),
    body: { email: "audit-accept@example.com", display_name: "Audit Accept", role: "platform_admin" }
  });
  assert.equal(inviteRes.statusCode, 200);
  const { invite_token } = inviteRes.body;

  const before = state.auditLogs.filter((a) => a.event_type === AUDIT_EVENT_TYPES.USER_ACTIVATED).length;

  const acceptRes = await app.inject({
    method: "POST",
    path: "/auth/accept-invite",
    body: { token: invite_token, password: "ValidPass123!" }
  });
  assert.equal(acceptRes.statusCode, 200, JSON.stringify(acceptRes.body));

  const after = state.auditLogs.filter((a) => a.event_type === AUDIT_EVENT_TYPES.USER_ACTIVATED);
  assert.equal(after.length, before + 1, "user.activated audit should appear after accept");
  const audit = after.at(-1);
  assert.equal(audit.actor_type, "system");
  assert.equal(audit.target_type, "auth-accept-invite");
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 7.4 — user.disabled fires when POST /users/:id/disable is called
// ─────────────────────────────────────────────────────────────────────────────

test("user.disabled audit event fires on POST /users/:id/disable", async () => {
  const { app, jwt, state } = await appAs("platform_admin");

  const inviteRes = await app.inject({
    method: "POST",
    path: "/users/invite",
    headers: bearer(jwt),
    body: { email: "audit-disable@example.com", display_name: "Audit Disable", role: "platform_admin" }
  });
  const { user_id } = inviteRes.body;

  const disableRes = await app.inject({
    method: "POST",
    path: `/users/${user_id}/disable`,
    headers: bearer(jwt),
    body: { reason: "test disable" }
  });
  assert.equal(disableRes.statusCode, 200, JSON.stringify(disableRes.body));

  const audit = findAudit(state, AUDIT_EVENT_TYPES.USER_DISABLED);
  assert.ok(audit, "user.disabled audit record should exist");
  assert.equal(audit.event_type, "user.disabled");
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 7.4 — user.role_assigned fires when POST /users/:id/roles succeeds
// ─────────────────────────────────────────────────────────────────────────────

test("user.role_assigned audit event fires on POST /users/:id/roles", async () => {
  const { app, jwt, state, user } = await appAs("platform_admin");

  const inviteRes = await app.inject({
    method: "POST",
    path: "/users/invite",
    headers: bearer(jwt),
    body: { email: "audit-role@example.com", display_name: "Role Target", role: "platform_admin" }
  });
  const { user_id } = inviteRes.body;

  const before = state.auditLogs.filter((a) => a.event_type === AUDIT_EVENT_TYPES.USER_ROLE_ASSIGNED).length;

  const roleRes = await app.inject({
    method: "POST",
    path: `/users/${user_id}/roles`,
    headers: bearer(jwt),
    body: { role: "platform_admin" }
  });
  assert.equal(roleRes.statusCode, 200, JSON.stringify(roleRes.body));

  const after = state.auditLogs.filter((a) => a.event_type === AUDIT_EVENT_TYPES.USER_ROLE_ASSIGNED);
  assert.equal(after.length, before + 1, "user.role_assigned audit should appear");
  const audit = after.at(-1);
  assert.equal(audit.actor_id, user.id);
  assert.equal(audit.metadata.role, "platform_admin");
  assert.equal(audit.target_id, user_id);
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 7.5 — event.created fires when POST /events succeeds
// ─────────────────────────────────────────────────────────────────────────────

test("event.created audit event fires on POST /events", async () => {
  const { app, jwt, state, user } = await appAs("platform_admin");

  const res = await app.inject({
    method: "POST",
    path: "/events",
    headers: bearer(jwt),
    body: { name: "Audit Event", venue_name: "V", city: "C", country: "AU", start_at: FUTURE_START, end_at: FUTURE_END }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const eventId = res.body.event_id;

  const audit = findAudit(state, AUDIT_EVENT_TYPES.EVENT_CREATED);
  assert.ok(audit, "event.created audit record should exist");
  assert.equal(audit.target_type, "event");
  assert.equal(audit.target_id, eventId);
  assert.equal(audit.actor_id, user.id);
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 7.5 — event.published fires with correct entity_id when checklist passes
// ─────────────────────────────────────────────────────────────────────────────

test("event.published audit fires with correct entity_id", async () => {
  const { app, jwt, state } = await appAs("platform_admin");

  const createRes = await app.inject({
    method: "POST",
    path: "/events",
    headers: bearer(jwt),
    body: { name: "Pub Audit", venue_name: "V", city: "C", country: "AU", start_at: FUTURE_START, end_at: FUTURE_END }
  });
  const eventId = createRes.body.event_id;
  await scaffoldPublishableEvent(app, jwt, state, eventId);

  const pubRes = await app.inject({
    method: "POST",
    path: `/events/${eventId}/publish`,
    headers: bearer(jwt),
    body: {}
  });
  assert.equal(pubRes.statusCode, 200, JSON.stringify(pubRes.body));

  const audits = state.auditLogs.filter((a) => a.event_type === AUDIT_EVENT_TYPES.EVENT_PUBLISHED);
  assert.ok(audits.length > 0, "event.published audit should exist");
  const audit = audits.at(-1);
  assert.equal(audit.target_id, eventId, "target_id should match the published event");
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 7.5 — event.data_policy_changed fires with metadata showing changed fields
// ─────────────────────────────────────────────────────────────────────────────

test("event.data_policy_changed audit fires with changed_fields metadata", async () => {
  const { app, jwt, state } = await appAs("platform_admin");

  const createRes = await app.inject({
    method: "POST",
    path: "/events",
    headers: bearer(jwt),
    body: { name: "Policy Audit", venue_name: "V", city: "C", country: "AU", start_at: FUTURE_START, end_at: FUTURE_END }
  });
  const eventId = createRes.body.event_id;

  // First policy set
  await app.inject({
    method: "POST",
    path: `/events/${eventId}/data-policy`,
    headers: bearer(jwt),
    body: { vendor_exports_enabled: false, allow_crm_push: false, retention_days: 30 }
  });

  const before = state.auditLogs.filter((a) => a.event_type === AUDIT_EVENT_TYPES.EVENT_DATA_POLICY_CHANGED).length;

  // Change vendor_exports_enabled and retention_days
  const policyRes = await app.inject({
    method: "POST",
    path: `/events/${eventId}/data-policy`,
    headers: bearer(jwt),
    body: { vendor_exports_enabled: true, retention_days: 90 }
  });
  assert.equal(policyRes.statusCode, 200, JSON.stringify(policyRes.body));

  const after = state.auditLogs.filter((a) => a.event_type === AUDIT_EVENT_TYPES.EVENT_DATA_POLICY_CHANGED);
  assert.equal(after.length, before + 1, "event.data_policy_changed should fire");
  const audit = after.at(-1);
  assert.ok(audit.metadata.changed_fields.includes("vendor_exports_enabled"), "changed_fields should include vendor_exports_enabled");
  assert.ok(audit.metadata.changed_fields.includes("retention_days"), "changed_fields should include retention_days");
  assert.equal(audit.metadata.new_values.vendor_exports_enabled, true);
  assert.equal(audit.metadata.new_values.retention_days, 90);
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 7.3 — user.password_reset_requested fires when forgot-password finds user
// ─────────────────────────────────────────────────────────────────────────────

test("user.password_reset_requested audit fires on /auth/forgot-password", async () => {
  const state = createSeedState();
  const app = await createApp({ state });

  const res = await app.inject({
    method: "POST",
    path: "/auth/forgot-password",
    body: { email: "platform1@example.com" }
  });
  assert.equal(res.statusCode, 200);

  const audit = findAudit(state, AUDIT_EVENT_TYPES.USER_PASSWORD_RESET_REQUESTED);
  assert.ok(audit, "user.password_reset_requested audit should exist");
  assert.equal(audit.actor_type, "system");
  assert.equal(audit.target_type, "user");

  const platformUser = state.users.find((u) => u.email === "platform1@example.com");
  assert.equal(audit.target_id, platformUser.id);
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 7.6 — Break-glass expiry job: runOnce expires sessions and writes audit
// ─────────────────────────────────────────────────────────────────────────────

test("break-glass expiry job expires approved session and writes audit", async () => {
  const state = createSeedState();
  const app = await createApp({ state });

  // Create an approved break-glass session with expires_at in the past
  const now = new Date();
  const pastExpiry = new Date(now.getTime() - 60_000).toISOString();
  const session = {
    id: "bg-expired-test",
    tenant_id: "tenant-demo",
    requested_by_user_id: "user-platform-1",
    first_approved_by_user_id: "user-platform-2",
    second_approved_by_user_id: "user-platform-3",
    justification: "Test expiry",
    access_scope: { permissions: ["stall_leads_unmask"] },
    status: "active",
    starts_at: new Date(now.getTime() - 120_000).toISOString(),
    expires_at: pastExpiry,
    revoked_at: null,
    created_at: new Date(now.getTime() - 120_000).toISOString()
  };
  state.breakGlassAccess.push(session);

  const { repos } = app;
  const expired = await runOnce(repos, ["tenant-demo"]);

  assert.ok(expired.includes("bg-expired-test"), "session ID should appear in expired list");

  const updated = state.breakGlassAccess.find((s) => s.id === "bg-expired-test");
  assert.equal(updated.status, "expired", "Session status should be 'expired'");

  const audit = findAudit(state, AUDIT_EVENT_TYPES.BREAK_GLASS_EXPIRED);
  assert.ok(audit, "break_glass.expired audit record should exist");
  assert.equal(audit.target_id, "bg-expired-test");
  assert.equal(audit.actor_type, "system");
  assert.ok(audit.metadata.expired_at);
});

test("break-glass expiry job does not expire sessions that have not yet expired", async () => {
  const state = createSeedState();
  const app = await createApp({ state });

  const futureExpiry = new Date(Date.now() + 60_000).toISOString();
  state.breakGlassAccess.push({
    id: "bg-future-test",
    tenant_id: "tenant-demo",
    requested_by_user_id: "user-platform-1",
    first_approved_by_user_id: "user-platform-2",
    second_approved_by_user_id: "user-platform-3",
    justification: "Not yet expired",
    access_scope: {},
    status: "approved",
    starts_at: new Date().toISOString(),
    expires_at: futureExpiry,
    revoked_at: null,
    created_at: new Date().toISOString()
  });

  const { repos } = app;
  const expired = await runOnce(repos, ["tenant-demo"]);

  assert.ok(!expired.includes("bg-future-test"), "future session should not be expired");
  const session = state.breakGlassAccess.find((s) => s.id === "bg-future-test");
  assert.equal(session.status, "approved", "Session status should remain 'approved'");
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 7.2 — AUDIT_EVENT_TYPES exports all 29 new types
// ─────────────────────────────────────────────────────────────────────────────

test("AUDIT_EVENT_TYPES contains all 29 Phase 7 event types", () => {
  const expected = [
    "user.invited", "user.activated", "user.disabled", "user.re_enabled",
    "user.role_assigned", "user.role_removed", "user.password_reset_requested",
    "user.password_reset_completed", "user.password_changed",
    "org.created", "org.updated",
    "event.created", "event.published", "event.went_live", "event.closed",
    "event.archived", "event.data_policy_changed",
    "device.registered", "device.assigned", "device.unassigned", "device.retired",
    "branding.approved", "branding.published",
    "break_glass.requested", "break_glass.approved", "break_glass.rejected",
    "break_glass.expired", "break_glass.revoked",
    "api_client.created", "api_client.secret_rotated", "api_client.revoked"
  ];
  const values = Object.values(AUDIT_EVENT_TYPES);
  for (const eventType of expected) {
    assert.ok(values.includes(eventType), `Missing event type: ${eventType}`);
  }
  assert.equal(values.length, expected.length, `Expected ${expected.length} types, got ${values.length}`);
});
