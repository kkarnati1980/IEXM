import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.mjs";
import { createSeedState } from "../src/store.mjs";
import { issuePlatformToken } from "../src/auth/platform-jwt.mjs";
import { buildUserPrincipal } from "../src/auth/principals.mjs";
import { renderTemplate } from "../src/notification-templates.mjs";
import { createMemoryRepositories } from "../src/repositories/memory.mjs";

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

function makeApp(state) {
  return createApp({ state });
}

function platformJwt(state, userId = "user-platform-1") {
  const user = state.users.find((u) => u.id === userId);
  const assignments = state.userRoleAssignments.filter((a) => a.user_id === user.id);
  const principal = buildUserPrincipal(user, [], assignments);
  return issuePlatformToken(principal, state.sessionSecret);
}

function organizerJwt(state) {
  const user = state.users.find((u) => u.id === "user-organizer");
  const assignments = state.userRoleAssignments.filter((a) => a.user_id === user.id);
  const principal = buildUserPrincipal(user, [], assignments);
  return issuePlatformToken(principal, state.sessionSecret);
}

// ─────────────────────────────────────────────────────────────
// Template rendering — unit tests
// ─────────────────────────────────────────────────────────────

test("data_policy_changed: platform_admin actor renders amber warning line", () => {
  const result = renderTemplate("data_policy_changed", {
    organizer_name: "Alex",
    event_name: "DevConf 2025",
    changed_fields: [{ field: "retention_days", old_value: "30", new_value: "90" }],
    actor_role: "platform_admin",
    occurred_at: "2025-01-01T00:00:00.000Z",
    review_url: "https://example.com/policy"
  });
  assert.ok(result.subject.includes("DevConf 2025"));
  assert.ok(result.body.includes("platform administrator"), `Expected amber warning, got: ${result.body}`);
  assert.ok(result.body.includes("retention_days"));
});

test("data_policy_changed: organizer_admin actor has no amber warning line", () => {
  const result = renderTemplate("data_policy_changed", {
    organizer_name: "Alex",
    event_name: "DevConf 2025",
    changed_fields: [{ field: "vendor_exports_enabled", old_value: "false", new_value: "true" }],
    actor_role: "organizer_admin",
    occurred_at: "2025-01-01T00:00:00.000Z",
    review_url: "https://example.com/policy"
  });
  assert.ok(!result.body.includes("platform administrator"), "Should not include amber warning for organizer_admin");
});

test("break_glass_organizer_alert: renders with all variables", () => {
  const result = renderTemplate("break_glass_organizer_alert", {
    organizer_name: "Dana",
    requester_role: "platform_admin",
    access_scope: "attendee_pii",
    justification: "Emergency investigation of data breach report",
    event_name: "SummitX",
    duration_minutes: 60,
    platform_access_log_url: "https://example.com/access-log",
    occurred_at: "2025-01-15T10:00:00.000Z"
  });
  assert.ok(result.subject.includes("SummitX"));
  assert.ok(result.body.includes("attendee_pii"));
  assert.ok(result.body.includes("Emergency investigation"));
  assert.ok(result.body.includes("60 minute"));
  assert.ok(result.body.includes("https://example.com/access-log"));
});

test("offboarding_initiated: export_then_delete path renders correctly", () => {
  const result = renderTemplate("offboarding_initiated", {
    organizer_name: "Kim",
    tenant_name: "AcmeCorp",
    data_handling_path: "export_then_delete",
    contact_email: "help@codex.io"
  });
  assert.ok(result.subject.includes("AcmeCorp"));
  assert.ok(result.body.includes("exported first"));
  assert.ok(result.body.includes("help@codex.io"));
});

test("offboarding_initiated: immediate_delete path renders correctly", () => {
  const result = renderTemplate("offboarding_initiated", {
    organizer_name: "Kim",
    tenant_name: "AcmeCorp",
    data_handling_path: "immediate_delete",
    contact_email: "help@codex.io"
  });
  assert.ok(result.body.includes("permanently deleted"));
  assert.ok(result.body.includes("second administrator approval"));
});

test("offboarding_initiated: grace_period_delete path renders with days and date", () => {
  const result = renderTemplate("offboarding_initiated", {
    organizer_name: "Kim",
    tenant_name: "AcmeCorp",
    data_handling_path: "grace_period_delete",
    grace_period_days: 30,
    scheduled_deletion_at: "2025-06-01T00:00:00.000Z",
    contact_email: "help@codex.io"
  });
  assert.ok(result.body.includes("30 days"));
  assert.ok(result.body.includes("2025-06-01"));
});

test("offboarding_deletion_reminder_14d: renders correctly", () => {
  const result = renderTemplate("offboarding_deletion_reminder_14d", {
    organizer_name: "Priya",
    tenant_name: "WidgetCo",
    scheduled_deletion_at: "2025-07-01T00:00:00.000Z",
    contact_email: "support@codex.io"
  });
  assert.ok(result.subject.includes("14 days"));
  assert.ok(result.subject.includes("WidgetCo"));
  assert.ok(result.body.includes("14 days remaining"));
  assert.ok(result.body.includes("support@codex.io"));
});

test("offboarding_deletion_reminder_3d: renders correctly with URGENT prefix", () => {
  const result = renderTemplate("offboarding_deletion_reminder_3d", {
    organizer_name: "Priya",
    tenant_name: "WidgetCo",
    scheduled_deletion_at: "2025-07-01T00:00:00.000Z",
    contact_email: "support@codex.io"
  });
  assert.ok(result.subject.includes("URGENT"));
  assert.ok(result.subject.includes("3 days"));
  assert.ok(result.body.includes("3 days remaining"));
  assert.ok(result.body.includes("irreversible"));
});

test("All 16 templates: smoke test — renderTemplate does not throw for any known type", () => {
  const templates = [
    ["user_invitation", { display_name: "Test", invite_url: "http://x", platform_name: "X" }],
    ["invite_expiry_reminder", { display_name: "Test", invite_url: "http://x", platform_name: "X" }],
    ["account_activated", { display_name: "Test", login_url: "http://x", platform_name: "X" }],
    ["password_reset", { display_name: "Test", reset_url: "http://x", platform_name: "X" }],
    ["break_glass_pending_approval", { requester_name: "Admin", justification: "test", platform_name: "X" }],
    ["break_glass_organizer_alert", { organizer_name: "A", event_name: "E", access_scope: "pii", justification: "j", duration_minutes: 30, platform_access_log_url: "" }],
    ["data_policy_changed", { organizer_name: "A", event_name: "E", changed_fields: [], actor_role: "organizer_admin", occurred_at: "", review_url: "" }],
    ["retention_purge_completed", { organizer_name: "A", event_name: "E", records_anonymised: 0, purged_at: "", retention_days: 30 }],
    ["retention_expiry_warning", { organizer_name: "A", event_name: "E", retention_expiry_date: "", days_remaining: 14, data_policy_url: "" }],
    ["full_export_ready", { organizer_name: "A", event_name: "E", export_id: "x", download_url: "", expires_in_hours: 24 }],
    ["dsr_export_ready", { attendee_name: "A", export_id: "x", download_url: "", expires_in_hours: 24 }],
    ["dsr_delete_confirmed", { attendee_name: "A", event_name: "E", completed_at: "" }],
    ["offboarding_deletion_certificate", { organizer_name: "A", tenant_name: "T", deleted_at: "", certificate_download_url: "" }],
    ["offboarding_initiated", { organizer_name: "A", tenant_name: "T", data_handling_path: "immediate_delete", contact_email: "x@x" }],
    ["offboarding_deletion_reminder_14d", { organizer_name: "A", tenant_name: "T", scheduled_deletion_at: "", contact_email: "x@x" }],
    ["offboarding_deletion_reminder_3d", { organizer_name: "A", tenant_name: "T", scheduled_deletion_at: "", contact_email: "x@x" }]
  ];
  assert.equal(templates.length, 16);
  for (const [name, vars] of templates) {
    let result;
    assert.doesNotThrow(() => { result = renderTemplate(name, vars); }, `Template "${name}" threw`);
    assert.ok(result?.subject, `Template "${name}" returned no subject`);
    assert.ok(result?.body, `Template "${name}" returned no body`);
  }
});

// ─────────────────────────────────────────────────────────────
// Integration tests — notification dispatch via HTTP
// ─────────────────────────────────────────────────────────────

test("Break-glass approval: organizer_admin receives break_glass_organizer_alert notification", async () => {
  const state = createSeedState();
  const app = await makeApp(state);

  // platform-1 submits break-glass request
  const jwt1 = platformJwt(state, "user-platform-1");
  const reqRes = await app.inject({
    method: "POST",
    path: "/admin/break-glass/request",
    headers: bearer(jwt1),
    body: {
      justification: "Investigating a potential data breach reported by security team",
      access_scope: "attendee_pii",
      requested_duration_minutes: 60
    }
  });
  assert.equal(reqRes.statusCode, 201, `Break-glass request failed: ${reqRes.body}`);
  const bgId = reqRes.body.id;

  // platform-2 approves it
  const jwt2 = platformJwt(state, "user-platform-2");
  const approveRes = await app.inject({
    method: "POST",
    path: `/admin/break-glass/${bgId}/approve`,
    headers: bearer(jwt2),
    body: {}
  });
  assert.equal(approveRes.statusCode, 200, `Break-glass approve failed: ${approveRes.body}`);

  // organizer_admin (user-organizer) should have received break_glass_organizer_alert
  const orgNotif = state.notifications.find(
    (n) => n.system_payload?.recipient_email === "organizer@example.com" && n.message_type === "break_glass_organizer_alert"
  );
  assert.ok(orgNotif, "Expected break_glass_organizer_alert notification for organizer_admin");
});

test("Data policy change: organizer_admin receives data_policy_changed notification after POST /events/:id/data-policy", async () => {
  const state = createSeedState();
  // Add a second organizer_admin to receive the notification (current actor is user-organizer)
  state.users.push({
    id: "user-organizer-2",
    tenant_id: "tenant-demo",
    org_id: state.users.find((u) => u.id === "user-organizer").org_id,
    email: "organizer2@example.com",
    display_name: "Second Organizer",
    role: "organizer_admin",
    status: "active",
    created_at: new Date().toISOString()
  });

  const app = await makeApp(state);
  const jwt = organizerJwt(state);

  const res = await app.inject({
    method: "POST",
    path: "/events/event-demo/data-policy",
    headers: bearer(jwt),
    body: { retention_days: 90 }
  });
  assert.equal(res.statusCode, 200, `Data policy update failed: ${res.body}`);

  const notif = state.notifications.find(
    (n) => n.system_payload?.recipient_email === "organizer2@example.com" && n.message_type === "data_policy_changed"
  );
  assert.ok(notif, "Expected data_policy_changed notification for second organizer_admin");
});

test("Offboarding initiation: organizer_admin receives offboarding_initiated notification after POST /admin/tenants/:id/offboard", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = platformJwt(state, "user-platform-1");

  const res = await app.inject({
    method: "POST",
    path: "/admin/tenants/tenant-demo/offboard",
    headers: bearer(jwt),
    body: {
      data_handling_path: "immediate_delete",
      confirm_tenant_slug: "demo"
    }
  });
  assert.equal(res.statusCode, 201, `Offboarding initiation failed: ${res.body}`);

  const notif = state.notifications.find(
    (n) => n.system_payload?.recipient_email === "organizer@example.com" && n.message_type === "offboarding_initiated"
  );
  assert.ok(notif, "Expected offboarding_initiated notification for organizer_admin");
});
