import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.mjs";

const VENDOR_TOKEN    = "demo-vendor-token";           // editor + approver (org-vendor)
const APPROVER_TOKEN  = "demo-vendor-approver-token";  // editor + approver (org-vendor, different user)
const VENDOR_ORG_ID   = "org-vendor";
const TENANT_ID       = "tenant-demo";
const STALL_A1        = "stall-a1";

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

async function withApp(fn) {
  const app = await createApp();
  try {
    await fn(app);
  } finally {
    await app.close?.();
  }
}

// VP-01: GET profile returns empty shell when no vendor profile exists
test("VP-01: GET /vendors/:org/profile returns null profile before first PATCH", async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "GET",
      path: `/vendors/${VENDOR_ORG_ID}/profile`,
      headers: bearer(VENDOR_TOKEN)
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.profile, null);
    assert.equal(res.body.published, null);
    assert.equal(res.body.pending, null);
  });
});

// VP-02: GET profile with wrong org returns 403
test("VP-02: GET /vendors/:org/profile denies cross-org access", async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "GET",
      path: `/vendors/org-organizer/profile`,
      headers: bearer(VENDOR_TOKEN)
    });
    assert.equal(res.statusCode, 403);
  });
});

// VP-03: PATCH auto-creates shell + draft
test("VP-03: PATCH /vendors/:org/profile auto-creates shell and draft", async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "PATCH",
      path: `/vendors/${VENDOR_ORG_ID}/profile`,
      headers: bearer(VENDOR_TOKEN),
      body: { display_name: "Acme Corp", tagline: "Building tomorrow" }
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.ok(res.body.profile?.id, "profile shell must be created");
    assert.equal(res.body.item?.state, "draft");
    assert.equal(res.body.item?.payload?.display_name, "Acme Corp");
    assert.equal(res.body.item?.payload?.tagline, "Building tomorrow");
  });
});

// VP-04: PATCH with submit=true transitions draft to submitted
test("VP-04: PATCH with submit:true transitions to submitted", async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "PATCH",
      path: `/vendors/${VENDOR_ORG_ID}/profile`,
      headers: bearer(VENDOR_TOKEN),
      body: { display_name: "Acme Corp", submit: true }
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.item?.state, "submitted");
    assert.ok(res.body.item?.submitted_at);
  });
});

// VP-05: PATCH strips HTML from text fields
test("VP-05: PATCH strips HTML tags from display_name and tagline", async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "PATCH",
      path: `/vendors/${VENDOR_ORG_ID}/profile`,
      headers: bearer(VENDOR_TOKEN),
      body: { display_name: "<b>Bold Corp</b>", tagline: "<script>xss</script>Tag" }
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.item?.payload?.display_name, "Bold Corp");
    assert.equal(res.body.item?.payload?.tagline, "xssTag");
  });
});

// VP-06: PATCH with invalid logo_url returns 422
test("VP-06: PATCH rejects non-https logo_url", async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "PATCH",
      path: `/vendors/${VENDOR_ORG_ID}/profile`,
      headers: bearer(VENDOR_TOKEN),
      body: { logo_url: "http://insecure.example.com/logo.png" }
    });
    assert.equal(res.statusCode, 422, JSON.stringify(res.body));
  });
});

// VP-07: GET social-links returns empty before publish
test("VP-07: GET /vendors/:org/social-links returns empty before publish", async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "GET",
      path: `/vendors/${VENDOR_ORG_ID}/social-links`,
      headers: bearer(VENDOR_TOKEN)
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.social_links, []);
  });
});

// VP-08: PUT social-links merges into draft payload
test("VP-08: PUT /vendors/:org/social-links merges social_links into draft", async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "PUT",
      path: `/vendors/${VENDOR_ORG_ID}/social-links`,
      headers: bearer(VENDOR_TOKEN),
      body: {
        social_links: [
          { channel: "linkedin", url: "https://linkedin.com/company/acme" },
          { channel: "instagram", url: "https://instagram.com/acme", prefilled_message: "Hello!" }
        ]
      }
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const links = res.body.item?.payload?.social_links;
    assert.ok(Array.isArray(links));
    assert.equal(links.length, 2);
    assert.equal(links[0].channel, "linkedin");
    assert.equal(links[1].prefilled_message, "Hello!");
  });
});

// VP-09: PUT social-links with invalid channel returns 422
test("VP-09: PUT social-links rejects invalid channel name", async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "PUT",
      path: `/vendors/${VENDOR_ORG_ID}/social-links`,
      headers: bearer(VENDOR_TOKEN),
      body: { social_links: [{ channel: "tiktok", url: "https://tiktok.com/@acme" }] }
    });
    assert.equal(res.statusCode, 422, JSON.stringify(res.body));
  });
});

// VP-10: Public endpoint returns null before profile is published
test("VP-10: GET /stalls/:id/vendor-profile returns null before publish", async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "GET",
      path: `/stalls/${STALL_A1}/vendor-profile?tenant_id=${TENANT_ID}`
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.profile, null);
    assert.deepEqual(res.body.social_links, []);
  });
});

// VP-11: Public endpoint without tenant_id returns 400
test("VP-11: GET /stalls/:id/vendor-profile without tenant_id returns 400", async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "GET",
      path: `/stalls/${STALL_A1}/vendor-profile`
    });
    assert.equal(res.statusCode, 400, JSON.stringify(res.body));
  });
});

// VP-12: Full publish flow — draft → approve → public endpoint returns profile
test("VP-12: full publish flow makes profile visible on public endpoint", async () => {
  await withApp(async (app) => {
    // Editor creates and submits draft
    const patch = await app.inject({
      method: "PATCH",
      path: `/vendors/${VENDOR_ORG_ID}/profile`,
      headers: bearer(VENDOR_TOKEN),
      body: {
        display_name: "Acme Corp",
        description: "We build things",
        social_links: [{ channel: "linkedin", url: "https://linkedin.com/company/acme" }],
        submit: true
      }
    });
    assert.equal(patch.statusCode, 200, JSON.stringify(patch.body));
    const itemId = patch.body.item.id;
    const profileId = patch.body.profile.id;

    // Move to under_review so approver can approve
    const claim = await app.inject({
      method: "POST",
      path: `/moderation-items/${itemId}/transition`,
      headers: bearer(APPROVER_TOKEN),
      body: { to_state: "under_review" }
    });
    assert.equal(claim.statusCode, 200, JSON.stringify(claim.body));

    // Approver approves (different user from editor)
    const approve = await app.inject({
      method: "POST",
      path: `/moderation-items/${itemId}/transition`,
      headers: bearer(APPROVER_TOKEN),
      body: { to_state: "approved" }
    });
    assert.equal(approve.statusCode, 200, JSON.stringify(approve.body));

    // Vendor profile shell should point to approved item
    const profiles = await app.repos.vendorProfiles.findByOrganization(TENANT_ID, VENDOR_ORG_ID);
    assert.ok(profiles.length > 0, "vendor_profiles shell must exist");
    assert.equal(profiles[0].currently_published_item_id, itemId);

    // Public endpoint returns profile
    const pub = await app.inject({
      method: "GET",
      path: `/stalls/${STALL_A1}/vendor-profile?tenant_id=${TENANT_ID}`
    });
    assert.equal(pub.statusCode, 200, JSON.stringify(pub.body));
    assert.equal(pub.body.profile?.display_name, "Acme Corp");
    assert.ok(Array.isArray(pub.body.social_links));
    assert.equal(pub.body.social_links.length, 1);
    assert.equal(pub.body.social_links[0].channel, "linkedin");
  });
});

// VP-13: D1 after approval shows published item and no pending
test("VP-13: GET /vendors/:org/profile after approval shows published, no pending", async () => {
  await withApp(async (app) => {
    // Create and approve a draft
    const patch = await app.inject({
      method: "PATCH",
      path: `/vendors/${VENDOR_ORG_ID}/profile`,
      headers: bearer(VENDOR_TOKEN),
      body: { display_name: "Published Corp", submit: true }
    });
    assert.equal(patch.statusCode, 200, JSON.stringify(patch.body));
    const itemId = patch.body.item.id;

    const claim = await app.inject({
      method: "POST",
      path: `/moderation-items/${itemId}/transition`,
      headers: bearer(APPROVER_TOKEN),
      body: { to_state: "under_review" }
    });
    assert.equal(claim.statusCode, 200, JSON.stringify(claim.body));

    const approve = await app.inject({
      method: "POST",
      path: `/moderation-items/${itemId}/transition`,
      headers: bearer(APPROVER_TOKEN),
      body: { to_state: "approved" }
    });
    assert.equal(approve.statusCode, 200, JSON.stringify(approve.body));

    // D1 should show published item and no pending
    const view = await app.inject({
      method: "GET",
      path: `/vendors/${VENDOR_ORG_ID}/profile`,
      headers: bearer(VENDOR_TOKEN)
    });
    assert.equal(view.statusCode, 200, JSON.stringify(view.body));
    assert.equal(view.body.published?.id, itemId);
    assert.equal(view.body.published?.state, "approved");
    assert.equal(view.body.pending, null);
  });
});

// VP-14: industry field persists into payload and is returned by GET /profile
test("VP-14: PATCH with industry persists to moderation_items.payload and GET returns it", async () => {
  await withApp(async (app) => {
    const patch = await app.inject({
      method: "PATCH",
      path: `/vendors/${VENDOR_ORG_ID}/profile`,
      headers: bearer(VENDOR_TOKEN),
      body: { display_name: "Acme", industry: "SaaS" }
    });
    assert.equal(patch.statusCode, 200, JSON.stringify(patch.body));
    assert.equal(patch.body.item?.payload?.industry, "SaaS");

    const get = await app.inject({
      method: "GET",
      path: `/vendors/${VENDOR_ORG_ID}/profile`,
      headers: bearer(VENDOR_TOKEN)
    });
    assert.equal(get.statusCode, 200, JSON.stringify(get.body));
    assert.equal(get.body.pending?.payload?.industry, "SaaS");
  });
});

// VP-15: industry > 80 chars returns 422
test("VP-15: PATCH rejects industry longer than 80 characters", async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "PATCH",
      path: `/vendors/${VENDOR_ORG_ID}/profile`,
      headers: bearer(VENDOR_TOKEN),
      body: { industry: "A".repeat(81) }
    });
    assert.equal(res.statusCode, 422, JSON.stringify(res.body));
  });
});

// VP-17: PATCH with submit=true on existing draft → note has new_status='submitted', prior_status='draft'
test("VP-17: PATCH with submit on existing draft records moderation note with correct statuses", async () => {
  await withApp(async (app) => {
    // First create a draft
    const draft = await app.inject({
      method: "PATCH",
      path: `/vendors/${VENDOR_ORG_ID}/profile`,
      headers: bearer(VENDOR_TOKEN),
      body: { display_name: "Draft Corp" }
    });
    assert.equal(draft.statusCode, 200, JSON.stringify(draft.body));
    assert.equal(draft.body.item?.state, "draft");

    // Now submit it
    const submit = await app.inject({
      method: "PATCH",
      path: `/vendors/${VENDOR_ORG_ID}/profile`,
      headers: bearer(VENDOR_TOKEN),
      body: { display_name: "Draft Corp", submit: true }
    });
    assert.equal(submit.statusCode, 200, JSON.stringify(submit.body));
    assert.equal(submit.body.item?.state, "submitted");

    // Check the moderation note
    const notes = await app.repos.moderationNotes.listByItem(
      TENANT_ID, "vendor_profiles", submit.body.profile.id
    );
    const submitNote = notes.find((n) => n.action === "submit");
    assert.ok(submitNote, "submit note must exist");
    assert.equal(submitNote.new_status, "submitted");
    assert.equal(submitNote.prior_status, "draft");
  });
});

// VP-18: PATCH with submit=true on first creation (no prior item) → note has prior_status=null
test("VP-18: initial PATCH with submit flag records note with prior_status=null", async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "PATCH",
      path: `/vendors/${VENDOR_ORG_ID}/profile`,
      headers: bearer(VENDOR_TOKEN),
      body: { display_name: "Instant Submit Corp", submit: true }
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.item?.state, "submitted");

    const notes = await app.repos.moderationNotes.listByItem(
      TENANT_ID, "vendor_profiles", res.body.profile.id
    );
    const submitNote = notes.find((n) => n.action === "submit");
    assert.ok(submitNote, "submit note must exist");
    assert.equal(submitNote.new_status, "submitted");
    assert.equal(submitNote.prior_status, null);
  });
});

// VP-19: moderationNotes.create with new_status=null throws (proves DB NOT NULL constraint is mirrored)
test("VP-19: moderationNotes.create with null new_status throws (NOT NULL constraint)", async () => {
  await withApp(async (app) => {
    let threw = false;
    try {
      await app.repos.moderationNotes.create({
        id:           "00000000-0000-0000-0000-000000000099",
        tenant_id:    TENANT_ID,
        target_table: "vendor_profiles",
        target_id:    "00000000-0000-0000-0000-000000000001",
        actor_user_id: "user-vendor",
        action:       "submit",
        note:         null,
        prior_status: null,
        new_status:   null,
        created_at:   new Date().toISOString()
      });
    } catch {
      threw = true;
    }
    assert.ok(threw, "moderationNotes.create with null new_status must throw");
  });
});

// VP-16: full payload regression — ensures UUID id generation works (not nextId prefix strings)
test("VP-16: full form payload returns 200 with valid string ids (regression: UUID id generation)", async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "PATCH",
      path: `/vendors/${VENDOR_ORG_ID}/profile`,
      headers: bearer(VENDOR_TOKEN),
      body: {
        display_name: "Acme Test Vendor",
        tagline: "We make great test data",
        description: "This is a test profile for P2 Phase 1 verification.",
        website_url: "https://example.com",
        industry: "Testing",
        social_links: [
          { channel: "linkedin", url: "https://linkedin.com/company/acme-test" }
        ]
      }
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.item?.state, "draft");
    assert.equal(res.body.item?.payload?.display_name, "Acme Test Vendor");
    assert.equal(res.body.item?.payload?.industry, "Testing");
    assert.ok(typeof res.body.profile?.id === "string" && res.body.profile.id.length > 0, "profile id must be a non-empty string");
    assert.ok(typeof res.body.item?.id === "string" && res.body.item.id.length > 0, "item id must be a non-empty string");
  });
});
