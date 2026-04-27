import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.mjs";
import { createSeedState } from "../src/store.mjs";
import { issuePlatformToken } from "../src/auth/platform-jwt.mjs";
import { buildUserPrincipal } from "../src/auth/principals.mjs";
import { createMemoryRepositories } from "../src/repositories/memory.mjs";
import { processDSRJob } from "../src/jobs/dsr-worker.mjs";
import { dispatchCRMDeletion } from "../src/integrations/crm-deletion.mjs";

// ── Fetch mock utilities ─────────────────────────────────────────

function mockFetch(responses) {
  // responses: array of { match: (url, opts) => bool, status, body?, headers? }
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const entry = responses.find((r) => r.match(url, opts));
    if (!entry) throw new Error(`Unmocked fetch: ${opts?.method ?? "GET"} ${url}`);
    return {
      status: entry.status,
      ok: entry.status >= 200 && entry.status < 300,
      headers: {
        get: (name) => (entry.headers ?? {})[name.toLowerCase()] ?? null
      },
      json: async () => entry.body ?? {}
    };
  };
  return () => { globalThis.fetch = original; };
}

function makeConnection(overrides = {}) {
  return {
    id: "conn-test-01",
    tenant_id: "tenant-demo",
    provider: "salesforce",
    status: "active",
    config: {
      instance_url: "https://example.salesforce.com",
      access_token: "sf-token-abc"
    },
    ...overrides
  };
}

function organizerJwt(state) {
  const user = state.users.find((u) => u.id === "user-organizer");
  const assignments = state.userRoleAssignments.filter((a) => a.user_id === user.id);
  const principal = buildUserPrincipal(user, [], assignments);
  return issuePlatformToken(principal, state.sessionSecret);
}

function bearer(token) { return { authorization: `Bearer ${token}` }; }

// ─────────────────────────────────────────────────────────────────
// 1. Salesforce deletion success (204)
// ─────────────────────────────────────────────────────────────────

test("dispatchCRMDeletion: Salesforce 204 → success", async () => {
  const state = createSeedState();
  const repos = createMemoryRepositories(state);
  state.crmConnections.push(makeConnection());

  const restore = mockFetch([
    { match: (url) => url.includes("salesforce.com/services/data"), status: 204 }
  ]);
  try {
    const result = await dispatchCRMDeletion(repos, "conn-test-01", "sf-record-001", "att-001");
    assert.equal(result.success, true);
  } finally {
    restore();
  }
});

// ─────────────────────────────────────────────────────────────────
// 2. Salesforce 404 — already deleted → success
// ─────────────────────────────────────────────────────────────────

test("dispatchCRMDeletion: Salesforce 404 → already deleted → success", async () => {
  const state = createSeedState();
  const repos = createMemoryRepositories(state);
  state.crmConnections.push(makeConnection());

  const restore = mockFetch([
    { match: (url) => url.includes("salesforce.com/services/data"), status: 404 }
  ]);
  try {
    const result = await dispatchCRMDeletion(repos, "conn-test-01", "sf-record-002", "att-002");
    assert.equal(result.success, true);
  } finally {
    restore();
  }
});

// ─────────────────────────────────────────────────────────────────
// 3. Salesforce 401 — token refresh fails → auth failed
// ─────────────────────────────────────────────────────────────────

test("dispatchCRMDeletion: Salesforce 401 + refresh fail → SALESFORCE_AUTH_FAILED", async () => {
  const state = createSeedState();
  const repos = createMemoryRepositories(state);
  state.crmConnections.push(makeConnection({
    config: {
      instance_url: "https://example.salesforce.com",
      access_token: "expired-token",
      client_id: "cid",
      client_secret: "csec",
      refresh_token: "rtoken"
    }
  }));

  const restore = mockFetch([
    // Initial DELETE → 401
    { match: (url, opts) => url.includes("salesforce.com/services/data") && opts?.method === "DELETE", status: 401 },
    // Token refresh → 400 (failure)
    { match: (url) => url.includes("login.salesforce.com"), status: 400 }
  ]);
  try {
    const result = await dispatchCRMDeletion(repos, "conn-test-01", "sf-record-003", "att-003");
    assert.equal(result.success, false);
    assert.equal(result.reason, "SALESFORCE_AUTH_FAILED");
  } finally {
    restore();
  }
});

// ─────────────────────────────────────────────────────────────────
// 4. HubSpot deletion success (204)
// ─────────────────────────────────────────────────────────────────

test("dispatchCRMDeletion: HubSpot 204 → success", async () => {
  const state = createSeedState();
  const repos = createMemoryRepositories(state);
  state.crmConnections.push(makeConnection({
    id: "conn-hs-01",
    provider: "hubspot",
    config: { private_app_token: "hs-token-xyz" }
  }));

  const restore = mockFetch([
    { match: (url) => url.includes("api.hubapi.com"), status: 204 }
  ]);
  try {
    const result = await dispatchCRMDeletion(repos, "conn-hs-01", "hs-record-001", "att-004");
    assert.equal(result.success, true);
  } finally {
    restore();
  }
});

// ─────────────────────────────────────────────────────────────────
// 5. Network error → NETWORK_ERROR
// ─────────────────────────────────────────────────────────────────

test("dispatchCRMDeletion: network error → NETWORK_ERROR", async () => {
  const state = createSeedState();
  const repos = createMemoryRepositories(state);
  state.crmConnections.push(makeConnection());

  const restore = mockFetch([
    {
      match: (url) => url.includes("salesforce.com/services/data"),
      status: 0,
      body: null,
      // Throw instead
    }
  ]);
  // Override to throw
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes("salesforce.com/services/data")) throw new Error("ECONNREFUSED");
    return original(url);
  };
  try {
    const result = await dispatchCRMDeletion(repos, "conn-test-01", "sf-record-net", "att-005");
    assert.equal(result.success, false);
    assert.equal(result.reason, "NETWORK_ERROR");
    assert.ok(result.error, "error message should be present");
  } finally {
    globalThis.fetch = original;
  }
});

// ─────────────────────────────────────────────────────────────────
// 6. Disconnected connection → CRM_NOT_CONNECTED
// ─────────────────────────────────────────────────────────────────

test("dispatchCRMDeletion: disconnected connection → CRM_NOT_CONNECTED", async () => {
  const state = createSeedState();
  const repos = createMemoryRepositories(state);
  state.crmConnections.push(makeConnection({ status: "disconnected" }));

  const result = await dispatchCRMDeletion(repos, "conn-test-01", "sf-record-dc", "att-006");
  assert.equal(result.success, false);
  assert.equal(result.reason, "CRM_NOT_CONNECTED");
});

// ─────────────────────────────────────────────────────────────────
// 7. DSR delete worker: crm_sync_job.deletion_status = 'deleted' on success
// ─────────────────────────────────────────────────────────────────

test("DSR delete worker: CRM job deletion_status set to 'deleted' on success", async () => {
  const state = createSeedState();
  const repos = createMemoryRepositories(state);

  const attendeeId = "att-worker-01";
  state.crmConnections.push(makeConnection({ id: "conn-w-01" }));
  state.crmSyncJobs.push({
    id: "csj-w-01",
    tenant_id: "tenant-demo",
    attendee_id: attendeeId,
    connection_id: "conn-w-01",
    provider: "salesforce",
    external_record_id: "sf-ext-001",
    deletion_status: null,
    deletion_error: null
  });

  // Seed attendee + profile
  state.attendees.push({ id: attendeeId, tenant_id: "tenant-demo", created_at: new Date().toISOString() });
  state.attendeeProfiles.push({
    attendee_id: attendeeId,
    full_name: "Test Person",
    email: "test@example.com",
    phone: "+1000000001",
    company_name: "TestCo",
    updated_at: new Date().toISOString()
  });

  const dsrId = "dsr-w-01";
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

  const restore = mockFetch([
    { match: (url) => url.includes("salesforce.com/services/data"), status: 204 }
  ]);
  try {
    await processDSRJob(repos, state, dsrId);
  } finally {
    restore();
  }

  const job = state.crmSyncJobs.find((j) => j.id === "csj-w-01");
  assert.equal(job.deletion_status, "deleted");
  assert.equal(job.deletion_error, null);

  const dsr = state.dataSubjectRequests.find((d) => d.id === dsrId);
  assert.equal(dsr.status, "completed", "DSR should complete regardless of CRM outcome");
});

// ─────────────────────────────────────────────────────────────────
// 8. DSR delete worker: failed CRM → deletion_status = 'deletion_failed', DSR still completes
// ─────────────────────────────────────────────────────────────────

test("DSR delete worker: failed CRM deletion → deletion_failed logged, DSR still completes", async () => {
  const state = createSeedState();
  const repos = createMemoryRepositories(state);

  const attendeeId = "att-worker-02";
  state.crmConnections.push(makeConnection({ id: "conn-w-02" }));
  state.crmSyncJobs.push({
    id: "csj-w-02",
    tenant_id: "tenant-demo",
    attendee_id: attendeeId,
    connection_id: "conn-w-02",
    provider: "salesforce",
    external_record_id: "sf-ext-002",
    deletion_status: null,
    deletion_error: null
  });

  state.attendees.push({ id: attendeeId, tenant_id: "tenant-demo", created_at: new Date().toISOString() });
  state.attendeeProfiles.push({
    attendee_id: attendeeId,
    full_name: "Fail Person",
    email: "fail@example.com",
    phone: null,
    company_name: null,
    updated_at: new Date().toISOString()
  });

  const dsrId = "dsr-w-02";
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

  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes("salesforce.com/services/data")) throw new Error("Connection timed out");
    return original(url);
  };
  try {
    await processDSRJob(repos, state, dsrId);
  } finally {
    globalThis.fetch = original;
  }

  const job = state.crmSyncJobs.find((j) => j.id === "csj-w-02");
  assert.equal(job.deletion_status, "deletion_failed");
  assert.ok(job.deletion_error, "deletion_error should be set");

  const dsr = state.dataSubjectRequests.find((d) => d.id === dsrId);
  assert.equal(dsr.status, "completed", "DSR must complete even when CRM deletion fails");

  const palEntry = state.privacyAuditLogs.find(
    (e) => e.target_id === dsrId && e.action === "dsr.completed"
  );
  assert.ok(palEntry, "privacy audit log entry should be written");
  assert.ok(Array.isArray(palEntry.metadata?.crm_deletions), "crm_deletions should be in audit metadata");
});

// ─────────────────────────────────────────────────────────────────
// 9. DSR detail endpoint: crm_deletion_attempts in response
// ─────────────────────────────────────────────────────────────────

test("GET /events/:id/privacy-requests/:dsr_id: includes crm_deletion_attempts for delete DSR", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const jwt = organizerJwt(state);
  const attendeeId = "att-detail-01";

  state.crmSyncJobs.push({
    id: "csj-detail-01",
    tenant_id: "tenant-demo",
    attendee_id: attendeeId,
    connection_id: "conn-detail-01",
    provider: "hubspot",
    external_record_id: "hs-ext-detail-001",
    deletion_status: "deleted",
    deletion_error: null
  });

  state.dataSubjectRequests.push({
    id: "dsr-detail-01",
    tenant_id: "tenant-demo",
    event_id: "event-demo",
    attendee_id: attendeeId,
    request_type: "delete",
    status: "completed",
    submitted_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    created_at: new Date().toISOString()
  });

  const res = await app.inject({
    method: "GET",
    path: "/events/event-demo/privacy-requests/dsr-detail-01",
    headers: bearer(jwt)
  });
  assert.equal(res.statusCode, 200, "should return 200");
  assert.ok(Array.isArray(res.body.crm_deletion_attempts), "crm_deletion_attempts should be an array");
  assert.equal(res.body.crm_deletion_attempts.length, 1);
  const attempt = res.body.crm_deletion_attempts[0];
  assert.equal(attempt.provider, "hubspot");
  assert.equal(attempt.deletion_status, "deleted");
  assert.ok(attempt.external_record_id.endsWith("…"), "external_record_id should be truncated");
});
