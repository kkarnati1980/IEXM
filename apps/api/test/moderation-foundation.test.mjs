import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.mjs";

const VENDOR_TOKEN   = "demo-vendor-token";          // editor: demo-vendor
const APPROVER_TOKEN = "demo-vendor-approver-token"; // editor: demo-vendor-approver
const VENDOR_ORG_ID  = "org-vendor";
const TENANT_ID      = "tenant-demo";

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

function randomId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2)}`;
}

async function withApp(fn) {
  const app = await createApp();
  try {
    await fn(app);
  } finally {
    await app.close?.();
  }
}

async function seedItem(repos, overrides = {}) {
  const now = new Date().toISOString();
  const item = {
    id:               randomId("item"),
    tenant_id:        TENANT_ID,
    entity_type:      overrides.entity_type      ?? "vendor_profiles",
    entity_id:        overrides.entity_id        ?? randomId("vp"),
    state:            overrides.state            ?? "draft",
    payload:          overrides.payload          ?? {},
    editor_user_id:   overrides.editor_user_id   ?? "demo-vendor",
    approver_user_id: overrides.approver_user_id ?? null,
    submitted_at:     overrides.submitted_at     ?? null,
    decided_at:       overrides.decided_at       ?? null,
    created_at:       now,
    updated_at:       now
  };
  await repos.moderationItems.create(item);
  return item;
}

// ── MT-VP-01: editor cannot self-approve ─────────────────────────────────────
test("MT-VP-01: editor cannot self-approve", async () => {
  await withApp(async (app) => {
    const item = await seedItem(app.repos, {
      state: "under_review",
      editor_user_id: "demo-vendor"  // same as VENDOR_TOKEN principal
    });

    const res = await app.inject({
      method: "POST",
      path: `/moderation-items/${item.id}/transition`,
      headers: bearer(VENDOR_TOKEN),
      body: { to_state: "approved" }
    });

    assert.equal(res.statusCode, 403, `expected 403 got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  });
});

// ── MT-VP-02: moderation_notes immutability (AP-5) ───────────────────────────
test("MT-VP-02: moderation_notes are immutable", async () => {
  await withApp(async (app) => {
    const note = await app.repos.moderationNotes.create({
      id:            randomId("note"),
      tenant_id:     TENANT_ID,
      target_table:  "vendor_profiles",
      target_id:     randomId("vp"),
      item_id:       randomId("item"),
      action:        "submit",
      actor_user_id: "demo-vendor",
      note:          null,
      created_at:    new Date().toISOString()
    });

    await assert.rejects(
      () => app.repos.moderationNotes.update(note),
      (err) => err.statusCode === 405
    );
    await assert.rejects(
      () => app.repos.moderationNotes.delete(note),
      (err) => err.statusCode === 405
    );
  });
});

// ── MT-VP-03: approve supersedes prior approved item ─────────────────────────
test("MT-VP-03: approving item B supersedes item A", async () => {
  await withApp(async (app) => {
    const entityId = randomId("vp");

    const itemA = await seedItem(app.repos, {
      state: "approved",
      entity_id: entityId,
      editor_user_id: "demo-vendor"
    });
    const itemB = await seedItem(app.repos, {
      state: "under_review",
      entity_id: entityId,
      editor_user_id: "demo-vendor-approver"
    });

    // VENDOR_TOKEN user approves item B (they didn't edit it)
    const res = await app.inject({
      method: "POST",
      path: `/moderation-items/${itemB.id}/transition`,
      headers: bearer(VENDOR_TOKEN),
      body: { to_state: "approved" }
    });
    assert.equal(res.statusCode, 200, `expected 200 got ${res.statusCode}: ${JSON.stringify(res.body)}`);

    const updatedA = await app.repos.moderationItems.findById(TENANT_ID, itemA.id);
    assert.equal(updatedA.state, "superseded", "prior approved item must be superseded");

    const updatedB = await app.repos.moderationItems.findById(TENANT_ID, itemB.id);
    assert.equal(updatedB.state, "approved");
  });
});

// ── Reject without note → 422 ────────────────────────────────────────────────
test("reject without note returns 422", async () => {
  await withApp(async (app) => {
    const item = await seedItem(app.repos, {
      state: "under_review",
      editor_user_id: "demo-vendor"
    });

    const res = await app.inject({
      method: "POST",
      path: `/moderation-items/${item.id}/transition`,
      headers: bearer(APPROVER_TOKEN),
      body: { to_state: "rejected" }
    });

    assert.equal(res.statusCode, 422);
  });
});

// ── Full approve flow writes history ─────────────────────────────────────────
test("full approve flow writes moderation_notes history", async () => {
  await withApp(async (app) => {
    const item = await seedItem(app.repos, {
      state: "under_review",
      editor_user_id: "demo-vendor"
    });

    const transition = await app.inject({
      method: "POST",
      path: `/moderation-items/${item.id}/transition`,
      headers: bearer(APPROVER_TOKEN),
      body: { to_state: "approved" }
    });
    assert.equal(transition.statusCode, 200);

    const history = await app.inject({
      method: "GET",
      path: `/moderation-items/${item.id}/history`,
      headers: bearer(APPROVER_TOKEN)
    });
    assert.equal(history.statusCode, 200);
    assert.ok(Array.isArray(history.body.history));
    assert.ok(history.body.history.length >= 1);
    assert.equal(history.body.history.at(-1).action, "approve");
  });
});

// ── Cross-org isolation → 403 ─────────────────────────────────────────────────
test("cross-org moderation list returns 403", async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "GET",
      path: `/vendors/org-organizer/moderation-items`,
      headers: bearer(VENDOR_TOKEN)
    });
    assert.equal(res.statusCode, 403);
  });
});

// ── History is chronological ──────────────────────────────────────────────────
test("history route returns notes sorted by created_at ASC", async () => {
  await withApp(async (app) => {
    const entityId = randomId("vp");
    const item = await seedItem(app.repos, { entity_id: entityId, editor_user_id: "demo-vendor" });

    const t1 = new Date(Date.now() - 2000).toISOString();
    const t2 = new Date(Date.now() - 1000).toISOString();
    const t3 = new Date().toISOString();

    for (const [id, action, ts] of [
      ["n-c1", "submit",  t1],
      ["n-c2", "approve", t3],
      ["n-c3", "claim",   t2]
    ]) {
      await app.repos.moderationNotes.create({
        id, tenant_id: TENANT_ID, target_table: "vendor_profiles",
        target_id: entityId, item_id: item.id, action,
        actor_user_id: "demo-vendor", note: null, created_at: ts
      });
    }

    const res = await app.inject({
      method: "GET",
      path: `/moderation-items/${item.id}/history`,
      headers: bearer(VENDOR_TOKEN)
    });
    assert.equal(res.statusCode, 200);
    const actions = res.body.history.map((n) => n.action);
    assert.deepEqual(actions, ["submit", "claim", "approve"]);
  });
});

// ── Invalid entity_type → 400 ────────────────────────────────────────────────
test("invalid entity_type filter returns 400", async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "GET",
      path: `/vendors/${VENDOR_ORG_ID}/moderation-items?entity_type=bad_type`,
      headers: bearer(VENDOR_TOKEN)
    });
    assert.equal(res.statusCode, 400);
  });
});

// ── Invalid transition → 422 ─────────────────────────────────────────────────
test("invalid state transition returns 422", async () => {
  await withApp(async (app) => {
    const item = await seedItem(app.repos, {
      state: "rejected",
      editor_user_id: "demo-vendor"
    });

    const res = await app.inject({
      method: "POST",
      path: `/moderation-items/${item.id}/transition`,
      headers: bearer(APPROVER_TOKEN),
      body: { to_state: "approved" }
    });
    assert.equal(res.statusCode, 422);
  });
});

// ── Discarded draft does not disturb published item ───────────────────────────
test("discarding a draft does not disturb published item", async () => {
  await withApp(async (app) => {
    const entityId = randomId("vp");

    const published = await seedItem(app.repos, {
      state: "approved",
      entity_id: entityId,
      editor_user_id: "demo-vendor"
    });
    const draft = await seedItem(app.repos, {
      state: "draft",
      entity_id: entityId,
      editor_user_id: "demo-vendor"
    });

    const res = await app.inject({
      method: "POST",
      path: `/moderation-items/${draft.id}/transition`,
      headers: bearer(VENDOR_TOKEN),
      body: { to_state: "discarded" }
    });
    assert.equal(res.statusCode, 200, `expected 200 got ${res.statusCode}: ${JSON.stringify(res.body)}`);

    const stillApproved = await app.repos.moderationItems.findById(TENANT_ID, published.id);
    assert.equal(stillApproved.state, "approved");
  });
});

// ── Withdrawn item cannot be approved ────────────────────────────────────────
test("withdrawn item cannot be approved", async () => {
  await withApp(async (app) => {
    const item = await seedItem(app.repos, {
      state: "withdrawn",
      editor_user_id: "demo-vendor"
    });

    const res = await app.inject({
      method: "POST",
      path: `/moderation-items/${item.id}/transition`,
      headers: bearer(APPROVER_TOKEN),
      body: { to_state: "approved" }
    });
    assert.equal(res.statusCode, 422);
  });
});

// ── changes_requested → resubmit works ───────────────────────────────────────
test("changes_requested item can be resubmitted", async () => {
  await withApp(async (app) => {
    const item = await seedItem(app.repos, {
      state: "changes_requested",
      editor_user_id: "demo-vendor"
    });

    const res = await app.inject({
      method: "POST",
      path: `/moderation-items/${item.id}/transition`,
      headers: bearer(VENDOR_TOKEN),
      body: { to_state: "submitted" }
    });
    assert.equal(res.statusCode, 200);

    const updated = await app.repos.moderationItems.findById(TENANT_ID, item.id);
    assert.equal(updated.state, "submitted");
  });
});

// ── Audit log row on every transition ────────────────────────────────────────
test("audit_logs row created on every transition", async () => {
  await withApp(async (app) => {
    const item = await seedItem(app.repos, {
      state: "draft",
      editor_user_id: "demo-vendor"
    });

    const before = (await app.repos.auditLogs.listByTenant(TENANT_ID)).length;

    await app.inject({
      method: "POST",
      path: `/moderation-items/${item.id}/transition`,
      headers: bearer(VENDOR_TOKEN),
      body: { to_state: "submitted" }
    });

    const after = (await app.repos.auditLogs.listByTenant(TENANT_ID)).length;
    assert.ok(after > before, "audit log must grow after transition");
  });
});

// ── User flags enforced (vendor_content_approver=false → 403) ────────────────
test("vendor_content_approver=false cannot approve", async () => {
  await withApp(async (app) => {
    const item = await seedItem(app.repos, {
      state: "under_review",
      editor_user_id: "demo-vendor"
    });

    // The principal is rebuilt from the user DB record on each request.
    // Patch the user record in memory to clear the approver flag.
    const approverUser = app.state.users.find((u) => u.id === "demo-vendor-approver");
    assert.ok(approverUser, "approver user must exist in seed state");
    const originalFlag = approverUser.vendor_content_approver;
    approverUser.vendor_content_approver = false;

    try {
      const res = await app.inject({
        method: "POST",
        path: `/moderation-items/${item.id}/transition`,
        headers: bearer(APPROVER_TOKEN),
        body: { to_state: "approved" }
      });
      assert.equal(res.statusCode, 403, `expected 403 got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    } finally {
      approverUser.vendor_content_approver = originalFlag;
    }
  });
});
