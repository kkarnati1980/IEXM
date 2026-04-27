import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.mjs";
import { createSeedState } from "../src/store.mjs";
import { issuePlatformToken } from "../src/auth/platform-jwt.mjs";
import { buildUserPrincipal } from "../src/auth/principals.mjs";
import { runRetentionPurgeOnce, runRetentionExpiryCountdownOnce } from "../src/jobs/retention-purge.mjs";
import { processFullExportJob } from "../src/jobs/full-export-worker.mjs";
import { processDSRJob } from "../src/jobs/dsr-worker.mjs";
import { processTenantOffboarding } from "../src/jobs/offboarding-worker.mjs";
import { createMemoryRepositories } from "../src/repositories/memory.mjs";

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

function makeApp(state) {
  return createApp({ state });
}

function adminJwt(state) {
  const user = state.users.find((u) => u.id === "user-platform-1");
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

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

// ─────────────────────────────────────────────────────────────
// Step 16.1: Retention purge
// ─────────────────────────────────────────────────────────────

test("Retention purge: expired event gets attendee PII nulled, status=purged, privacy_audit written, notification queued", async () => {
  const state = createSeedState();
  const repos = createMemoryRepositories(state);

  // Set event ends_at 60 days ago with 30-day retention policy
  const event = state.events.find((e) => e.id === "event-demo");
  event.ends_at = daysAgo(60);
  event.retention_status = "active";

  // Add an attendee, profile, and interaction
  const attendeeId = "attendee-test-01";
  state.attendees.push({ id: attendeeId, tenant_id: "tenant-demo", created_at: new Date().toISOString() });
  state.attendeeProfiles.push({
    attendee_id: attendeeId,
    full_name: "Jane Doe",
    email: "jane@example.com",
    phone: "+1234567890",
    company_name: "Acme Inc",
    updated_at: new Date().toISOString()
  });
  state.interactions.push({
    id: "interaction-test-01",
    tenant_id: "tenant-demo",
    event_id: "event-demo",
    stall_id: "stall-a1",
    attendee_id: attendeeId,
    status: "active",
    consent_status: "vendor_only",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });

  const results = await runRetentionPurgeOnce(repos, state);

  assert.ok(results.some((r) => r.event_id === "event-demo" && r.status === "purged"),
    "event-demo should be marked purged");

  // Check interaction anonymised
  const interaction = state.interactions.find((i) => i.id === "interaction-test-01");
  assert.equal(interaction.status, "anonymized");
  assert.equal(interaction.attendee_id, null);

  // Check attendeeProfile PII nulled
  const profile = state.attendeeProfiles.find((p) => p.attendee_id === attendeeId);
  assert.equal(profile.full_name, null);
  assert.equal(profile.email, null);
  assert.equal(profile.phone, null);

  // Check event status
  const updatedEvent = state.events.find((e) => e.id === "event-demo");
  assert.equal(updatedEvent.retention_status, "purged");
  assert.ok(updatedEvent.purged_at, "purged_at should be set");

  // Check privacy audit log
  const palEntry = state.privacyAuditLogs.find(
    (e) => e.event_id === "event-demo" && e.action === "retention.purge_executed"
  );
  assert.ok(palEntry, "privacy audit log entry should be written");
  assert.equal(palEntry.actor_role, "system");
  assert.ok(palEntry.metadata.records_anonymised >= 1);

  // Check notification queued for organizer_admin
  const notification = state.notifications.find((n) => n.message_type === "retention_purge_completed");
  assert.ok(notification, "retention_purge_completed notification should be queued");
});

test("Retention purge: partial failure — failed event gets purge_failed, other events still processed", async () => {
  const state = createSeedState();
  const repos = createMemoryRepositories(state);

  // Set both events as expired
  for (const event of state.events) {
    event.ends_at = daysAgo(60);
    event.retention_status = "active";
  }

  // Break interactions repo for event-other only
  const origListByEvent = repos.interactions.listByEvent.bind(repos.interactions);
  repos.interactions.listByEvent = async (tenantId, eventId) => {
    if (eventId === "event-other") throw new Error("Simulated DB failure");
    return origListByEvent(tenantId, eventId);
  };

  const results = await runRetentionPurgeOnce(repos, state);

  const eventDemoResult = results.find((r) => r.event_id === "event-demo");
  const eventOtherResult = results.find((r) => r.event_id === "event-other");

  assert.equal(eventDemoResult?.status, "purged", "event-demo should be purged");
  assert.equal(eventOtherResult?.status, "purge_failed", "event-other should be purge_failed");

  const failedEvent = state.events.find((e) => e.id === "event-other");
  assert.equal(failedEvent.retention_status, "purge_failed");
});

test("Retention expiry countdown: event within 14 days updates to expiring_soon, notification queued", async () => {
  const state = createSeedState();
  const repos = createMemoryRepositories(state);

  // Event ends 5 days ago, 30-day retention → expiry is 25 days from now (within 14-day warning)
  // Actually: ends_at 5 days ago + 30 days retention = expiry 25 days from now. That's > 14 days.
  // Let's put ends_at 20 days ago + 30 days = expiry 10 days from now → within 14-day window
  const event = state.events.find((e) => e.id === "event-demo");
  event.ends_at = daysAgo(20);
  event.retention_status = "active";

  await runRetentionExpiryCountdownOnce(repos, state);

  const updatedEvent = state.events.find((e) => e.id === "event-demo");
  assert.equal(updatedEvent.retention_status, "expiring_soon");

  const notification = state.notifications.find((n) => n.message_type === "retention_expiry_warning");
  assert.ok(notification, "retention_expiry_warning notification should be queued");
});

// ─────────────────────────────────────────────────────────────
// Force-purge endpoint
// ─────────────────────────────────────────────────────────────

test("Force purge endpoint: POST /admin/events/:id/retention/force-purge triggers purge", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = adminJwt(state);

  // Set event as expired so the worker will process it
  const event = state.events.find((e) => e.id === "event-demo");
  event.ends_at = daysAgo(60);
  event.retention_status = "active";

  const res = await app.inject({
    method: "POST",
    path: "/admin/events/event-demo/retention/force-purge",
    headers: bearer(jwt),
    body: { confirm: true }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "purging");
  assert.equal(res.body.event_id, "event-demo");
});

// ─────────────────────────────────────────────────────────────
// Step 16.2: Full export worker
// ─────────────────────────────────────────────────────────────

test("Full export worker: processFullExportJob sets status=completed, export_file_url populated, notification queued", async () => {
  const state = createSeedState();
  const repos = createMemoryRepositories(state);

  const exportId = "export-test-01";
  state.exportRequests.push({
    id: exportId,
    tenant_id: "tenant-demo",
    event_id: "event-demo",
    requested_by_user_id: "user-organizer",
    export_type: "full_event_export_json",
    filters: { include: ["interactions", "event_config"], format: "json" },
    status: "requested",
    approval_required: false,
    download_used: false,
    created_at: new Date().toISOString()
  });

  await processFullExportJob(repos, state, exportId);

  const exportRequest = state.exportRequests.find((e) => e.id === exportId);
  assert.equal(exportRequest.status, "completed");
  assert.ok(exportRequest.export_file_url?.startsWith("data:application/json;base64,"),
    "export_file_url should be a data URI");
  assert.ok(exportRequest.export_expires_at, "export_expires_at should be set");

  // Check privacy audit log
  const palEntry = state.privacyAuditLogs.find(
    (e) => e.target_id === exportId && e.action === "full_export.completed"
  );
  assert.ok(palEntry, "privacy audit log entry should be written");

  // Check notification queued
  const notification = state.notifications.find((n) => n.message_type === "full_export_ready");
  assert.ok(notification, "full_export_ready notification should be queued");
});

test("Full export single-use: completed export → download → 200 first time, 410 second time", async () => {
  const state = createSeedState();
  const app = await makeApp(state);
  const jwt = organizerJwt(state);

  // Seed a completed export with download_used = false
  state.exportRequests.push({
    id: "export-single-use-01",
    tenant_id: "tenant-demo",
    event_id: "event-demo",
    requested_by_user_id: "user-organizer",
    export_type: "full_event_export_json",
    filters: { include: ["event_config"], format: "json" },
    status: "completed",
    approval_required: false,
    download_used: false,
    export_file_url: "data:application/json;base64,e30=",
    export_expires_at: new Date(Date.now() + 3600000).toISOString(),
    created_at: new Date().toISOString()
  });

  const res1 = await app.inject({
    method: "GET",
    path: "/events/event-demo/full-export/download",
    headers: bearer(jwt)
  });
  assert.equal(res1.statusCode, 200, "first download should succeed");
  assert.ok(res1.body.download_url, "download_url should be present");

  const res2 = await app.inject({
    method: "GET",
    path: "/events/event-demo/full-export/download",
    headers: bearer(jwt)
  });
  assert.equal(res2.statusCode, 410, "second download should return 410");
});

// ─────────────────────────────────────────────────────────────
// Step 16.3: DSR worker
// ─────────────────────────────────────────────────────────────

test("DSR export worker: processDSRJob with type=export sets status=completed, export_file_url populated, notification queued", async () => {
  const state = createSeedState();
  const repos = createMemoryRepositories(state);

  const attendeeId = "attendee-dsr-01";
  state.attendees.push({ id: attendeeId, tenant_id: "tenant-demo", created_at: new Date().toISOString() });
  state.attendeeProfiles.push({
    attendee_id: attendeeId,
    full_name: "Test Attendee",
    email: "attendee@example.com",
    phone: "+9876543210",
    company_name: "TestCo",
    updated_at: new Date().toISOString()
  });

  const dsrId = "dsr-test-01";
  state.dataSubjectRequests.push({
    id: dsrId,
    tenant_id: "tenant-demo",
    event_id: "event-demo",
    attendee_id: attendeeId,
    request_type: "export",
    status: "requested",
    submitted_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    export_file_url: null,
    export_expires_at: null
  });

  await processDSRJob(repos, state, dsrId);

  const dsr = state.dataSubjectRequests.find((d) => d.id === dsrId);
  assert.equal(dsr.status, "completed");
  assert.ok(dsr.export_file_url?.startsWith("data:application/json;base64,"),
    "export_file_url should be a data URI");
  assert.equal(dsr.download_used, false);

  // Check privacy audit log
  const palEntry = state.privacyAuditLogs.find(
    (e) => e.target_id === dsrId && e.action === "dsr.completed"
  );
  assert.ok(palEntry, "privacy audit log entry should be written");
  assert.equal(palEntry.metadata.outcome, "success");

  // Check notification queued
  const notification = state.notifications.find((n) => n.message_type === "dsr_export_ready");
  assert.ok(notification, "dsr_export_ready notification should be queued");

  // Check webhook would have fired (no subscriptions in test state, just verify no error)
});

test("DSR delete worker: processDSRJob with type=delete nulls attendee PII, status=completed, notification queued", async () => {
  const state = createSeedState();
  const repos = createMemoryRepositories(state);

  const attendeeId = "attendee-del-01";
  state.attendees.push({ id: attendeeId, tenant_id: "tenant-demo", created_at: new Date().toISOString() });
  state.attendeeProfiles.push({
    attendee_id: attendeeId,
    full_name: "Delete Me",
    email: "deleteme@example.com",
    phone: "+1111111111",
    company_name: "DeleteCo",
    updated_at: new Date().toISOString()
  });
  state.interactions.push({
    id: "interaction-del-01",
    tenant_id: "tenant-demo",
    event_id: "event-demo",
    stall_id: "stall-a1",
    attendee_id: attendeeId,
    status: "active",
    consent_status: "vendor_only",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });

  const dsrId = "dsr-del-01";
  state.dataSubjectRequests.push({
    id: dsrId,
    tenant_id: "tenant-demo",
    event_id: "event-demo",
    attendee_id: attendeeId,
    request_type: "delete",
    status: "requested",
    submitted_at: new Date().toISOString(),
    created_at: new Date().toISOString()
  });

  await processDSRJob(repos, state, dsrId);

  const dsr = state.dataSubjectRequests.find((d) => d.id === dsrId);
  assert.equal(dsr.status, "completed");

  // Attendee profile PII should be nulled/replaced
  const profile = state.attendeeProfiles.find((p) => p.attendee_id === attendeeId);
  assert.equal(profile.full_name, "[deleted]");
  assert.equal(profile.email, null);
  assert.equal(profile.phone, null);

  // Interaction should be anonymised
  const interaction = state.interactions.find((i) => i.id === "interaction-del-01");
  assert.equal(interaction.status, "anonymized");
  assert.equal(interaction.attendee_id, null);

  // Notification queued
  const notification = state.notifications.find((n) => n.message_type === "dsr_delete_confirmed");
  assert.ok(notification, "dsr_delete_confirmed notification should be queued");
});

test("DSR single-use download: completed DSR export → 200 first, 410 second", async () => {
  const state = createSeedState();
  const app = await makeApp(state);

  const attendeeId = "attendee-dltest-01";
  state.attendees.push({ id: attendeeId, tenant_id: "tenant-demo", created_at: new Date().toISOString() });

  state.dataSubjectRequests.push({
    id: "dsr-dl-01",
    tenant_id: "tenant-demo",
    event_id: "event-demo",
    attendee_id: attendeeId,
    request_type: "export",
    status: "completed",
    submitted_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    export_file_url: "data:application/json;base64,e30=",
    export_expires_at: new Date(Date.now() + 3600000).toISOString(),
    download_used: false
  });

  const res1 = await app.inject({
    method: "GET",
    path: "/attendee/privacy/dsr/dsr-dl-01/download",
    query: { attendee_id: attendeeId }
  });
  assert.equal(res1.statusCode, 200, "first download should succeed");

  const res2 = await app.inject({
    method: "GET",
    path: "/attendee/privacy/dsr/dsr-dl-01/download",
    query: { attendee_id: attendeeId }
  });
  assert.equal(res2.statusCode, 410, "second download should return 410");
});

// ─────────────────────────────────────────────────────────────
// Step 16.4: Offboarding worker
// ─────────────────────────────────────────────────────────────

test("Offboarding worker: processTenantOffboarding purges tenant PII, generates certificate, sets status=deleted, privacy_audit written", async () => {
  const state = createSeedState();
  const repos = createMemoryRepositories(state);

  // Add attendee + profile + interaction for the tenant
  const attendeeId = "attendee-offboard-01";
  state.attendees.push({ id: attendeeId, tenant_id: "tenant-demo", created_at: new Date().toISOString() });
  state.attendeeProfiles.push({
    attendee_id: attendeeId,
    full_name: "Offboard User",
    email: "offboard@example.com",
    phone: "+5555555555",
    company_name: "OffboardCo",
    updated_at: new Date().toISOString()
  });
  state.interactions.push({
    id: "interaction-offboard-01",
    tenant_id: "tenant-demo",
    event_id: "event-demo",
    stall_id: "stall-a1",
    attendee_id: attendeeId,
    status: "active",
    consent_status: "vendor_only",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });

  // Create offboarding job
  const jobId = "offboard-test-01";
  state.tenantOffboardingJobs.push({
    id: jobId,
    tenant_id: "tenant-demo",
    initiated_by_user_id: "user-platform-1",
    approved_by_user_id: "user-platform-2",
    data_handling_path: "immediate_delete",
    status: "deletion_in_progress",
    export_file_url: null,
    deletion_certificate_url: null,
    scheduled_deletion_at: null,
    completed_at: null,
    created_at: new Date().toISOString()
  });

  await processTenantOffboarding(repos, state, jobId);

  // Tenant offboarding_status = 'deleted'
  const tenant = state.tenants.find((t) => t.id === "tenant-demo");
  assert.equal(tenant.offboarding_status, "deleted");

  // Job completed with certificate
  const job = state.tenantOffboardingJobs.find((j) => j.id === jobId);
  assert.equal(job.status, "completed");
  assert.ok(job.deletion_certificate_url?.startsWith("data:application/json;base64,"),
    "deletion_certificate_url should be a data URI");
  assert.ok(job.completed_at, "completed_at should be set");

  // Attendee PII nulled
  const profile = state.attendeeProfiles.find((p) => p.attendee_id === attendeeId);
  assert.equal(profile.full_name, null);
  assert.equal(profile.email, null);

  // Interaction anonymised
  const interaction = state.interactions.find((i) => i.id === "interaction-offboard-01");
  assert.equal(interaction.status, "anonymized");

  // Privacy audit written
  const palEntry = state.privacyAuditLogs.find((e) => e.action === "tenant.data_deleted");
  assert.ok(palEntry, "privacy audit log entry should be written for tenant.data_deleted");

  // Notification queued
  const notification = state.notifications.find((n) => n.message_type === "offboarding_deletion_certificate");
  assert.ok(notification, "offboarding_deletion_certificate notification should be queued");
});
