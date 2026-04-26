import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

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

function jwtFor(state, userId) {
  const user = state.users.find((u) => u.id === userId);
  const assignments = state.userRoleAssignments.filter((a) => a.user_id === user.id);
  const principal = buildUserPrincipal(user, [], assignments);
  return issuePlatformToken(principal, state.sessionSecret);
}

function adminJwt(state) {
  return jwtFor(state, "user-platform-1");
}

function admin2Jwt(state) {
  return jwtFor(state, "user-platform-2");
}

// ─────────────────────────────────────────────────────────────
// Group 1: Admin break-glass — request (2 tests)
// ─────────────────────────────────────────────────────────────

test("Admin break-glass: request creates record with status=requested and dispatches notification", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = adminJwt(state);

  const res = await app.inject({
    method: "POST",
    path: "/admin/break-glass/request",
    headers: bearer(jwt),
    body: {
      justification: "Emergency debug of attendee data incident",
      access_scope: "incident_debug",
      requested_duration_minutes: 60
    }
  });

  assert.equal(res.statusCode, 201);
  assert.ok(res.body.id);
  assert.equal(res.body.status, "requested");

  const notif = state.notifications.find((n) => n.message_type === "break_glass_pending_approval");
  assert.ok(notif, "break_glass_pending_approval notification should be dispatched");
});

test("Admin break-glass: request validation — short justification and invalid scope rejected", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = adminJwt(state);

  const shortJust = await app.inject({
    method: "POST",
    path: "/admin/break-glass/request",
    headers: bearer(jwt),
    body: { justification: "Too short", access_scope: "incident_debug", requested_duration_minutes: 60 }
  });
  assert.equal(shortJust.statusCode, 400);

  const badScope = await app.inject({
    method: "POST",
    path: "/admin/break-glass/request",
    headers: bearer(jwt),
    body: { justification: "Investigating an attendee data export issue", access_scope: "invalid_scope", requested_duration_minutes: 60 }
  });
  assert.equal(badScope.statusCode, 400);

  const badDuration = await app.inject({
    method: "POST",
    path: "/admin/break-glass/request",
    headers: bearer(jwt),
    body: { justification: "Investigating an attendee data export issue", access_scope: "incident_debug", requested_duration_minutes: 45 }
  });
  assert.equal(badDuration.statusCode, 400);
});

// ─────────────────────────────────────────────────────────────
// Group 2: Admin break-glass — list and get (2 tests)
// ─────────────────────────────────────────────────────────────

test("Admin break-glass: list returns all requests and supports status filter", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = adminJwt(state);

  await app.inject({
    method: "POST",
    path: "/admin/break-glass/request",
    headers: bearer(jwt),
    body: { justification: "Debugging PII export discrepancy for event", access_scope: "export_review", requested_duration_minutes: 30 }
  });

  const listRes = await app.inject({ method: "GET", path: "/admin/break-glass", headers: bearer(jwt) });
  assert.equal(listRes.statusCode, 200);
  assert.ok(Array.isArray(listRes.body.items));
  assert.ok(listRes.body.items.length >= 1);

  const filtered = await app.inject({ method: "GET", path: "/admin/break-glass?status=requested", headers: bearer(jwt) });
  assert.equal(filtered.statusCode, 200);
  assert.ok(filtered.body.items.every((r) => r.status === "requested"));
});

test("Admin break-glass: get returns single request with requester name", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = adminJwt(state);

  const createRes = await app.inject({
    method: "POST",
    path: "/admin/break-glass/request",
    headers: bearer(jwt),
    body: { justification: "Attendee PII incident investigation in progress", access_scope: "attendee_pii", requested_duration_minutes: 120 }
  });
  const requestId = createRes.body.id;

  const res = await app.inject({ method: "GET", path: `/admin/break-glass/${requestId}`, headers: bearer(jwt) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.id, requestId);
  assert.equal(res.body.status, "requested");
  assert.ok(res.body.requested_by_name, "Should include requester display name");
});

// ─────────────────────────────────────────────────────────────
// Group 3: Admin break-glass — approve (3 tests)
// ─────────────────────────────────────────────────────────────

test("Admin break-glass: approve transitions to active with expires_at set", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt1 = adminJwt(state);
  const jwt2 = admin2Jwt(state);

  const createRes = await app.inject({
    method: "POST",
    path: "/admin/break-glass/request",
    headers: bearer(jwt1),
    body: { justification: "Investigating interaction PII access for stall data audit", access_scope: "interaction_pii", requested_duration_minutes: 60 }
  });
  const requestId = createRes.body.id;

  const approveRes = await app.inject({
    method: "POST",
    path: `/admin/break-glass/${requestId}/approve`,
    headers: bearer(jwt2),
    body: {}
  });

  assert.equal(approveRes.statusCode, 200);
  assert.equal(approveRes.body.status, "active");
  assert.ok(approveRes.body.expires_at, "Should have an expires_at timestamp");

  const auditEntry = state.auditLogs.find(
    (e) => e.event_type === AUDIT_EVENT_TYPES.BREAK_GLASS_APPROVED && e.target_id === requestId
  );
  assert.ok(auditEntry, "Audit event should be written for approval");
});

test("Admin break-glass: self-approval is blocked with 403", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = adminJwt(state);

  const createRes = await app.inject({
    method: "POST",
    path: "/admin/break-glass/request",
    headers: bearer(jwt),
    body: { justification: "Self approval attempt for security test audit", access_scope: "incident_debug", requested_duration_minutes: 30 }
  });
  const requestId = createRes.body.id;

  const res = await app.inject({
    method: "POST",
    path: `/admin/break-glass/${requestId}/approve`,
    headers: bearer(jwt),
    body: {}
  });

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "SELF_APPROVAL_FORBIDDEN");
});

test("Admin break-glass: cannot approve an already-active or rejected request", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt1 = adminJwt(state);
  const jwt2 = admin2Jwt(state);

  const createRes = await app.inject({
    method: "POST",
    path: "/admin/break-glass/request",
    headers: bearer(jwt1),
    body: { justification: "First approval then try double approval guard test", access_scope: "export_review", requested_duration_minutes: 30 }
  });
  const requestId = createRes.body.id;

  await app.inject({ method: "POST", path: `/admin/break-glass/${requestId}/approve`, headers: bearer(jwt2), body: {} });

  const doubleApprove = await app.inject({
    method: "POST",
    path: `/admin/break-glass/${requestId}/approve`,
    headers: bearer(jwt2),
    body: {}
  });
  assert.equal(doubleApprove.statusCode, 400);
});

// ─────────────────────────────────────────────────────────────
// Group 4: Admin break-glass — reject and revoke (3 tests)
// ─────────────────────────────────────────────────────────────

test("Admin break-glass: reject transitions to rejected with reason, writes audit", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt1 = adminJwt(state);
  const jwt2 = admin2Jwt(state);

  const createRes = await app.inject({
    method: "POST",
    path: "/admin/break-glass/request",
    headers: bearer(jwt1),
    body: { justification: "Request to be rejected for test verification purposes", access_scope: "attendee_pii", requested_duration_minutes: 60 }
  });
  const requestId = createRes.body.id;

  const res = await app.inject({
    method: "POST",
    path: `/admin/break-glass/${requestId}/reject`,
    headers: bearer(jwt2),
    body: { rejection_reason: "Not a valid emergency escalation" }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "rejected");

  const auditEntry = state.auditLogs.find(
    (e) => e.event_type === AUDIT_EVENT_TYPES.BREAK_GLASS_REJECTED && e.target_id === requestId
  );
  assert.ok(auditEntry, "Audit event should be written for rejection");
});

test("Admin break-glass: reject requires rejection_reason", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt1 = adminJwt(state);
  const jwt2 = admin2Jwt(state);

  const createRes = await app.inject({
    method: "POST",
    path: "/admin/break-glass/request",
    headers: bearer(jwt1),
    body: { justification: "Rejection without reason test scenario validation check", access_scope: "incident_debug", requested_duration_minutes: 30 }
  });
  const requestId = createRes.body.id;

  const res = await app.inject({
    method: "POST",
    path: `/admin/break-glass/${requestId}/reject`,
    headers: bearer(jwt2),
    body: {}
  });
  assert.equal(res.statusCode, 400);
});

test("Admin break-glass: revoke transitions active session to revoked", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt1 = adminJwt(state);
  const jwt2 = admin2Jwt(state);

  const createRes = await app.inject({
    method: "POST",
    path: "/admin/break-glass/request",
    headers: bearer(jwt1),
    body: { justification: "Revocation test — escalation no longer needed now", access_scope: "interaction_pii", requested_duration_minutes: 240 }
  });
  const requestId = createRes.body.id;

  await app.inject({ method: "POST", path: `/admin/break-glass/${requestId}/approve`, headers: bearer(jwt2), body: {} });

  const res = await app.inject({
    method: "POST",
    path: `/admin/break-glass/${requestId}/revoke`,
    headers: bearer(jwt1),
    body: {}
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "revoked");

  const auditEntry = state.auditLogs.find(
    (e) => e.event_type === AUDIT_EVENT_TYPES.BREAK_GLASS_REVOKED && e.target_id === requestId
  );
  assert.ok(auditEntry, "Audit event should be written for revocation");
});

// ─────────────────────────────────────────────────────────────
// Group 5: Device provisioning — full CRUD (5 tests)
// ─────────────────────────────────────────────────────────────

test("Device: GET /devices/:deviceId returns device and nfc_reader field", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = adminJwt(state);

  const res = await app.inject({
    method: "GET",
    path: "/devices/device-01",
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.device.id, "device-01");
  assert.ok("nfc_reader" in res.body, "Response should include nfc_reader field");
});

test("Device: PATCH /devices/:deviceId transitions inventory→repair then repair→inventory", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = adminJwt(state);

  const createRes = await app.inject({
    method: "POST",
    path: "/devices",
    headers: bearer(jwt),
    body: { serial_number: "SN-PATCH-TEST", name: "Patch Test Device" }
  });
  assert.equal(createRes.statusCode, 201);
  const deviceId = createRes.body.device_id;

  const toRepair = await app.inject({
    method: "PATCH",
    path: `/devices/${deviceId}`,
    headers: bearer(jwt),
    body: { status: "repair" }
  });
  assert.equal(toRepair.statusCode, 200);
  assert.equal(toRepair.body.device.status, "repair");

  const toInventory = await app.inject({
    method: "PATCH",
    path: `/devices/${deviceId}`,
    headers: bearer(jwt),
    body: { status: "inventory" }
  });
  assert.equal(toInventory.statusCode, 200);
  assert.equal(toInventory.body.device.status, "inventory");
});

test("Device: PATCH invalid status transition returns 400", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = adminJwt(state);

  const createRes = await app.inject({
    method: "POST",
    path: "/devices",
    headers: bearer(jwt),
    body: { serial_number: "SN-BAD-TRANS", name: "Bad Trans Device" }
  });
  const deviceId = createRes.body.device_id;

  const res = await app.inject({
    method: "PATCH",
    path: `/devices/${deviceId}`,
    headers: bearer(jwt),
    body: { status: "live" }
  });
  assert.equal(res.statusCode, 400);
});

test("Device: assign then unassign returns device to inventory status", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = adminJwt(state);

  const createRes = await app.inject({
    method: "POST",
    path: "/devices",
    headers: bearer(jwt),
    body: { serial_number: "SN-UNASSIGN", name: "Unassign Device" }
  });
  const deviceId = createRes.body.device_id;

  const freeStall = state.stalls.find(
    (s) => !state.deviceAssignments.some((da) => da.stall_id === s.id && da.active)
  );

  await app.inject({
    method: "POST",
    path: `/devices/${deviceId}/assign`,
    headers: bearer(jwt),
    body: { stall_id: freeStall.id, event_id: freeStall.event_id }
  });

  const checkAssigned = state.devices.find((d) => d.id === deviceId);
  assert.equal(checkAssigned.status, "assigned");

  const unassignRes = await app.inject({
    method: "POST",
    path: `/devices/${deviceId}/unassign`,
    headers: bearer(jwt),
    body: {}
  });
  assert.equal(unassignRes.statusCode, 200);
  assert.equal(unassignRes.body.status, "inventory");

  const auditEntry = state.auditLogs.find(
    (e) => e.event_type === AUDIT_EVENT_TYPES.DEVICE_UNASSIGNED && e.target_id === deviceId
  );
  assert.ok(auditEntry, "Audit event should be written for unassignment");
});

test("Device: assign fails with STALL_ALREADY_HAS_DEVICE when stall has active assignment", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = adminJwt(state);

  const stallWithDevice = state.stalls.find(
    (s) => state.deviceAssignments.some((da) => da.stall_id === s.id && da.active)
  );

  const createRes = await app.inject({
    method: "POST",
    path: "/devices",
    headers: bearer(jwt),
    body: { serial_number: "SN-CONFLICT", name: "Conflict Device" }
  });
  const deviceId = createRes.body.device_id;

  const res = await app.inject({
    method: "POST",
    path: `/devices/${deviceId}/assign`,
    headers: bearer(jwt),
    body: { stall_id: stallWithDevice.id, event_id: stallWithDevice.event_id }
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, "STALL_ALREADY_HAS_DEVICE");
});

// ─────────────────────────────────────────────────────────────
// Group 6: NFC reader — pairing and update (2 tests)
// ─────────────────────────────────────────────────────────────

test("NFC reader: pair to device returns 201 with reader_id", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = adminJwt(state);

  const deviceRes = await app.inject({
    method: "POST",
    path: "/devices",
    headers: bearer(jwt),
    body: { serial_number: "SN-NFC-01", name: "NFC Device" }
  });
  const deviceId = deviceRes.body.device_id;

  const res = await app.inject({
    method: "POST",
    path: "/nfc-readers",
    headers: bearer(jwt),
    body: { device_id: deviceId, model: "ACR1252U", firmware_version: "3.1.0" }
  });
  assert.equal(res.statusCode, 201);
  assert.ok(res.body.reader_id);
  assert.equal(res.body.device_id, deviceId);
  assert.equal(res.body.model, "ACR1252U");
  assert.equal(res.body.firmware_version, "3.1.0");
});

test("NFC reader: PATCH updates firmware_version and appears in GET /devices/:deviceId", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = adminJwt(state);

  const deviceRes = await app.inject({
    method: "POST",
    path: "/devices",
    headers: bearer(jwt),
    body: { serial_number: "SN-NFC-02", name: "NFC Firmware Device" }
  });
  const deviceId = deviceRes.body.device_id;

  const pairRes = await app.inject({
    method: "POST",
    path: "/nfc-readers",
    headers: bearer(jwt),
    body: { device_id: deviceId, firmware_version: "1.0.0" }
  });
  const readerId = pairRes.body.reader_id;

  const patchRes = await app.inject({
    method: "PATCH",
    path: `/nfc-readers/${readerId}`,
    headers: bearer(jwt),
    body: { firmware_version: "2.5.0" }
  });
  assert.equal(patchRes.statusCode, 200);
  assert.equal(patchRes.body.reader.firmware_version, "2.5.0");

  const deviceGetRes = await app.inject({
    method: "GET",
    path: `/devices/${deviceId}`,
    headers: bearer(jwt)
  });
  assert.equal(deviceGetRes.body.nfc_reader?.firmware_version, "2.5.0");
});

// ─────────────────────────────────────────────────────────────
// Group 7: API client revocation enforcement (2 tests)
// ─────────────────────────────────────────────────────────────

test("API client: active client can authenticate and access a route", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = adminJwt(state);

  const createRes = await app.inject({
    method: "POST",
    path: "/admin/api-clients",
    headers: bearer(jwt),
    body: { name: "Auth Test Client", scopes: ["leads:export"] }
  });
  assert.equal(createRes.statusCode, 201);
  const clientSecret = createRes.body.client_secret;

  const hash = createHmac("sha256", state.sessionSecret).update(clientSecret).digest("hex");
  const clientRecord = state.apiClients.find((c) => c.client_secret_hash === hash);
  assert.ok(clientRecord, "Client record should exist in state");
  assert.equal(clientRecord.status, "active");
});

test("API client: revoked client returns 401 on subsequent requests", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = adminJwt(state);

  const createRes = await app.inject({
    method: "POST",
    path: "/admin/api-clients",
    headers: bearer(jwt),
    body: { name: "Revoke Enforcement Client", scopes: ["leads:export"] }
  });
  const clientSecret = createRes.body.client_secret;
  const clientRecord = state.apiClients.find(
    (c) => c.client_secret_hash === createHmac("sha256", state.sessionSecret).update(clientSecret).digest("hex")
  );

  await app.inject({
    method: "POST",
    path: `/admin/api-clients/${clientRecord.id}/revoke`,
    headers: bearer(jwt),
    body: {}
  });

  const revokedRecord = state.apiClients.find((c) => c.id === clientRecord.id);
  assert.equal(revokedRecord?.status, "revoked");

  const res = await app.inject({
    method: "GET",
    path: "/devices",
    headers: bearer(clientSecret)
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, "API_CLIENT_REVOKED");
});

// ─────────────────────────────────────────────────────────────
// Group 7: Expiry job simulation (1 test)
// ─────────────────────────────────────────────────────────────

test("Break-glass expiry job: expires active admin session with new schema and writes audit", async () => {
  const state = createSeedState();
  const app = await makeApp(state);

  const pastExpiry = new Date(Date.now() - 60_000).toISOString();
  state.breakGlassAccess.push({
    id: "bg-p13-expired",
    tenant_id: "tenant-demo",
    requested_by_user_id: "user-platform-1",
    approved_by_user_id: "user-platform-2",
    rejected_by_user_id: null,
    rejection_reason: null,
    justification: "Phase 13 expiry job simulation",
    access_scope: "incident_debug",
    event_id: null,
    requested_duration_minutes: 60,
    status: "active",
    starts_at: new Date(Date.now() - 120_000).toISOString(),
    expires_at: pastExpiry,
    revoked_at: null,
    created_at: new Date(Date.now() - 120_000).toISOString()
  });

  const { repos } = app;
  const expired = await runBreakGlassExpiry(repos, ["tenant-demo"]);
  assert.ok(expired.includes("bg-p13-expired"), "session should be in the expired list");

  const updated = state.breakGlassAccess.find((s) => s.id === "bg-p13-expired");
  assert.equal(updated.status, "expired", "status should be expired");

  const auditEntry = state.auditLogs.find(
    (e) => e.event_type === AUDIT_EVENT_TYPES.BREAK_GLASS_EXPIRED && e.target_id === "bg-p13-expired"
  );
  assert.ok(auditEntry, "break_glass.expired audit event should be written");
  assert.equal(auditEntry.actor_id, "system");
});

// ─────────────────────────────────────────────────────────────
// Group 8: Break-glass masking bypass via x-break-glass-id (1 test)
// ─────────────────────────────────────────────────────────────

test("Break-glass masking: x-break-glass-id with stall_leads_unmask scope unmasks leads for platform_admin", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = adminJwt(state);

  // Add a minimal interaction linked to an existing stall in the seed state
  state.interactions.push({
    id: "interaction-bg-mask-test",
    tenant_id: "tenant-demo",
    event_id: "event-demo",
    stall_id: "stall-a1",
    tap_event_id: null,
    attendee_id: null,
    captured_by_user_id: null,
    status: "consent_required",
    consent_status: "pending",
    classification: "cold",
    sponsor_click_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });

  // Push an active break-glass record with stall_leads_unmask permission
  const bgId = "bg-p13-mask-test";
  state.breakGlassAccess.push({
    id: bgId,
    tenant_id: "tenant-demo",
    requested_by_user_id: "user-platform-1",
    approved_by_user_id: "user-platform-2",
    rejected_by_user_id: null,
    rejection_reason: null,
    justification: "Masking bypass integration test",
    access_scope: JSON.stringify({ permissions: ["stall_leads_unmask"], event_ids: [], stall_ids: [] }),
    event_id: null,
    requested_duration_minutes: 60,
    status: "active",
    starts_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    revoked_at: null,
    created_at: new Date().toISOString()
  });

  // Without break-glass header: platform_admin sees masked leads
  const maskedRes = await app.inject({
    method: "GET",
    path: "/stalls/stall-a1/leads",
    headers: bearer(jwt)
  });
  assert.equal(maskedRes.statusCode, 200);
  assert.equal(maskedRes.body.items.length, 1);
  assert.equal(maskedRes.body.items[0].masked, true, "lead should be masked without break-glass header");

  // With break-glass header: masking is bypassed
  const unmaskedRes = await app.inject({
    method: "GET",
    path: "/stalls/stall-a1/leads",
    headers: { ...bearer(jwt), "x-break-glass-id": bgId }
  });
  assert.equal(unmaskedRes.statusCode, 200);
  assert.equal(unmaskedRes.body.items.length, 1);
  assert.notEqual(unmaskedRes.body.items[0].masked, true, "lead should not be masked with active break-glass");
  assert.equal(unmaskedRes.body.items[0].break_glass_access_id, bgId, "response should reference the break-glass session");
});
