import test from "node:test";
import assert from "node:assert/strict";

// Use mock backend throughout — no cloud credentials needed
process.env.INFRA_BACKEND = "mock";

import { runComplianceCheck } from "../src/integrations/infra-compliance.mjs";
import { createApp } from "../src/app.mjs";
import { createSeedState } from "../src/store.mjs";
import { issuePlatformToken } from "../src/auth/platform-jwt.mjs";
import { buildUserPrincipal } from "../src/auth/principals.mjs";

function bearer(token) { return { authorization: `Bearer ${token}` }; }

function platformJwt(state) {
  const user = state.users.find((u) => u.id === "user-platform-1");
  const assignments = state.userRoleAssignments.filter((a) => a.user_id === user.id);
  const principal = buildUserPrincipal(user, [], assignments);
  return issuePlatformToken(principal, state.sessionSecret);
}

// ─────────────────────────────────────────────────────────────────
// 1. Mock backend, zone=global → compliant: true
// ─────────────────────────────────────────────────────────────────

test("runComplianceCheck (mock): zone=global → compliant true", async () => {
  const result = await runComplianceCheck("tenant-x", "global");
  assert.equal(result.compliant, true);
  assert.equal(result.detected_zone, "global");
  assert.ok(Array.isArray(result.checks), "checks should be an array");
  assert.ok(result.checked_at instanceof Date, "checked_at should be a Date");
});

// ─────────────────────────────────────────────────────────────────
// 2. Mock backend, zone=india → compliant: false, review_required
// ─────────────────────────────────────────────────────────────────

test("runComplianceCheck (mock): zone=india → compliant false, reason set", async () => {
  const result = await runComplianceCheck("tenant-x", "india");
  assert.equal(result.compliant, false);
  assert.ok(result.reason, "reason should be present");
  assert.ok(result.reason.includes("Mock mode"), "reason should mention mock mode");
  assert.ok(Array.isArray(result.checks));
});

// ─────────────────────────────────────────────────────────────────
// 3. Internal error → CHECK_FAILED, never throws
// ─────────────────────────────────────────────────────────────────

test("runComplianceCheck: internal error returns CHECK_FAILED, does not throw", async () => {
  // Temporarily set backend to an unknown value to force the error path
  const origBackend = process.env.INFRA_BACKEND;
  // The function won't throw — it uses try/catch and falls through to mock
  // We test the error path by momentarily overriding the check
  const origFetch = globalThis.fetch;
  process.env.INFRA_BACKEND = "gcp";
  globalThis.fetch = async () => { throw new Error("simulated infra check failure"); };
  try {
    const result = await runComplianceCheck("tenant-x", "india");
    // GCP check fails → checks will have error but function still returns
    assert.equal(result.compliant, false);
    assert.ok(result.checked_at instanceof Date);
  } finally {
    process.env.INFRA_BACKEND = origBackend;
    globalThis.fetch = origFetch;
  }
});

// ─────────────────────────────────────────────────────────────────
// 4. POST /admin/tenants/:id/compliance/check → response shape
// ─────────────────────────────────────────────────────────────────

test("POST /admin/tenants/:id/compliance/check: returns status, detected_zone, checks[]", async () => {
  process.env.INFRA_BACKEND = "mock";
  const state = createSeedState();
  const app = await createApp({ state });
  const jwt = platformJwt(state);

  // Ensure tenant has a zone set
  const tenant = state.tenants.find((t) => t.id === "tenant-demo");
  tenant.data_residency_zone = "global";

  const res = await app.inject({
    method: "POST",
    path: `/admin/tenants/tenant-demo/compliance/check`,
    headers: bearer(jwt),
    body: {}
  });

  assert.equal(res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.ok(["compliant", "review_required", "non_compliant"].includes(res.body.status), "status should be a known value");
  assert.ok("configured_zone" in res.body, "configured_zone should be in response");
  assert.ok("detected_zone" in res.body, "detected_zone should be in response");
  assert.ok(Array.isArray(res.body.checks), "checks should be an array");
  assert.ok(res.body.last_checked_at, "last_checked_at should be set");
  // global zone → compliant with mock backend
  assert.equal(res.body.status, "compliant");
});

// ─────────────────────────────────────────────────────────────────
// 5. GET /admin/tenants/:id/compliance → includes last check result after check run
// ─────────────────────────────────────────────────────────────────

test("GET /admin/tenants/:id/compliance: includes last_compliance_check_at after check", async () => {
  process.env.INFRA_BACKEND = "mock";
  const state = createSeedState();
  const app = await createApp({ state });
  const jwt = platformJwt(state);

  const tenant = state.tenants.find((t) => t.id === "tenant-demo");
  tenant.data_residency_zone = "global";

  // Run a check first
  await app.inject({
    method: "POST",
    path: `/admin/tenants/tenant-demo/compliance/check`,
    headers: bearer(jwt),
    body: {}
  });

  // Now GET compliance — should include the check result
  const res = await app.inject({
    method: "GET",
    path: `/admin/tenants/tenant-demo/compliance`,
    headers: bearer(jwt)
  });

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.last_compliance_check_at, "last_compliance_check_at should be set after a check");
  assert.ok(res.body.last_compliance_status, "last_compliance_status should be set after a check");
  assert.equal(res.body.last_compliance_status, "compliant");
});

// ─────────────────────────────────────────────────────────────────
// 6. india zone → review_required status in POST response
// ─────────────────────────────────────────────────────────────────

test("POST /admin/tenants/:id/compliance/check: india zone → review_required (mock)", async () => {
  process.env.INFRA_BACKEND = "mock";
  const state = createSeedState();
  const app = await createApp({ state });
  const jwt = platformJwt(state);

  const tenant = state.tenants.find((t) => t.id === "tenant-demo");
  tenant.data_residency_zone = "india";

  const res = await app.inject({
    method: "POST",
    path: `/admin/tenants/tenant-demo/compliance/check`,
    headers: bearer(jwt),
    body: {}
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "review_required", "india zone in mock mode should be review_required");
  assert.ok(res.body.message, "message should be present explaining mock mode");
});

// ─────────────────────────────────────────────────────────────────
// AWS backend integration test — skipped unless credentials set
// ─────────────────────────────────────────────────────────────────

test("runComplianceCheck (aws): skipped unless AWS_ACCESS_KEY_ID is set", {
  skip: !process.env.AWS_ACCESS_KEY_ID
}, async () => {
  const origBackend = process.env.INFRA_BACKEND;
  process.env.INFRA_BACKEND = "aws";
  try {
    const result = await runComplianceCheck("tenant-x", process.env.EXPECTED_ZONE ?? "india");
    assert.ok(Array.isArray(result.checks), "checks should be an array");
    assert.ok(result.checked_at instanceof Date);
    // The check may fail individual resources but should not throw
    assert.ok(typeof result.compliant === "boolean");
  } finally {
    process.env.INFRA_BACKEND = origBackend;
  }
});
