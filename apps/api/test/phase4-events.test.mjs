import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.mjs";
import { createSeedState } from "../src/store.mjs";
import { issuePlatformToken } from "../src/auth/platform-jwt.mjs";
import { buildUserPrincipal } from "../src/auth/principals.mjs";

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

const FUTURE_START = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
const FUTURE_END = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString();

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

// Create a draft event via API and return its ID
async function createDraftEvent(app, jwt, overrides = {}) {
  const res = await app.inject({
    method: "POST",
    path: "/events",
    headers: bearer(jwt),
    body: {
      name: overrides.name ?? "Test Event 2026",
      venue_name: overrides.venue_name ?? "Test Venue",
      city: overrides.city ?? "Sydney",
      country: overrides.country ?? "AU",
      start_at: overrides.start_at ?? FUTURE_START,
      end_at: overrides.end_at ?? FUTURE_END
    }
  });
  assert.equal(res.statusCode, 200, `createDraftEvent failed: ${JSON.stringify(res.body)}`);
  return res.body.event_id;
}

// Scaffold a draft event with everything needed to publish
async function scaffoldPublishableEvent(app, jwt, state, eventId) {
  // Add hall
  const hallRes = await app.inject({
    method: "POST",
    path: `/events/${eventId}/halls`,
    headers: bearer(jwt),
    body: { name: "Main Hall" }
  });
  assert.equal(hallRes.statusCode, 200, JSON.stringify(hallRes.body));
  const hallId = hallRes.body.hall_id;

  // Add stall
  const stallRes = await app.inject({
    method: "POST",
    path: `/events/${eventId}/stalls`,
    headers: bearer(jwt),
    body: { stall_code: "A1", name: "Stall A1", hall_id: hallId }
  });
  assert.equal(stallRes.statusCode, 200, JSON.stringify(stallRes.body));

  // Add sponsor package (use existing sponsor org from seed)
  const sponsorOrg = state.organizations.find((o) => o.type === "sponsor");
  const pkgRes = await app.inject({
    method: "POST",
    path: `/events/${eventId}/sponsor-packages`,
    headers: bearer(jwt),
    body: { name: "Gold Package", tier: "gold", org_id: sponsorOrg.id }
  });
  assert.equal(pkgRes.statusCode, 200, JSON.stringify(pkgRes.body));

  // Add data policy
  const policyRes = await app.inject({
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
  assert.equal(policyRes.statusCode, 200, JSON.stringify(policyRes.body));

  // Add organizer_admin role assignment for this event
  const organizer = state.users.find((u) => u.role === "organizer_admin");
  state.userRoleAssignments.push({
    id: `ura-organizer-${eventId}`,
    tenant_id: organizer.tenant_id,
    user_id: organizer.id,
    role: "organizer_admin",
    event_id: eventId,
    stall_ids: [],
    sponsor_package_id: null,
    assigned_by_user_id: organizer.id,
    created_at: new Date().toISOString()
  });

  return { hallId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4.1 — POST /events
// ─────────────────────────────────────────────────────────────────────────────

test("POST /events: creates event with draft status", async () => {
  const { app, jwt } = await appAs("platform_admin");
  const res = await app.inject({
    method: "POST",
    path: "/events",
    headers: bearer(jwt),
    body: {
      name: "My New Event",
      venue_name: "Convention Centre",
      city: "Melbourne",
      country: "AU",
      start_at: FUTURE_START,
      end_at: FUTURE_END
    }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(res.body.event_id);
  assert.equal(res.body.status, "draft");
  assert.equal(res.body.name, "My New Event");
});

test("POST /events: end_at before start_at returns 400", async () => {
  const { app, jwt } = await appAs("platform_admin");
  const res = await app.inject({
    method: "POST",
    path: "/events",
    headers: bearer(jwt),
    body: {
      name: "Bad Dates Event",
      venue_name: "Venue",
      city: "Sydney",
      country: "AU",
      start_at: FUTURE_END,
      end_at: FUTURE_START
    }
  });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error.includes("end_at must be after start_at"));
});

test("POST /events: missing name returns 400", async () => {
  const { app, jwt } = await appAs("platform_admin");
  const res = await app.inject({
    method: "POST",
    path: "/events",
    headers: bearer(jwt),
    body: { venue_name: "V", city: "C", country: "AU", start_at: FUTURE_START, end_at: FUTURE_END }
  });
  assert.equal(res.statusCode, 400);
});

test("POST /events: vendor_manager is forbidden", async () => {
  const { app, jwt } = await appAs("vendor_manager");
  const res = await app.inject({
    method: "POST",
    path: "/events",
    headers: bearer(jwt),
    body: { name: "X", venue_name: "V", city: "C", country: "AU", start_at: FUTURE_START, end_at: FUTURE_END }
  });
  assert.equal(res.statusCode, 403);
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 4.2 — GET /events
// ─────────────────────────────────────────────────────────────────────────────

test("GET /events: platform_admin sees all tenant events", async () => {
  const { app, jwt } = await appAs("platform_admin");
  const res = await app.inject({ method: "GET", path: "/events", headers: bearer(jwt) });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(Array.isArray(res.body.events));
  assert.ok(res.body.events.length >= 2, "should see both seed events");
  assert.ok("hall_count" in res.body.events[0]);
  assert.ok("stall_count" in res.body.events[0]);
  assert.ok("device_count" in res.body.events[0]);
});

test("GET /events: status filter works", async () => {
  const { app, jwt } = await appAs("platform_admin");
  const res = await app.inject({ method: "GET", path: "/events?status=draft", headers: bearer(jwt) });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.events.every((e) => e.status === "draft"));
});

test("GET /events: organizer_admin sees only their assigned events", async () => {
  const { app, jwt } = await appAs("organizer_admin");
  const res = await app.inject({ method: "GET", path: "/events", headers: bearer(jwt) });
  assert.equal(res.statusCode, 200);
  // organizer is assigned to event-demo only in seed
  assert.ok(res.body.events.every((e) => e.id === "event-demo"));
});

test("GET /events: vendor_manager sees their assigned events", async () => {
  const { app, jwt } = await appAs("vendor_manager");
  const res = await app.inject({ method: "GET", path: "/events", headers: bearer(jwt) });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.events.length >= 1);
  assert.equal(res.body.events[0].id, "event-demo");
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 4.3 — PATCH /events/:id
// ─────────────────────────────────────────────────────────────────────────────

test("PATCH /events/:id: updates name on draft event", async () => {
  const { app, jwt } = await appAs("platform_admin");
  const eventId = await createDraftEvent(app, jwt);
  const res = await app.inject({
    method: "PATCH",
    path: `/events/${eventId}`,
    headers: bearer(jwt),
    body: { name: "Updated Event Name" }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.name, "Updated Event Name");
});

test("PATCH /events/:id: returns EVENT_LOCKED for live event", async () => {
  const { app, jwt } = await appAs("platform_admin");
  // event-demo is 'live' in seed
  const res = await app.inject({
    method: "PATCH",
    path: "/events/event-demo",
    headers: bearer(jwt),
    body: { name: "Attempt to rename live event" }
  });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error.includes("EVENT_LOCKED"));
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 4.3b — POST /events/:id/publish
// ─────────────────────────────────────────────────────────────────────────────

test("POST /events/:id/publish: succeeds when checklist passes", async () => {
  const { app, jwt, state } = await appAs("platform_admin");
  const eventId = await createDraftEvent(app, jwt);
  await scaffoldPublishableEvent(app, jwt, state, eventId);

  const res = await app.inject({
    method: "POST",
    path: `/events/${eventId}/publish`,
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, "published");
  assert.ok(res.body.checklist);
  assert.equal(res.body.event_id, eventId);
});

test("POST /events/:id/publish: fails with 422 when checklist incomplete", async () => {
  const { app, jwt } = await appAs("platform_admin");
  const eventId = await createDraftEvent(app, jwt);
  // Don't add halls/stalls/packages/policy — publish should fail
  const res = await app.inject({
    method: "POST",
    path: `/events/${eventId}/publish`,
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 422, JSON.stringify(res.body));
  assert.ok(res.body.error.includes("CHECKLIST_INCOMPLETE"));
  assert.ok(Array.isArray(res.body.details.failing_items));
  assert.ok(res.body.details.failing_items.includes("no_halls"));
  assert.ok(res.body.details.failing_items.includes("no_stalls"));
  assert.ok(res.body.details.failing_items.includes("no_sponsor_packages"));
});

test("POST /events/:id/publish: returns INVALID_STATUS_TRANSITION from non-draft", async () => {
  const { app, jwt } = await appAs("platform_admin");
  // event-demo is already 'live'
  const res = await app.inject({
    method: "POST",
    path: "/events/event-demo/publish",
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error.includes("INVALID_STATUS_TRANSITION"));
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 4.3c — POST /events/:id/go-live
// ─────────────────────────────────────────────────────────────────────────────

test("POST /events/:id/go-live: blocked when branding not approved", async () => {
  const { app, jwt, state } = await appAs("platform_admin");
  const eventId = await createDraftEvent(app, jwt);
  await scaffoldPublishableEvent(app, jwt, state, eventId);

  // Publish first
  await app.inject({ method: "POST", path: `/events/${eventId}/publish`, headers: bearer(jwt) });

  // Go-live: no branding, no device
  const res = await app.inject({
    method: "POST",
    path: `/events/${eventId}/go-live`,
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 422, JSON.stringify(res.body));
  assert.ok(res.body.error.includes("GO_LIVE_BLOCKED"));
  assert.ok(res.body.details.failing_items.includes("branding_not_approved"));
});

test("POST /events/:id/go-live: returns INVALID_STATUS_TRANSITION from draft", async () => {
  const { app, jwt } = await appAs("platform_admin");
  const eventId = await createDraftEvent(app, jwt);
  const res = await app.inject({
    method: "POST",
    path: `/events/${eventId}/go-live`,
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error.includes("INVALID_STATUS_TRANSITION"));
});

test("POST /events/:id/go-live: succeeds with branding approved and recent heartbeat", async () => {
  const { app, jwt, state } = await appAs("platform_admin");
  const eventId = await createDraftEvent(app, jwt);
  await scaffoldPublishableEvent(app, jwt, state, eventId);

  // Publish
  await app.inject({ method: "POST", path: `/events/${eventId}/publish`, headers: bearer(jwt) });

  // Inject branding asset with approval
  state.brandingAssets.push({
    id: "branding-test",
    tenant_id: "tenant-demo",
    event_id: eventId,
    status: "active",
    branding_approved: true,
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });

  // Inject device assignment + recent heartbeat
  const deviceId = "device-test-01";
  state.deviceAssignments.push({
    id: "da-test-01",
    tenant_id: "tenant-demo",
    device_id: deviceId,
    event_id: eventId,
    stall_id: null,
    active: true
  });
  state.heartbeats.push({
    id: "hb-test-01",
    tenant_id: "tenant-demo",
    device_id: deviceId,
    event_id: eventId,
    received_at: new Date().toISOString(),
    created_at: new Date().toISOString()
  });

  const res = await app.inject({
    method: "POST",
    path: `/events/${eventId}/go-live`,
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, "live");
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 4.3d — POST /events/:id/close
// ─────────────────────────────────────────────────────────────────────────────

test("POST /events/:id/close: wrong confirm_event_name returns 400", async () => {
  const { app, jwt } = await appAs("platform_admin");
  // event-demo is live in seed
  const res = await app.inject({
    method: "POST",
    path: "/events/event-demo/close",
    headers: bearer(jwt),
    body: { confirm_event_name: "Wrong Name" }
  });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error.includes("CONFIRMATION_NAME_MISMATCH"));
});

test("POST /events/:id/close: correct name closes the event", async () => {
  const { app, jwt, state } = await appAs("platform_admin");
  const res = await app.inject({
    method: "POST",
    path: "/events/event-demo/close",
    headers: bearer(jwt),
    body: { confirm_event_name: "Expo Pilot 2026" }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, "closed");
});

test("POST /events/:id/close: returns INVALID_STATUS_TRANSITION from published", async () => {
  const { app, jwt, state } = await appAs("platform_admin");
  const eventId = await createDraftEvent(app, jwt);
  await scaffoldPublishableEvent(app, jwt, state, eventId);
  await app.inject({ method: "POST", path: `/events/${eventId}/publish`, headers: bearer(jwt) });

  const res = await app.inject({
    method: "POST",
    path: `/events/${eventId}/close`,
    headers: bearer(jwt),
    body: { confirm_event_name: "Test Event 2026" }
  });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error.includes("INVALID_STATUS_TRANSITION"));
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 4.3e — POST /events/:id/archive
// ─────────────────────────────────────────────────────────────────────────────

test("POST /events/:id/archive: organizer_admin gets 403", async () => {
  const { app, jwt } = await appAs("organizer_admin");
  const res = await app.inject({
    method: "POST",
    path: "/events/event-demo/archive",
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 403);
});

test("POST /events/:id/archive: archives a closed event", async () => {
  const { app, jwt } = await appAs("platform_admin");
  // Close event-demo first
  await app.inject({
    method: "POST",
    path: "/events/event-demo/close",
    headers: bearer(jwt),
    body: { confirm_event_name: "Expo Pilot 2026" }
  });
  const res = await app.inject({
    method: "POST",
    path: "/events/event-demo/archive",
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, "archived");
});

test("POST /events/:id/archive: returns INVALID_STATUS_TRANSITION from live", async () => {
  const { app, jwt } = await appAs("platform_admin");
  // event-demo is live
  const res = await app.inject({
    method: "POST",
    path: "/events/event-demo/archive",
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error.includes("INVALID_STATUS_TRANSITION"));
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 4.4 — Hall CRUD
// ─────────────────────────────────────────────────────────────────────────────

test("POST /events/:id/halls: creates hall on draft event", async () => {
  const { app, jwt } = await appAs("platform_admin");
  const eventId = await createDraftEvent(app, jwt);
  const res = await app.inject({
    method: "POST",
    path: `/events/${eventId}/halls`,
    headers: bearer(jwt),
    body: { name: "North Hall", floor_plan_url: "https://example.com/map.png" }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(res.body.hall_id);
  assert.equal(res.body.name, "North Hall");
});

test("POST /events/:id/halls: returns EVENT_LOCKED for live event", async () => {
  const { app, jwt } = await appAs("platform_admin");
  // event-demo is live
  const res = await app.inject({
    method: "POST",
    path: "/events/event-demo/halls",
    headers: bearer(jwt),
    body: { name: "Locked Hall" }
  });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error.includes("EVENT_LOCKED"));
});

test("DELETE /halls/:id: returns HALL_HAS_STALLS when stalls exist", async () => {
  const { app, jwt } = await appAs("platform_admin");
  const eventId = await createDraftEvent(app, jwt);
  const hallRes = await app.inject({
    method: "POST",
    path: `/events/${eventId}/halls`,
    headers: bearer(jwt),
    body: { name: "Hall With Stall" }
  });
  const hallId = hallRes.body.hall_id;

  // Add a stall to this hall
  await app.inject({
    method: "POST",
    path: `/events/${eventId}/stalls`,
    headers: bearer(jwt),
    body: { stall_code: "X1", name: "Stall X1", hall_id: hallId }
  });

  const res = await app.inject({
    method: "DELETE",
    path: `/halls/${hallId}`,
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error.includes("HALL_HAS_STALLS"));
});

test("DELETE /halls/:id: succeeds when hall is empty and event is draft", async () => {
  const { app, jwt } = await appAs("platform_admin");
  const eventId = await createDraftEvent(app, jwt);
  const hallRes = await app.inject({
    method: "POST",
    path: `/events/${eventId}/halls`,
    headers: bearer(jwt),
    body: { name: "Empty Hall" }
  });
  const hallId = hallRes.body.hall_id;

  const res = await app.inject({
    method: "DELETE",
    path: `/halls/${hallId}`,
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.deleted, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 4.5 — Stall CRUD
// ─────────────────────────────────────────────────────────────────────────────

test("POST /events/:id/stalls: duplicate stall_code returns 409", async () => {
  const { app, jwt } = await appAs("platform_admin");
  const eventId = await createDraftEvent(app, jwt);
  const hallRes = await app.inject({
    method: "POST",
    path: `/events/${eventId}/halls`,
    headers: bearer(jwt),
    body: { name: "Hall" }
  });
  const hallId = hallRes.body.hall_id;

  await app.inject({
    method: "POST",
    path: `/events/${eventId}/stalls`,
    headers: bearer(jwt),
    body: { stall_code: "B1", name: "First B1", hall_id: hallId }
  });

  const res = await app.inject({
    method: "POST",
    path: `/events/${eventId}/stalls`,
    headers: bearer(jwt),
    body: { stall_code: "B1", name: "Duplicate B1", hall_id: hallId }
  });
  assert.equal(res.statusCode, 409);
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 4.6 — Sponsor Package CRUD
// ─────────────────────────────────────────────────────────────────────────────

test("POST /events/:id/sponsor-packages: creates package", async () => {
  const { app, jwt, state } = await appAs("platform_admin");
  const eventId = await createDraftEvent(app, jwt);
  const sponsorOrg = state.organizations.find((o) => o.type === "sponsor");
  const res = await app.inject({
    method: "POST",
    path: `/events/${eventId}/sponsor-packages`,
    headers: bearer(jwt),
    body: { name: "Silver Tier", tier: "silver", org_id: sponsorOrg.id }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(res.body.package_id);
  assert.equal(res.body.tier, "silver");
});

test("POST /events/:id/sponsor-packages: invalid tier returns 400", async () => {
  const { app, jwt } = await appAs("platform_admin");
  const eventId = await createDraftEvent(app, jwt);
  const res = await app.inject({
    method: "POST",
    path: `/events/${eventId}/sponsor-packages`,
    headers: bearer(jwt),
    body: { name: "Fake Tier", tier: "platinum" }
  });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error.includes("tier"));
});

test("DELETE /sponsor-packages/:id: blocked when has user assignments", async () => {
  const { app, jwt, state } = await appAs("platform_admin");
  const eventId = await createDraftEvent(app, jwt);
  const sponsorOrg = state.organizations.find((o) => o.type === "sponsor");
  const pkgRes = await app.inject({
    method: "POST",
    path: `/events/${eventId}/sponsor-packages`,
    headers: bearer(jwt),
    body: { name: "Gold", tier: "gold", org_id: sponsorOrg.id }
  });
  const packageId = pkgRes.body.package_id;

  // Link a user role assignment to this package
  state.userRoleAssignments.push({
    id: "ura-sponsor-pkg-test",
    tenant_id: "tenant-demo",
    user_id: state.users.find((u) => u.role === "sponsor_user").id,
    role: "sponsor_user",
    event_id: eventId,
    stall_ids: [],
    sponsor_package_id: packageId,
    assigned_by_user_id: state.users.find((u) => u.role === "platform_admin").id,
    created_at: new Date().toISOString()
  });

  const res = await app.inject({
    method: "DELETE",
    path: `/sponsor-packages/${packageId}`,
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error.includes("PACKAGE_HAS_USERS"));
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 4.7 — Data Policy
// ─────────────────────────────────────────────────────────────────────────────

test("POST /events/:id/data-policy: valid upsert works", async () => {
  const { app, jwt } = await appAs("platform_admin");
  const eventId = await createDraftEvent(app, jwt);
  const res = await app.inject({
    method: "POST",
    path: `/events/${eventId}/data-policy`,
    headers: bearer(jwt),
    body: {
      vendor_exports_enabled: true,
      sponsor_pii_enabled: false,
      require_export_approval: true,
      allow_crm_push: false,
      retention_days: 90,
      allow_cross_event_identity_graph: false
    }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(res.body.policy);
  assert.equal(res.body.policy.retention_days, 90);
  assert.equal(res.body.policy.vendor_exports_enabled, true);
});

test("POST /events/:id/data-policy: invalid retention_days returns 400", async () => {
  const { app, jwt } = await appAs("platform_admin");
  const eventId = await createDraftEvent(app, jwt);
  const res = await app.inject({
    method: "POST",
    path: `/events/${eventId}/data-policy`,
    headers: bearer(jwt),
    body: {
      vendor_exports_enabled: true,
      sponsor_pii_enabled: false,
      require_export_approval: true,
      allow_crm_push: false,
      retention_days: 45,
      allow_cross_event_identity_graph: false
    }
  });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error.includes("INVALID_RETENTION_DAYS"));
  assert.deepEqual(res.body.details.valid_values, [30, 60, 90, 180, 365]);
});

test("POST /events/:id/data-policy: upsert updates existing policy", async () => {
  const { app, jwt } = await appAs("platform_admin");
  const eventId = await createDraftEvent(app, jwt);

  await app.inject({
    method: "POST",
    path: `/events/${eventId}/data-policy`,
    headers: bearer(jwt),
    body: { retention_days: 30, vendor_exports_enabled: false, sponsor_pii_enabled: false, require_export_approval: true, allow_crm_push: false, allow_cross_event_identity_graph: false }
  });

  const res = await app.inject({
    method: "POST",
    path: `/events/${eventId}/data-policy`,
    headers: bearer(jwt),
    body: { retention_days: 60, vendor_exports_enabled: true, sponsor_pii_enabled: false, require_export_approval: true, allow_crm_push: false, allow_cross_event_identity_graph: false }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.policy.retention_days, 60);
  assert.equal(res.body.policy.vendor_exports_enabled, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 4.8 — GET /events/:id/checklist
// ─────────────────────────────────────────────────────────────────────────────

test("GET /events/:id/checklist: returns all false for empty event", async () => {
  const { app, jwt } = await appAs("platform_admin");
  const eventId = await createDraftEvent(app, jwt);
  const res = await app.inject({
    method: "GET",
    path: `/events/${eventId}/checklist`,
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.event_id, eventId);
  assert.equal(res.body.items.has_halls, false);
  assert.equal(res.body.items.has_stalls, false);
  assert.equal(res.body.items.has_sponsor_packages, false);
  assert.equal(res.body.items.has_data_policy, false);
  assert.equal(res.body.items.has_organizer_admin_user, false);
  assert.equal(res.body.items.has_branding_approved, false);
  assert.equal(res.body.items.has_device_assigned, false);
  assert.equal(res.body.ready_to_publish, false);
  assert.equal(res.body.ready_to_go_live, false);
});

test("GET /events/:id/checklist: returns correct true/false after scaffolding", async () => {
  const { app, jwt, state } = await appAs("platform_admin");
  const eventId = await createDraftEvent(app, jwt);
  await scaffoldPublishableEvent(app, jwt, state, eventId);

  const res = await app.inject({
    method: "GET",
    path: `/events/${eventId}/checklist`,
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.items.has_halls, true);
  assert.equal(res.body.items.has_stalls, true);
  assert.equal(res.body.items.has_sponsor_packages, true);
  assert.equal(res.body.items.has_data_policy, true);
  assert.equal(res.body.items.has_organizer_admin_user, true);
  assert.equal(res.body.ready_to_publish, true);
  // branding and device not yet set
  assert.equal(res.body.ready_to_go_live, false);
});
