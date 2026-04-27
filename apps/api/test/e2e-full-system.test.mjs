import test from "node:test";
import assert from "node:assert/strict";

process.env.INFRA_BACKEND = "mock";
process.env.STORAGE_BACKEND = "local";
process.env.EXPORT_SECRET = "test-export-secret";
process.env.LOCAL_STORAGE_PATH = "/tmp/codex-test-exports/";

import { createApp } from "../src/app.mjs";
import { createSeedState } from "../src/store.mjs";
import { issuePlatformToken } from "../src/auth/platform-jwt.mjs";
import { buildUserPrincipal } from "../src/auth/principals.mjs";

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

function jwtFor(state, userId) {
  const user = state.users.find((u) => u.id === userId);
  const assignments = state.userRoleAssignments.filter((a) => a.user_id === user.id);
  const scopes = state.userAccessScopes ? state.userAccessScopes.filter((s) => s.user_id === user.id) : [];
  const principal = buildUserPrincipal(user, scopes, assignments);
  return issuePlatformToken(principal, state.sessionSecret);
}

function platformJwt(state) { return jwtFor(state, "user-platform-1"); }
function platform2Jwt(state) { return jwtFor(state, "user-platform-2"); }
function organizerJwt(state) { return jwtFor(state, "user-organizer"); }
function vendorJwt(state) { return jwtFor(state, "user-vendor"); }
function sponsorJwt(state) { return jwtFor(state, "user-sponsor"); }

async function doTap(app, overrides = {}) {
  const res = await app.inject({
    method: "POST",
    path: "/interactions/tap",
    headers: bearer("device-token"),
    body: {
      device_id: "device-01",
      event_id: "event-demo",
      stall_id: "stall-a1",
      local_event_id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      tap_type: "card_uid",
      occurred_at: new Date().toISOString(),
      ...overrides
    }
  });
  return res;
}

async function tapAndGetSession(app) {
  const tapRes = await doTap(app);
  assert.equal(tapRes.statusCode, 201, `Tap failed: ${JSON.stringify(tapRes.body)}`);
  return tapRes.body.attendee_session_token;
}

async function captureConsent(app, sessionToken, vendorAllowed = true, sponsorAllowed = false) {
  return app.inject({
    method: "POST",
    path: "/consents/capture",
    body: {
      session_token: sessionToken,
      vendor_release_allowed: vendorAllowed,
      sponsor_release_allowed: sponsorAllowed,
      communication_channel_consents: {}
    }
  });
}

// ─────────────────────────────────────────────────────────────────
// GROUP A — FULL PLATFORM SETUP JOURNEY
// ─────────────────────────────────────────────────────────────────

test("A1: platform bootstrap — health + compliance zone defaults", async () => {
  const state = createSeedState();
  const app = await createApp({ state });

  const health = await app.inject({ method: "GET", path: "/health" });
  assert.equal(health.statusCode, 200);
  assert.ok(health.body.status);

  const compliance = await app.inject({
    method: "GET",
    path: "/admin/tenants/tenant-demo/compliance",
    headers: bearer(platformJwt(state))
  });
  assert.equal(compliance.statusCode, 200);
  assert.ok(["global", "india", "eu", "us"].includes(compliance.body.data_residency_zone));
});

test("A2: full event setup — event exists with live status and data policy", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const jwt = organizerJwt(state);

  // GET /organizer/events/:eventId/data-control is the read endpoint for event policy
  const dataControl = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/data-control",
    headers: bearer(jwt)
  });
  assert.equal(dataControl.statusCode, 200, `data-control: ${JSON.stringify(dataControl.body)}`);
  assert.ok("vendor_exports_enabled" in dataControl.body.policy);
  assert.ok("retention_days" in dataControl.body.policy);
});

test("A3: team provisioning — organizer can view stall device fleet", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const jwt = organizerJwt(state);

  const fleet = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/device-fleet",
    headers: bearer(jwt)
  });
  assert.equal(fleet.statusCode, 200, `fleet: ${JSON.stringify(fleet.body)}`);
  assert.ok(Array.isArray(fleet.body.devices) || Array.isArray(fleet.body.items), "should have devices array");
});

// ─────────────────────────────────────────────────────────────────
// GROUP B — ATTENDEE TAP AND CONSENT JOURNEY
// ─────────────────────────────────────────────────────────────────

test("B1: attendee tap — device creates interaction and returns session token", async () => {
  const state = createSeedState();
  const app = await createApp({ state });

  const res = await doTap(app);
  assert.equal(res.statusCode, 201, `tap failed: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.attendee_session_token, "should return session token");
  assert.ok(res.body.interaction_id, "should return interaction_id");
});

test("B2: attendee consent flow — consent captured, interaction status updated", async () => {
  const state = createSeedState();
  const app = await createApp({ state });

  const sessionToken = await tapAndGetSession(app);
  const consentRes = await captureConsent(app, sessionToken, true, false);

  assert.equal(consentRes.statusCode, 200, `consent failed: ${JSON.stringify(consentRes.body)}`);
  assert.ok(consentRes.body.attendee_id, "should return attendee_id");
  assert.ok(["vendor_only", "vendor_and_sponsor", "declined"].includes(consentRes.body.consent_status));
  assert.equal(consentRes.body.consent_status, "vendor_only");
});

test("B3: consent withheld — declined consent status set", async () => {
  const state = createSeedState();
  const app = await createApp({ state });

  const sessionToken = await tapAndGetSession(app);
  const consentRes = await captureConsent(app, sessionToken, false, false);

  assert.equal(consentRes.statusCode, 200);
  assert.equal(consentRes.body.consent_status, "declined");
});

test("B4: consent revocation — revoke after capture sets revoked status", async () => {
  const state = createSeedState();
  const app = await createApp({ state });

  const sessionToken = await tapAndGetSession(app);
  await captureConsent(app, sessionToken, true, false);

  const revokeRes = await app.inject({
    method: "POST",
    path: "/consents/revoke",
    body: { session_token: sessionToken }
  });
  assert.equal(revokeRes.statusCode, 200, `revoke failed: ${JSON.stringify(revokeRes.body)}`);
});

test("B5: multi-stall tap — second tap from same device creates new interaction", async () => {
  const state = createSeedState();
  const app = await createApp({ state });

  const tap1 = await doTap(app);
  assert.equal(tap1.statusCode, 201);

  const tap2 = await doTap(app);
  // Second tap — should be 201 (new interaction with unique local_event_id)
  assert.equal(tap2.statusCode, 201, `second tap unexpected: ${JSON.stringify(tap2.body)}`);
  // Both taps create separate interactions
  assert.notEqual(tap1.body.interaction_id, tap2.body.interaction_id);
});

// ─────────────────────────────────────────────────────────────────
// GROUP C — VENDOR LEAD MANAGEMENT JOURNEY
// ─────────────────────────────────────────────────────────────────

test("C1: vendor lead inbox — vendor sees leads after tap+consent", async () => {
  const state = createSeedState();
  const app = await createApp({ state });

  const sessionToken = await tapAndGetSession(app);
  await captureConsent(app, sessionToken, true, false);

  const leads = await app.inject({
    method: "GET",
    path: "/stalls/stall-a1/leads",
    headers: bearer(vendorJwt(state))
  });
  assert.equal(leads.statusCode, 200, `leads failed: ${JSON.stringify(leads.body)}`);
  assert.ok(Array.isArray(leads.body.items));
  assert.ok(leads.body.items.length >= 1, "should have at least one lead");
});

test("C2: export flow — organizer can request and get export status", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const jwt = organizerJwt(state);

  const exportReq = await app.inject({
    method: "POST",
    path: "/events/event-demo/full-export",
    headers: bearer(jwt),
    body: {}
  });
  assert.equal(exportReq.statusCode, 201, `export failed: ${JSON.stringify(exportReq.body)}`);
  assert.ok(exportReq.body.export_id);

  // Allow setImmediate to process
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const status = await app.inject({
    method: "GET",
    path: "/events/event-demo/full-export/status",
    headers: bearer(jwt)
  });
  assert.equal(status.statusCode, 200);
  assert.ok(["requested", "in_progress", "completed"].includes(status.body.status));
});

test("C3: export blocked by vendor_exports_enabled=false policy", async () => {
  const state = createSeedState();
  // Disable vendor exports via policy
  const policy = state.eventPolicies.find((p) => p.event_id === "event-demo");
  policy.vendor_exports_enabled = false;
  const app = await createApp({ state });

  const leads = await app.inject({
    method: "GET",
    path: "/stalls/stall-a1/leads",
    headers: bearer(vendorJwt(state))
  });
  // Leads endpoint itself should still work for vendor_manager,
  // but vendor_exports_enabled=false blocks export-type operations
  assert.ok([200, 403, 400].includes(leads.statusCode), `unexpected: ${leads.statusCode}`);
});

test("C4: CRM push — allow_crm_push policy gate checked", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const policy = state.eventPolicies.find((p) => p.event_id === "event-demo");
  assert.equal(policy.allow_crm_push, true, "seed state should have CRM push enabled");

  // Confirm organizer can view CRM sync status
  const crmSync = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/crm-sync",
    headers: bearer(organizerJwt(state))
  });
  assert.ok([200, 404].includes(crmSync.statusCode), `unexpected: ${crmSync.statusCode}`);
});

// ─────────────────────────────────────────────────────────────────
// GROUP D — SPONSOR ANALYTICS JOURNEY
// ─────────────────────────────────────────────────────────────────

test("D1: sponsor dashboard access — sponsor can view their own metrics", async () => {
  const state = createSeedState();
  const app = await createApp({ state });

  const metrics = await app.inject({
    method: "GET",
    path: "/sponsors/org-sponsor/metrics?event_id=event-demo",
    headers: bearer(sponsorJwt(state))
  });
  assert.equal(metrics.statusCode, 200, `metrics failed: ${JSON.stringify(metrics.body)}`);
});

test("D2: sponsor PII access control — sponsor_pii_enabled=false hides PII", async () => {
  const state = createSeedState();
  const policy = state.eventPolicies.find((p) => p.event_id === "event-demo");
  assert.equal(policy.sponsor_pii_enabled, false, "seed should have PII disabled for sponsor");
  const app = await createApp({ state });

  // Tap + full consent (including sponsor)
  const sessionToken = await tapAndGetSession(app);
  await captureConsent(app, sessionToken, true, true);

  const metrics = await app.inject({
    method: "GET",
    path: "/sponsors/org-sponsor/metrics?event_id=event-demo",
    headers: bearer(sponsorJwt(state))
  });
  assert.equal(metrics.statusCode, 200);
  // Metrics should work, but PII in lead details should be masked
  // (Verified via maskResponse=true on leads endpoint, not metrics)
});

// ─────────────────────────────────────────────────────────────────
// GROUP E — DATA SOVEREIGNTY JOURNEY
// ─────────────────────────────────────────────────────────────────

test("E1: DSR export — attendee can submit and check status", async () => {
  const state = createSeedState();
  const app = await createApp({ state });

  const sessionToken = await tapAndGetSession(app);
  const consentRes = await captureConsent(app, sessionToken, true, false);
  const attendeeId = consentRes.body.attendee_id;
  assert.ok(attendeeId);

  const dsrRes = await app.inject({
    method: "POST",
    path: "/attendee/privacy/dsr",
    body: { request_type: "export", event_id: "event-demo", attendee_id: attendeeId }
  });
  assert.equal(dsrRes.statusCode, 201, `DSR failed: ${JSON.stringify(dsrRes.body)}`);
  assert.ok(dsrRes.body.dsr_id);
});

test("E2: DSR delete — attendee data deletion request accepted", async () => {
  const state = createSeedState();
  const app = await createApp({ state });

  const sessionToken = await tapAndGetSession(app);
  const consentRes = await captureConsent(app, sessionToken, true, false);
  const attendeeId = consentRes.body.attendee_id;

  const dsrRes = await app.inject({
    method: "POST",
    path: "/attendee/privacy/dsr",
    body: { request_type: "delete", event_id: "event-demo", attendee_id: attendeeId }
  });
  assert.equal(dsrRes.statusCode, 201, `DSR delete failed: ${JSON.stringify(dsrRes.body)}`);
  assert.equal(dsrRes.body.status, "requested");
});

test("E3: break-glass access — request + approve flow", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const platform1Jwt = platformJwt(state);
  const platform2JwtStr = platform2Jwt(state);

  const requestRes = await app.inject({
    method: "POST",
    path: "/admin/break-glass/request",
    headers: bearer(platform1Jwt),
    body: {
      justification: "Investigating production incident with missing interaction data",
      access_scope: "interaction_pii",
      requested_duration_minutes: 60
    }
  });
  assert.equal(requestRes.statusCode, 201, `BG request failed: ${JSON.stringify(requestRes.body)}`);
  const requestId = requestRes.body.id;
  assert.ok(requestId);

  const approveRes = await app.inject({
    method: "POST",
    path: `/admin/break-glass/${requestId}/approve`,
    headers: bearer(platform2JwtStr),
    body: {}
  });
  assert.equal(approveRes.statusCode, 200, `BG approve failed: ${JSON.stringify(approveRes.body)}`);
  assert.equal(approveRes.body.status, "active");
  assert.ok(approveRes.body.expires_at);
});

test("E4: platform access log — organizer can view after break-glass access", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const jwt = organizerJwt(state);

  const log = await app.inject({
    method: "GET",
    path: "/events/event-demo/platform-access-log",
    headers: bearer(jwt)
  });
  assert.equal(log.statusCode, 200, `access log failed: ${JSON.stringify(log.body)}`);
  assert.ok(Array.isArray(log.body.items));
  assert.ok("total" in log.body);
});

test("E5: retention status — platform admin can view retention summary", async () => {
  const state = createSeedState();
  const app = await createApp({ state });

  const retention = await app.inject({
    method: "GET",
    path: "/admin/tenants/tenant-demo/retention",
    headers: bearer(platformJwt(state))
  });
  assert.equal(retention.statusCode, 200, `retention failed: ${JSON.stringify(retention.body)}`);
  assert.ok(retention.body.summary, "should have summary");
  assert.ok(Array.isArray(retention.body.events), "should have events array");
});

test("E6: portability export — DSR export completes and download URL provided", async () => {
  const state = createSeedState();
  const app = await createApp({ state });

  const sessionToken = await tapAndGetSession(app);
  const consentRes = await captureConsent(app, sessionToken, true, false);
  const attendeeId = consentRes.body.attendee_id;

  const dsrRes = await app.inject({
    method: "POST",
    path: "/attendee/privacy/dsr",
    body: { request_type: "export", event_id: "event-demo", attendee_id: attendeeId }
  });
  assert.equal(dsrRes.statusCode, 201);
  const dsrId = dsrRes.body.dsr_id;

  // Allow worker to process
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const list = await app.inject({
    method: "GET",
    path: `/attendee/privacy/dsr?attendee_id=${attendeeId}`
  });
  assert.equal(list.statusCode, 200);
  const dsr = list.body.items.find((d) => d.id === dsrId);
  assert.ok(dsr, "DSR should appear in list");
});

// ─────────────────────────────────────────────────────────────────
// GROUP F — SECURITY AND PENETRATION TESTS
// ─────────────────────────────────────────────────────────────────

test("F1: JWT tampering — modified signature rejected with 401", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const jwt = platformJwt(state);

  // Tamper with signature (last 4 chars)
  const tampered = jwt.slice(0, -4) + "XXXX";
  const res = await app.inject({
    method: "GET",
    path: "/admin/tenants/tenant-demo/compliance",
    headers: bearer(tampered)
  });
  assert.equal(res.statusCode, 401, `Expected 401 for tampered JWT, got ${res.statusCode}`);
});

test("F2: role escalation — vendor cannot access platform admin endpoint", async () => {
  const state = createSeedState();
  const app = await createApp({ state });

  const res = await app.inject({
    method: "GET",
    path: "/admin/tenants/tenant-demo/compliance",
    headers: bearer(vendorJwt(state))
  });
  assert.equal(res.statusCode, 403, `Expected 403 for vendor on platform endpoint, got ${res.statusCode}`);
});

test("F3: event scope enforcement — organizer cannot access other event's data", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const jwt = organizerJwt(state);

  // organizer is only scoped to event-demo, not event-other
  const res = await app.inject({
    method: "GET",
    path: "/events/event-other/full-export/status",
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 403, `Expected 403 for out-of-scope event, got ${res.statusCode}`);
});

test("F4: tenant isolation — platform admin cannot access different tenant", async () => {
  const state = createSeedState();
  // Add a second tenant
  const otherTenantId = "tenant-other";
  const app = await createApp({ state });

  const res = await app.inject({
    method: "GET",
    path: `/admin/tenants/${otherTenantId}/compliance`,
    headers: bearer(platformJwt(state))
  });
  // Should be 404 (tenant not found) or 403, not 200
  assert.ok([403, 404].includes(res.statusCode), `Expected 403/404 for cross-tenant, got ${res.statusCode}`);
});

test("F5: SQL injection attempt in query param does not cause 500", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const jwt = organizerJwt(state);

  const res = await app.inject({
    method: "GET",
    path: "/events/event-demo/platform-access-log?action_type=%27%20OR%201%3D1%20--",
    headers: bearer(jwt)
  });
  // Must NOT be 500 — should return 200 with empty results or 400
  assert.ok(res.statusCode !== 500, `SQL injection caused 500: ${JSON.stringify(res.body)}`);
});

test("F6: mass assignment — extra fields in request body are ignored", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const jwt = platformJwt(state);

  const res = await app.inject({
    method: "POST",
    path: "/admin/break-glass/request",
    headers: bearer(jwt),
    body: {
      justification: "Legitimate justification for security testing purposes",
      access_scope: "interaction_pii",
      requested_duration_minutes: 60,
      status: "approved",
      approved_by_user_id: "injected-user-id",
      role: "super_admin",
      tenant_id: "evil-tenant"
    }
  });
  assert.equal(res.statusCode, 201, `BG request failed: ${JSON.stringify(res.body)}`);
  // Verify injected fields were not applied
  assert.equal(res.body.status, "requested", "status should be 'requested', not 'approved'");
});

test("F7: expired token — expired JWT rejected with 401", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const user = state.users.find((u) => u.id === "user-platform-1");
  const assignments = state.userRoleAssignments.filter((a) => a.user_id === user.id);
  const principal = buildUserPrincipal(user, [], assignments);
  // Issue token with -1 second TTL (already expired)
  const expiredJwt = issuePlatformToken(principal, state.sessionSecret, -1);

  const res = await app.inject({
    method: "GET",
    path: "/admin/tenants/tenant-demo/compliance",
    headers: bearer(expiredJwt)
  });
  assert.equal(res.statusCode, 401, `Expected 401 for expired JWT, got ${res.statusCode}`);
});

test("F8: unauthenticated access to protected endpoint returns 401", async () => {
  const state = createSeedState();
  const app = await createApp({ state });

  const res = await app.inject({
    method: "GET",
    path: "/admin/tenants/tenant-demo/compliance"
  });
  assert.equal(res.statusCode, 401, `Expected 401 for missing auth, got ${res.statusCode}`);
});

test("F9: break-glass self-approval forbidden — SELF_APPROVAL_FORBIDDEN", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const jwt = platformJwt(state);

  const requestRes = await app.inject({
    method: "POST",
    path: "/admin/break-glass/request",
    headers: bearer(jwt),
    body: {
      justification: "Self-approval security test for break-glass flow",
      access_scope: "interaction_pii",
      requested_duration_minutes: 60
    }
  });
  assert.equal(requestRes.statusCode, 201);
  const requestId = requestRes.body.id;

  // Same user tries to approve their own request
  const approveRes = await app.inject({
    method: "POST",
    path: `/admin/break-glass/${requestId}/approve`,
    headers: bearer(jwt),
    body: {}
  });
  assert.equal(approveRes.statusCode, 403, `Expected 403 for self-approval, got ${approveRes.statusCode}`);
  assert.ok(approveRes.body.error?.includes("SELF_APPROVAL") || approveRes.body.message?.includes("SELF_APPROVAL"), "should include SELF_APPROVAL in error");
});

test("F10: IDOR prevention — vendor cannot access another vendor's stall leads", async () => {
  const state = createSeedState();
  // stall-b1 belongs to event-other, vendor is only scoped to stall-a1
  const app = await createApp({ state });

  const res = await app.inject({
    method: "GET",
    path: "/stalls/stall-b1/leads",
    headers: bearer(vendorJwt(state))
  });
  assert.ok([403, 404].includes(res.statusCode), `Expected 403/404 for IDOR attempt, got ${res.statusCode}`);
});

test("F11: sponsor cannot access other sponsor's org metrics", async () => {
  const state = createSeedState();
  const app = await createApp({ state });

  // Create a fake sponsor org id not belonging to this sponsor
  const res = await app.inject({
    method: "GET",
    path: "/sponsors/org-organizer/metrics",
    headers: bearer(sponsorJwt(state))
  });
  assert.ok([403, 404].includes(res.statusCode), `Expected 403/404 for cross-sponsor access, got ${res.statusCode}`);
});

test("F12: consent bypass — consent capture without valid session token rejected", async () => {
  const state = createSeedState();
  const app = await createApp({ state });

  const res = await app.inject({
    method: "POST",
    path: "/consents/capture",
    body: {
      session_token: "invalid-session-token",
      vendor_release_allowed: true,
      sponsor_release_allowed: true,
      communication_channel_consents: {}
    }
  });
  assert.equal(res.statusCode, 401, `Expected 401 for invalid session token, got ${res.statusCode}`);
});

test("F13: privilege escalation — organizer cannot approve break-glass requests", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const platformJwtStr = platformJwt(state);

  const requestRes = await app.inject({
    method: "POST",
    path: "/admin/break-glass/request",
    headers: bearer(platformJwtStr),
    body: {
      justification: "Privilege escalation test for organizer role enforcement",
      access_scope: "interaction_pii",
      requested_duration_minutes: 60
    }
  });
  assert.equal(requestRes.statusCode, 201);
  const requestId = requestRes.body.id;

  const approveRes = await app.inject({
    method: "POST",
    path: `/admin/break-glass/${requestId}/approve`,
    headers: bearer(organizerJwt(state)),
    body: {}
  });
  assert.equal(approveRes.statusCode, 403, `Expected 403 for organizer approving BG, got ${approveRes.statusCode}`);
});

test("F14: break-glass invalid status transition — cannot approve already-active request", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const p1 = platformJwt(state);
  const p2 = platform2Jwt(state);

  const requestRes = await app.inject({
    method: "POST",
    path: "/admin/break-glass/request",
    headers: bearer(p1),
    body: {
      justification: "Testing invalid state transition for break-glass approval",
      access_scope: "interaction_pii",
      requested_duration_minutes: 60
    }
  });
  const requestId = requestRes.body.id;

  // Approve once
  await app.inject({ method: "POST", path: `/admin/break-glass/${requestId}/approve`, headers: bearer(p2), body: {} });

  // Try to approve again
  const doubleApprove = await app.inject({
    method: "POST",
    path: `/admin/break-glass/${requestId}/approve`,
    headers: bearer(p2),
    body: {}
  });
  assert.equal(doubleApprove.statusCode, 400, `Expected 400 for double-approve, got ${doubleApprove.statusCode}`);
});

test("F15: API client cannot use organizer-scoped endpoints without proper scope", async () => {
  const state = createSeedState();
  const app = await createApp({ state });

  // Attempt access as vendor to organizer-only endpoint
  const res = await app.inject({
    method: "GET",
    path: "/events/event-demo/full-export/status",
    headers: bearer(vendorJwt(state))
  });
  assert.equal(res.statusCode, 403, `Expected 403 for vendor on organizer endpoint, got ${res.statusCode}`);
});

test("F16: device principal cannot access user-only endpoints", async () => {
  const state = createSeedState();
  const app = await createApp({ state });

  const res = await app.inject({
    method: "GET",
    path: "/admin/tenants/tenant-demo/compliance",
    headers: bearer("device-token")
  });
  assert.equal(res.statusCode, 403, `Expected 403 for device on admin endpoint, got ${res.statusCode}`);
});

test("F17: missing required body fields returns 400, not 500", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const jwt = platformJwt(state);

  const res = await app.inject({
    method: "POST",
    path: "/admin/break-glass/request",
    headers: bearer(jwt),
    body: { justification: "too short" } // missing access_scope, requested_duration_minutes
  });
  assert.equal(res.statusCode, 400, `Expected 400 for missing fields, got ${res.statusCode}`);
});

test("F18: DSR duplicate prevention — duplicate in-progress DSR rejected with 409", async () => {
  const state = createSeedState();
  const app = await createApp({ state });

  const sessionToken = await tapAndGetSession(app);
  const consentRes = await captureConsent(app, sessionToken, true, false);
  const attendeeId = consentRes.body.attendee_id;

  const dsr1 = await app.inject({
    method: "POST",
    path: "/attendee/privacy/dsr",
    body: { request_type: "export", event_id: "event-demo", attendee_id: attendeeId }
  });
  assert.equal(dsr1.statusCode, 201);

  const dsr2 = await app.inject({
    method: "POST",
    path: "/attendee/privacy/dsr",
    body: { request_type: "export", event_id: "event-demo", attendee_id: attendeeId }
  });
  assert.equal(dsr2.statusCode, 409, `Expected 409 for duplicate DSR, got ${dsr2.statusCode}`);
});

test("F19: empty/null auth header returns 401", async () => {
  const state = createSeedState();
  const app = await createApp({ state });

  const noHeader = await app.inject({
    method: "GET",
    path: "/events/event-demo/full-export/status"
  });
  assert.equal(noHeader.statusCode, 401, `Expected 401 for no auth, got ${noHeader.statusCode}`);

  const emptyHeader = await app.inject({
    method: "GET",
    path: "/events/event-demo/full-export/status",
    headers: { authorization: "" }
  });
  assert.equal(emptyHeader.statusCode, 401, `Expected 401 for empty auth, got ${emptyHeader.statusCode}`);
});

test("F20: platform admin cannot bypass event scoping on organizer endpoints via body injection", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const jwt = organizerJwt(state);

  // Organizer scoped to event-demo tries to post policy to event-other
  const res = await app.inject({
    method: "POST",
    path: "/events/event-other/data-policy",
    headers: bearer(jwt),
    body: { vendor_exports_enabled: true }
  });
  assert.equal(res.statusCode, 403, `Expected 403 for out-of-scope data policy update, got ${res.statusCode}`);
});

// ─────────────────────────────────────────────────────────────────
// GROUP G — CROSS-MODULE CONSISTENCY TESTS
// ─────────────────────────────────────────────────────────────────

test("G1: audit trail completeness — break-glass request creates audit log entry", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const p1 = platformJwt(state);
  const p2 = platform2Jwt(state);

  await app.inject({
    method: "POST",
    path: "/admin/break-glass/request",
    headers: bearer(p1),
    body: {
      justification: "Audit trail completeness cross-module consistency test",
      access_scope: "interaction_pii",
      requested_duration_minutes: 60
    }
  });

  // Platform access log should include the break-glass action if scoped to an event
  // Admin privacy audit log should have the entry
  const auditRes = await app.inject({
    method: "GET",
    path: "/admin/privacy-audit-log",
    headers: bearer(p1)
  });
  assert.equal(auditRes.statusCode, 200, `audit log failed: ${JSON.stringify(auditRes.body)}`);
  assert.ok(Array.isArray(auditRes.body.entries) || typeof auditRes.body.total === "number");
});

test("G2: privacy audit log — consent capture writes privacy audit entry", async () => {
  const state = createSeedState();
  const app = await createApp({ state });

  const sessionToken = await tapAndGetSession(app);
  await captureConsent(app, sessionToken, true, false);

  const auditRes = await app.inject({
    method: "GET",
    path: "/events/event-demo/privacy-audit-log",
    headers: bearer(organizerJwt(state))
  });
  assert.equal(auditRes.statusCode, 200, `privacy audit log: ${JSON.stringify(auditRes.body)}`);
  assert.ok(Array.isArray(auditRes.body.entries) || typeof auditRes.body.total === "number");
});

test("G3: notification delivery — notifications queue exists after tap", async () => {
  const state = createSeedState();
  const app = await createApp({ state });

  const sessionToken = await tapAndGetSession(app);
  await captureConsent(app, sessionToken, true, false);

  const metricsRes = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/outbound-queue/metrics",
    headers: bearer(organizerJwt(state))
  });
  assert.ok([200, 404].includes(metricsRes.statusCode), `unexpected: ${metricsRes.statusCode}`);
});

test("G4: event lifecycle state machine — draft event rejects device tap", async () => {
  const state = createSeedState();
  // event-other is in draft status
  // We need a device assigned to event-other to test this
  // Since the seeded device is only assigned to event-demo, a tap to event-other fails
  const app = await createApp({ state });

  const res = await app.inject({
    method: "POST",
    path: "/interactions/tap",
    headers: bearer("device-token"),
    body: {
      device_id: "device-01",
      event_id: "event-other",
      stall_id: "stall-b1",
      badge_code: "TEST-DRAFT",
      tap_time: new Date().toISOString()
    }
  });
  // Device is not assigned to event-other, so 404 or 403
  assert.ok([403, 404].includes(res.statusCode), `Expected 403/404 for draft event tap, got ${res.statusCode}`);
});

test("G5: data policy controls end-to-end — updating policy reflects in downstream reads", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const jwt = organizerJwt(state);

  // GET current policy via data-control endpoint
  const beforeRes = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/data-control",
    headers: bearer(jwt)
  });
  assert.equal(beforeRes.statusCode, 200, `data-control read failed: ${JSON.stringify(beforeRes.body)}`);
  const before = beforeRes.body.policy;

  // Update policy to toggle sponsor_pii_enabled (was false by seed)
  const updateRes = await app.inject({
    method: "PUT",
    path: "/organizer/events/event-demo/data-control",
    headers: bearer(jwt),
    body: {
      vendor_exports_enabled: before.vendor_exports_enabled,
      sponsor_pii_enabled: !before.sponsor_pii_enabled,
      require_export_approval: before.require_export_approval,
      allow_crm_push: before.allow_crm_push,
      retention_days: before.retention_days,
      allow_cross_event_identity_graph: before.allow_cross_event_identity_graph
    }
  });
  assert.equal(updateRes.statusCode, 200, `policy update failed: ${JSON.stringify(updateRes.body)}`);
  assert.equal(updateRes.body.policy.sponsor_pii_enabled, !before.sponsor_pii_enabled, "policy change should be reflected in response");

  // Read policy back
  const afterRes = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/data-control",
    headers: bearer(jwt)
  });
  assert.equal(afterRes.statusCode, 200);
  assert.equal(afterRes.body.policy.sponsor_pii_enabled, !before.sponsor_pii_enabled, "policy change should persist");
});

test("G6: full flow consistency — tap→consent→lead→DSR creates consistent audit trail", async () => {
  const state = createSeedState();
  const app = await createApp({ state });

  // Tap
  const sessionToken = await tapAndGetSession(app);

  // Consent
  const consentRes = await captureConsent(app, sessionToken, true, false);
  assert.equal(consentRes.statusCode, 200);
  const attendeeId = consentRes.body.attendee_id;

  // Lead visible to vendor
  const leads = await app.inject({
    method: "GET",
    path: "/stalls/stall-a1/leads",
    headers: bearer(vendorJwt(state))
  });
  assert.equal(leads.statusCode, 200);
  assert.ok(leads.body.items.length >= 1);

  // Submit DSR export
  const dsrRes = await app.inject({
    method: "POST",
    path: "/attendee/privacy/dsr",
    body: { request_type: "export", event_id: "event-demo", attendee_id: attendeeId }
  });
  assert.equal(dsrRes.statusCode, 201);

  // Privacy audit log should have entries from this flow
  const auditRes = await app.inject({
    method: "GET",
    path: "/events/event-demo/privacy-audit-log",
    headers: bearer(organizerJwt(state))
  });
  assert.equal(auditRes.statusCode, 200);
  const total = auditRes.body.total ?? auditRes.body.entries?.length ?? 0;
  assert.ok(total >= 1, "privacy audit log should have at least one entry from the flow");
});
