/**
 * Phase 8 UI component unit tests.
 * Tests pure helper functions from components.js — no browser required.
 * Browser-dependent components (RoleAssignmentModal, BreakGlassSessionBanner) are
 * covered by the existing Playwright E2E suite (phase3-ui.e2e.test.mjs).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Stub browser globals so components.js can be imported in Node.js without error
globalThis.localStorage = {
  _store: {},
  getItem(k) { return this._store[k] ?? null; },
  setItem(k, v) { this._store[k] = String(v); },
  removeItem(k) { delete this._store[k]; }
};
globalThis.document = undefined;
globalThis.window = undefined;

const componentsPath = join(fileURLToPath(new URL("..", import.meta.url)), "components.js");
const {
  userStatusBadgeHtml,
  onboardingChecklistHtml,
  eventStatusActionButtonHtml,
  escHtml,
  getActiveEventContext,
  setActiveEventContext,
  clearActiveEventContext
} = await import(componentsPath);

// ─────────────────────────────────────────────────────────────────────────────
// Step 8.2 — UserStatusBadge
// ─────────────────────────────────────────────────────────────────────────────

test("userStatusBadgeHtml: active renders with status-pill active class and 'Active' label", () => {
  const html = userStatusBadgeHtml("active");
  assert.ok(html.includes("status-pill active"), `got: ${html}`);
  assert.ok(html.includes("Active"), `got: ${html}`);
});

test("userStatusBadgeHtml: pending_invite renders 'Pending' label", () => {
  const html = userStatusBadgeHtml("pending_invite");
  assert.ok(html.includes("status-pill pending_invite"), `got: ${html}`);
  assert.ok(html.includes("Pending"), `got: ${html}`);
});

test("userStatusBadgeHtml: disabled renders 'Disabled' label", () => {
  const html = userStatusBadgeHtml("disabled");
  assert.ok(html.includes("status-pill disabled"), `got: ${html}`);
  assert.ok(html.includes("Disabled"), `got: ${html}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 8.3 — OnboardingChecklist
// ─────────────────────────────────────────────────────────────────────────────

test("onboardingChecklistHtml: no checks shows 0/7 ❌ items and error banner", () => {
  const html = onboardingChecklistHtml({});
  const tickCount = (html.match(/✅/g) ?? []).length;
  const crossCount = (html.match(/❌/g) ?? []).length;
  assert.equal(tickCount, 0, "no checks should produce 0 ticks");
  assert.equal(crossCount, 7, "all 7 items should show ❌");
  assert.ok(html.includes("status error"), "should show error banner when < 5 checks");
});

test("onboardingChecklistHtml: 5 checks shows ready-to-publish banner", () => {
  const html = onboardingChecklistHtml({
    has_name: true,
    has_venue: true,
    has_dates: true,
    has_branding: true,
    has_organizer: true
  });
  const tickCount = (html.match(/✅/g) ?? []).length;
  assert.equal(tickCount, 5);
  assert.ok(html.includes("Ready to publish"), `expected 'Ready to publish', got: ${html.slice(0, 300)}`);
});

test("onboardingChecklistHtml: all 7 checks shows ready-to-go-live banner", () => {
  const html = onboardingChecklistHtml({
    has_name: true,
    has_venue: true,
    has_dates: true,
    has_branding: true,
    has_organizer: true,
    has_data_policy: true,
    has_devices: true
  });
  const tickCount = (html.match(/✅/g) ?? []).length;
  assert.equal(tickCount, 7);
  assert.ok(html.includes("Ready to go live"), `expected 'Ready to go live', got: ${html.slice(0, 300)}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 8.9 — EventStatusActionButton
// ─────────────────────────────────────────────────────────────────────────────

test("eventStatusActionButtonHtml: draft event shows Publish button for organizer_admin", () => {
  const html = eventStatusActionButtonHtml("draft", ["organizer_admin"], "ev-1");
  assert.ok(html.includes("Publish"), `got: ${html}`);
  assert.ok(html.includes("ev-1"), `got: ${html}`);
});

test("eventStatusActionButtonHtml: published event shows Go Live button for platform_admin", () => {
  const html = eventStatusActionButtonHtml("published", ["platform_admin"], "ev-2");
  assert.ok(html.includes("Go Live"), `got: ${html}`);
});

test("eventStatusActionButtonHtml: live event shows Close button for organizer_admin", () => {
  const html = eventStatusActionButtonHtml("live", ["organizer_admin"], "ev-3");
  assert.ok(html.includes("Close"), `got: ${html}`);
});

test("eventStatusActionButtonHtml: closed event shows Archive button for platform_admin", () => {
  const html = eventStatusActionButtonHtml("closed", ["platform_admin"], "ev-4");
  assert.ok(html.includes("Archive"), `got: ${html}`);
});

test("eventStatusActionButtonHtml: closed event returns empty string for organizer_admin (no permission)", () => {
  const html = eventStatusActionButtonHtml("closed", ["organizer_admin"], "ev-5");
  assert.equal(html, "", `organizer_admin should not see Archive button, got: ${html}`);
});

test("eventStatusActionButtonHtml: archived event returns empty string (no transition)", () => {
  const html = eventStatusActionButtonHtml("archived", ["platform_admin"], "ev-6");
  assert.equal(html, "");
});

test("eventStatusActionButtonHtml: vendor_manager sees no action button for any status", () => {
  for (const status of ["draft", "published", "live", "closed"]) {
    const html = eventStatusActionButtonHtml(status, ["vendor_manager"], "ev-x");
    assert.equal(html, "", `vendor_manager should have no button for status=${status}, got: ${html}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 8.4 — MultiRoleContextPicker (localStorage helpers)
// ─────────────────────────────────────────────────────────────────────────────

test("setActiveEventContext persists context and getActiveEventContext retrieves it", () => {
  const ctx = { event_id: "ev-test", event_name: "Test Event", roles: ["organizer_admin"] };
  setActiveEventContext(ctx);
  const retrieved = getActiveEventContext();
  assert.deepEqual(retrieved, ctx);
});

test("clearActiveEventContext removes stored context", () => {
  setActiveEventContext({ event_id: "ev-temp" });
  clearActiveEventContext();
  assert.equal(getActiveEventContext(), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 8.1 — RoleAssignmentModal HTML validation helpers
// ─────────────────────────────────────────────────────────────────────────────

test("escHtml escapes special characters correctly", () => {
  assert.equal(escHtml('<script>alert("xss")</script>'), "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
  assert.equal(escHtml("a & b"), "a &amp; b");
  assert.equal(escHtml(null), "");
  assert.equal(escHtml(undefined), "");
});
