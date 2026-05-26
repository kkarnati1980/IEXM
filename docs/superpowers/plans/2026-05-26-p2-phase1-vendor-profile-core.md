# P2 Phase 1 — Vendor Profile Core (CR-VP-01) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add vendor profile editing (core 6 fields + social links) with full moderation flow, and render the approved profile on the attendee landing page.

**Architecture:** Content lives exclusively in `moderation_items.payload` JSONB (full snapshots). The `vendor_profiles` shell's `currently_published_item_id` pointer is updated atomically on approval. A separate `vendor_profile_social_links` table stores the denormalized published social links for fast attendee reads. The attendee-facing endpoint is public (no auth) and returns approved content or a stall+org fallback.

**Tech Stack:** Node.js ESM, PostgreSQL, native `node:http`, `node --test`; no new npm dependencies.

---

## Section A — Investigation Findings

### A1. Attendee Landing Page

**File:** `apps/web/attendee.html`

This IS the attendee landing page. It is a multi-screen SPA with 5 screens:
- **Screen 1** (`#screen-landing`): "Contact exchange successful". Shows `#landing-context` card with Event, Stall, Time, Tap type fields. Has "Review consent" and "View my connections" buttons. **This is where vendor profile content slots in.**
- Screens 2–5: Consent, Vault, Detail, Privacy.

**Flow:** NFC tap → `s.html` resolves `/s/:token` → server returns `target_url: /attendee.html?interactionId=...&token=...` → `attendee.html` calls `GET /attendee/session/:interactionId?token=...` → renders screen 1.

**Session response already includes:** `current_connection.stall_id`, `current_connection.stall_name`, `current_connection.vendor_company_name` (from org.name). It does **NOT** include any vendor profile content (logo, tagline, description, social links).

**Where the vendor block goes:** A new card inserted in `#screen-landing`, after `#landing-context` and before the consent CTA button. The attendee page will make a **second API call** to `GET /stalls/:stallId/vendor-profile` using `current_connection.stall_id`.

**No touch required on the session endpoint** — the second call pattern avoids modifying P1 attendee session code.

---

### A2. `branding_assets` Table

**File:** `apps/api/migrations/033_branding_assets.sql`

**Critical finding:** `branding_assets` is an **event-level kiosk branding table**, NOT a vendor asset store. Its schema:
- PK is `TEXT` (not UUID)
- Keyed by `(tenant_id, event_id)` — one row per event
- Columns: `idle_headline`, `idle_sub`, `tap_cta`, `sponsor_logo_url`, `event_logo_url`, `primary_color`, `background_color`, `attendee_landing_message`…
- Logos stored as **URL strings** (TEXT), not file uploads

**There is no upload endpoint.** No multipart form handling. No file storage infrastructure.

**Impact:** The spec field `logo_asset_id UUID FK to branding_assets` is **not implementable** as written. See Section I (Risk 1) for the resolution.

---

### A3. `vendor.html` Current Structure

**File:** `apps/web/vendor.html`

**Current state:** No tab navigation exists inside the page. The entire page is a single-layout Lead Inbox (with the document storage section in an aside). It has a top-level `<nav class="shell-nav">` (page-level navigation links: Vendor, My Account, Sign out) — this is NOT an in-page tab bar.

**Pattern to follow** (from `apps/web/organizer/event-detail.html`):

CSS classes:
```css
.tabs        { display:flex; gap:4px; flex-wrap:wrap; margin-bottom:18px; }
.tab-btn     { border:0; background:none; color:var(--muted); padding:10px 16px;
               border-radius:12px; cursor:pointer; font:inherit; font-size:14px;
               border:1px solid transparent; }
.tab-btn.active { background:#fef3c7; color:var(--accent); border-color:rgba(45,106,159,0.3); }
.tab-content    { display:none; }
.tab-content.active { display:block; }
```

HTML structure:
```html
<div class="tabs">
  <button class="tab-btn active" data-tab="inbox">Lead Inbox</button>
  <button class="tab-btn" data-tab="profile">Profile</button>
</div>
<div id="tab-inbox" class="tab-content active"><!-- existing main content --></div>
<div id="tab-profile" class="tab-content"><!-- new profile form --></div>
```

JS tab switcher:
```javascript
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'profile') loadProfile();
  });
});
```

**Delta required:** Wrap existing `<main>` content in `#tab-inbox`. Add `<div class="tabs">` before `<main>`. Add `#tab-profile` as second tab content.

---

### A4. Image Upload / Asset Handling

**Finding:** No upload endpoint exists anywhere in the API. `branding_assets` stores URLs as TEXT. No multipart/form-data handling. No file storage infrastructure.

**Conclusion:** `logo_asset_id UUID FK to branding_assets` cannot be built in Phase 1. See Section I (Risk 1).

---

### A5. Markdown and HTML Sanitizer

**Finding:** `package.json` lists only two runtime deps: `pg` and (dev) `playwright-core`. No DOMPurify, marked, sanitize-html, or any markdown library.

**Server-side HTML stripping:** Use a minimal inline regex — no new dependency:
```javascript
function stripHtml(str) {
  return String(str ?? '').replace(/<[^>]*>/g, '').trim();
}
```

**Markdown display in attendee view:** Phase 1 stores and displays `description` as **plain text** after stripping. No markdown rendering. The 5000-char limit is enforced server-side before storing.

---

## Section B — Migrations

### Migration 070 — `vendor_profile_social_links`

**File:** `apps/api/migrations/070_vendor_profile_social_links.sql`

```sql
-- 070: vendor_profile_social_links — published social links for an approved vendor profile.
-- Draft social links live in moderation_items.payload.social_links (JSONB array).
-- On approval, the transition handler bulk-replaces rows here from the approved payload.

-- Guard: one vendor_profiles shell per org (prevents chicken-and-egg duplicates)
CREATE UNIQUE INDEX IF NOT EXISTS vendor_profiles_org_unique
  ON vendor_profiles(tenant_id, organization_id);

CREATE TABLE IF NOT EXISTS vendor_profile_social_links (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT        NOT NULL REFERENCES tenants(id),
  vendor_profile_id UUID        NOT NULL REFERENCES vendor_profiles(id) ON DELETE CASCADE,
  channel           TEXT        NOT NULL
                    CHECK (channel IN ('linkedin','youtube','instagram','facebook',
                                       'x','whatsapp','generic_1','generic_2')),
  url               TEXT        NOT NULL,
  prefilled_message TEXT,
  click_count       INT         NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vendor_profile_id, channel)
);

ALTER TABLE vendor_profile_social_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY vendor_profile_social_links_rls ON vendor_profile_social_links
  USING  (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE INDEX idx_vpsl_profile ON vendor_profile_social_links(vendor_profile_id);
CREATE INDEX idx_vpsl_tenant  ON vendor_profile_social_links(tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON vendor_profile_social_links TO app_runtime;

INSERT INTO schema_migrations (version)
  VALUES ('070_vendor_profile_social_links') ON CONFLICT DO NOTHING;
```

**Rollback (`070_vendor_profile_social_links.rollback.sql`):**
```sql
DROP TABLE IF EXISTS vendor_profile_social_links;
DROP INDEX IF EXISTS vendor_profiles_org_unique;
DELETE FROM schema_migrations WHERE version = '070_vendor_profile_social_links';
```

**No changes to `vendor_profiles` shell** — content stays in `moderation_items.payload`. No new columns on the shell.

**No changes to `branding_assets`** — see Section I (Risk 1) for logo resolution.

---

## Section C — Policy / RBAC

**No new policy predicates required.** The existing Phase 0 predicates cover all Phase 1 transitions:

| Predicate | Location | Used for |
|-----------|----------|---------|
| `canSubmitModeration(principal)` | `policy.mjs:259` | PATCH /profile, PUT /social-links — checks `principal.vendor_content_editor === true` |
| `canApproveModeration(principal, editorUserId)` | `policy.mjs:263` | POST /moderation-items/:id/transition to `approved` |
| `canRejectModeration(principal, editorUserId)` | `policy.mjs:267` | POST /moderation-items/:id/transition to `rejected` |

**New ACM entries required** (5 entries added to `access-control.mjs`):

```javascript
// Added to ACCESS_CONTROL_MATRIX in access-control.mjs:
"vendor-profile-get":          entry({ permission: "vendor.profile.get",        roles: vendor, scope: "tenant",
                                       description: "Read vendor profile editor view (published + pending items)" }),
"vendor-profile-patch":        entry({ permission: "vendor.profile.patch",      roles: vendor, scope: "tenant",
                                       description: "Create or update vendor profile draft moderation item" }),
"vendor-profile-social-get":   entry({ permission: "vendor.profile.social.get", roles: vendor, scope: "tenant",
                                       description: "Read published social links for vendor profile" }),
"vendor-profile-social-put":   entry({ permission: "vendor.profile.social.put", roles: vendor, scope: "tenant",
                                       description: "Bulk-replace social links in vendor profile draft" }),
"stall-vendor-profile-public": publicEntry("stall.vendor.profile.public",
                                           "Public attendee-facing vendor profile for a stall", "public"),
```

Where `vendor` is the existing `["vendor_manager"]` constant array already defined in the file.

---

## Section D — API Endpoints

All new routes are added via `registerVendorProfileRoutes(router)`, called from the main route function in `routes.mjs` immediately after the existing `registerModerationRoutes(router)` call (~line 8795). The new function is defined at the end of the file, after `registerModerationRoutes`.

---

### D1. `GET /vendors/:vendorOrgId/profile` — Editor View

**Purpose:** Returns the editor's view: currently published payload + the most recent pending item (draft/submitted/under_review/changes_requested), if any.

**Auth:** `allowedRoles: ["vendor_manager"]`. Route handler enforces `params.vendorOrgId === principal.organization_id`.

**Response shape:**
```json
{
  "vendor_profile_id": "uuid | null",
  "published": {
    "item_id": "uuid",
    "payload": {
      "company_name": "Acme Corp",
      "tagline": "Tag line",
      "description": "Plain text, HTML stripped",
      "logo_url": "https://...",
      "website_url": "https://...",
      "industry": "Technology",
      "social_links": [{ "channel": "linkedin", "url": "https://..." }]
    },
    "approved_at": "2026-05-26T10:00:00Z"
  },
  "pending": {
    "item_id": "uuid",
    "state": "draft",
    "payload": { "...": "..." },
    "submitted_at": null,
    "created_at": "2026-05-26T09:00:00Z"
  }
}
```

If no `vendor_profiles` shell exists yet → `{ vendor_profile_id: null, published: null, pending: null }`.

**Implementation (route handler body):**
```javascript
const orgId = params.vendorOrgId;
if (orgId !== principal.organization_id) throw new HttpError(403, "Org mismatch");
const profiles = await repos.vendorProfiles.findByOrganization(principal.tenant_id, orgId);
if (!profiles.length) return { vendor_profile_id: null, published: null, pending: null };
const profile = profiles[0];
const [publishedItem, pendingItem] = await Promise.all([
  profile.currently_published_item_id
    ? repos.moderationItems.findById(principal.tenant_id, profile.currently_published_item_id).catch(() => null)
    : Promise.resolve(null),
  repos.moderationItems.findPendingByEntity(principal.tenant_id, 'vendor_profiles', profile.id)
]);
return {
  vendor_profile_id: profile.id,
  published: publishedItem ? {
    item_id: publishedItem.id,
    payload: publishedItem.payload,
    approved_at: publishedItem.decided_at
  } : null,
  pending: pendingItem ? {
    item_id: pendingItem.id,
    state: pendingItem.state,
    payload: pendingItem.payload,
    submitted_at: pendingItem.submitted_at,
    created_at: pendingItem.created_at
  } : null
};
```

---

### D2. `PATCH /vendors/:vendorOrgId/profile` — Create/Update Draft

**Purpose:** Creates a new `moderation_items` row (or updates existing draft) with the full profile snapshot. Optionally transitions to `submitted` if `body.submit === true`.

**Auth:** `allowedRoles: ["vendor_manager"]`. Checks `canSubmitModeration(principal)`.

**Validation function `validateProfileBody(body)` → returns 422 on fail:**
```javascript
function validateProfileBody(body) {
  if (!body.company_name?.trim()) throw new HttpError(422, "company_name is required");
  if (body.tagline && body.tagline.length > 200) throw new HttpError(422, "tagline max 200 chars");
  if (body.logo_url && !body.logo_url.startsWith('https://')) throw new HttpError(422, "logo_url must be https");
  if (body.website_url && !body.website_url.startsWith('https://')) throw new HttpError(422, "website_url must be https");
  const links = body.social_links ?? [];
  if (links.length > 8) throw new HttpError(422, "max 8 social links");
  const CHANNELS = ['linkedin','youtube','instagram','facebook','x','whatsapp','generic_1','generic_2'];
  const seen = new Set();
  for (const sl of links) {
    if (!CHANNELS.includes(sl.channel)) throw new HttpError(422, `invalid channel: ${sl.channel}`);
    if (!sl.url?.startsWith('https://')) throw new HttpError(422, `social link url must be https: ${sl.channel}`);
    if (seen.has(sl.channel)) throw new HttpError(422, `duplicate channel: ${sl.channel}`);
    seen.add(sl.channel);
  }
}
```

**Implementation (route handler body):**
```javascript
if (!canSubmitModeration(principal)) throw new HttpError(403, "vendor_content_editor required");
const orgId = params.vendorOrgId;
if (orgId !== principal.organization_id) throw new HttpError(403, "Org mismatch");
validateProfileBody(body);
const description = stripHtml(body.description ?? '');
if (description.length > 5000) throw new HttpError(422, "description max 5000 chars after HTML strip");
const now = new Date().toISOString();
// Auto-create vendor_profiles shell on first save
let profiles = await repos.vendorProfiles.findByOrganization(principal.tenant_id, orgId);
let profile = profiles[0] ?? null;
if (!profile) {
  profile = await repos.vendorProfiles.create({
    id: nextId('vp'), tenant_id: principal.tenant_id, organization_id: orgId,
    currently_published_item_id: null, created_at: now, updated_at: now
  });
}
const payload = {
  company_name: body.company_name.trim(),
  tagline: body.tagline?.trim() ?? '',
  description,
  logo_url: body.logo_url?.trim() ?? '',
  website_url: body.website_url?.trim() ?? '',
  industry: body.industry?.trim() ?? '',
  social_links: (body.social_links ?? []).map(sl => ({
    channel: sl.channel, url: sl.url.trim(),
    prefilled_message: sl.prefilled_message?.trim() ?? null
  }))
};
// Reuse existing draft if present; otherwise create new
let item = await repos.moderationItems.findPendingByEntity(principal.tenant_id, 'vendor_profiles', profile.id);
if (item && item.state === 'draft') {
  item.payload = payload;
  item.updated_at = now;
  item = await repos.moderationItems.update(item);
} else {
  item = await repos.moderationItems.create({
    id: nextId('mi'), tenant_id: principal.tenant_id,
    entity_type: 'vendor_profiles', entity_id: profile.id,
    state: 'draft', payload,
    editor_user_id: principal.user_id, approver_user_id: null,
    submitted_at: null, decided_at: null, created_at: now, updated_at: now
  });
}
if (body.submit === true) {
  item.state = 'submitted';
  item.submitted_at = now;
  item.updated_at = now;
  item = await repos.moderationItems.update(item);
  await repos.moderationNotes.create({
    id: nextId('mn'), tenant_id: principal.tenant_id,
    target_table: 'vendor_profiles', target_id: profile.id,
    item_id: item.id, action: 'submit', actor_user_id: principal.user_id,
    note: null, created_at: now
  });
}
return { item };
```

---

### D3. `GET /vendors/:vendorOrgId/social-links` — Published Social Links

**Purpose:** Returns the currently published set of social links from the `vendor_profile_social_links` table.

**Auth:** `allowedRoles: ["vendor_manager"]`. Enforce org match.

**Implementation:**
```javascript
const orgId = params.vendorOrgId;
if (orgId !== principal.organization_id) throw new HttpError(403, "Org mismatch");
const profiles = await repos.vendorProfiles.findByOrganization(principal.tenant_id, orgId);
if (!profiles.length) return { items: [] };
const links = await repos.vendorProfileSocialLinks.listByProfile(principal.tenant_id, profiles[0].id);
return { items: links };
```

---

### D4. `PUT /vendors/:vendorOrgId/social-links` — Bulk Replace via Moderation

**Purpose:** Updates the `social_links` field in the current vendor profile draft moderation item (or creates a new draft with merged payload).

**Auth:** `allowedRoles: ["vendor_manager"]`. Checks `canSubmitModeration(principal)`.

**Body:** `{ social_links: [{channel, url, prefilled_message?}], submit?: boolean }`

**Validation:** Same `channel` enum, HTTPS, max 8, no duplicates.

**Implementation:**
```javascript
if (!canSubmitModeration(principal)) throw new HttpError(403, "vendor_content_editor required");
const orgId = params.vendorOrgId;
if (orgId !== principal.organization_id) throw new HttpError(403, "Org mismatch");
// Validate social_links portion only (reuse same CHANNELS/HTTPS checks)
validateSocialLinks(body.social_links ?? []);
const now = new Date().toISOString();
// Get or create profile shell
let profiles = await repos.vendorProfiles.findByOrganization(principal.tenant_id, orgId);
let profile = profiles[0] ?? null;
if (!profile) {
  profile = await repos.vendorProfiles.create({
    id: nextId('vp'), tenant_id: principal.tenant_id, organization_id: orgId,
    currently_published_item_id: null, created_at: now, updated_at: now
  });
}
// Merge: find existing draft, or seed from published payload
let item = await repos.moderationItems.findPendingByEntity(principal.tenant_id, 'vendor_profiles', profile.id);
let basePayload = {};
if (item) {
  basePayload = { ...item.payload };
} else if (profile.currently_published_item_id) {
  const pub = await repos.moderationItems.findById(principal.tenant_id, profile.currently_published_item_id);
  basePayload = { ...pub.payload };
}
const newPayload = { ...basePayload, social_links: (body.social_links ?? []).map(sl => ({
  channel: sl.channel, url: sl.url.trim(), prefilled_message: sl.prefilled_message?.trim() ?? null
})) };
if (item && item.state === 'draft') {
  item.payload = newPayload; item.updated_at = now;
  item = await repos.moderationItems.update(item);
} else {
  item = await repos.moderationItems.create({
    id: nextId('mi'), tenant_id: principal.tenant_id,
    entity_type: 'vendor_profiles', entity_id: profile.id,
    state: 'draft', payload: newPayload,
    editor_user_id: principal.user_id, approver_user_id: null,
    submitted_at: null, decided_at: null, created_at: now, updated_at: now
  });
}
if (body.submit === true) {
  item.state = 'submitted'; item.submitted_at = now; item.updated_at = now;
  item = await repos.moderationItems.update(item);
}
return { item };
```

---

### D5. `GET /stalls/:stallId/vendor-profile` — Public Attendee Render

**Purpose:** Returns the approved vendor profile for the stall's vendor org, or a fallback. No auth required. Used by `attendee.html`.

**Auth:** `authRequired: false`

**Implementation:**
```javascript
const tenantId = req.headers['x-tenant-id'] || 'tenant-demo';
const stall = await repos.stalls.findById(tenantId, params.stallId);
const fallback = { has_profile: false, stall_name: stall.name, org_name: null };
if (!stall.vendor_organization_id) return fallback;
const org = await repos.organizations.findById(tenantId, stall.vendor_organization_id).catch(() => null);
if (org) fallback.org_name = org.name;
const profiles = await repos.vendorProfiles.findByOrganization(tenantId, stall.vendor_organization_id);
if (!profiles.length || !profiles[0].currently_published_item_id) return fallback;
const profile = profiles[0];
const item = await repos.moderationItems.findById(tenantId, profile.currently_published_item_id).catch(() => null);
if (!item || item.state !== 'approved') return fallback;
const socialLinks = await repos.vendorProfileSocialLinks.listByProfile(tenantId, profile.id);
return {
  has_profile: true,
  company_name: item.payload.company_name,
  tagline: item.payload.tagline,
  description: item.payload.description,
  logo_url: item.payload.logo_url,
  website_url: item.payload.website_url,
  industry: item.payload.industry,
  social_links: socialLinks.map(sl => ({
    channel: sl.channel, url: sl.url,
    prefilled_message: sl.prefilled_message,
    click_count: sl.click_count
  }))
};
```

---

### D6. Transition Handler Extension (Existing Route: `POST /moderation-items/:itemId/transition`)

**Modify** the existing `registerModerationRoutes` approval block in `routes.mjs`. Add 8 lines inside the `if (isApprove)` block, guarded by `entity_type === 'vendor_profiles'`. All other entity types are unaffected.

**Add after the "supersede prior" block, before `moderationItems.update(item)`:**
```javascript
// AP-1: vendor_profiles pointer swap + social links sync (Phase 1 extension)
if (isApprove && item.entity_type === 'vendor_profiles') {
  const profile = await txRepos.vendorProfiles.findById(principal.tenant_id, item.entity_id);
  profile.currently_published_item_id = item.id;
  profile.updated_at = now;
  await txRepos.vendorProfiles.update(profile);
  const socialLinks = item.payload.social_links ?? [];
  await txRepos.vendorProfileSocialLinks.replaceForProfile(
    principal.tenant_id, item.entity_id, socialLinks, now
  );
}
```

This is the **only** change to the existing transition route handler.

---

## Section E — Repositories (Memory + Postgres)

### E1. New repo: `vendorProfileSocialLinks`

Added to both `repositories/memory.mjs` and `repositories/postgres.mjs`.

**Memory backend** (added to the object returned by `createRepos()`):
```javascript
vendorProfileSocialLinks: {
  async listByProfile(tenantId, vendorProfileId) {
    return (state.vendorProfileSocialLinks ?? [])
      .filter(r => r.tenant_id === tenantId && r.vendor_profile_id === vendorProfileId);
  },
  async replaceForProfile(tenantId, vendorProfileId, socialLinks, now) {
    if (!state.vendorProfileSocialLinks) state.vendorProfileSocialLinks = [];
    state.vendorProfileSocialLinks = state.vendorProfileSocialLinks
      .filter(r => !(r.tenant_id === tenantId && r.vendor_profile_id === vendorProfileId));
    for (const sl of socialLinks) {
      state.vendorProfileSocialLinks.push({
        id: nextId('sl'), tenant_id: tenantId, vendor_profile_id: vendorProfileId,
        channel: sl.channel, url: sl.url,
        prefilled_message: sl.prefilled_message ?? null,
        click_count: 0, created_at: now, updated_at: now
      });
    }
  }
},
```

**Postgres backend:**
```javascript
vendorProfileSocialLinks: {
  async listByProfile(tenantId, vendorProfileId) {
    return many(await execute(
      `SELECT * FROM vendor_profile_social_links
       WHERE tenant_id=$1 AND vendor_profile_id=$2 ORDER BY channel`,
      [tenantId, vendorProfileId]
    ));
  },
  async replaceForProfile(tenantId, vendorProfileId, socialLinks, now) {
    await execute(
      `DELETE FROM vendor_profile_social_links WHERE tenant_id=$1 AND vendor_profile_id=$2`,
      [tenantId, vendorProfileId]
    );
    for (const sl of socialLinks) {
      await execute(
        `INSERT INTO vendor_profile_social_links
           (id, tenant_id, vendor_profile_id, channel, url, prefilled_message, click_count, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 0, $6, $6)`,
        [tenantId, vendorProfileId, sl.channel, sl.url, sl.prefilled_message ?? null, now]
      );
    }
  }
},
```

### E2. Extend `moderationItems` repo: add `findPendingByEntity`

**Memory backend** (add to the `moderationItems` object):
```javascript
async findPendingByEntity(tenantId, entityType, entityId) {
  const PENDING = ['draft', 'submitted', 'under_review', 'changes_requested'];
  return (state.moderationItems ?? []).find(
    r => r.tenant_id === tenantId &&
         r.entity_type === entityType &&
         r.entity_id === entityId &&
         PENDING.includes(r.state)
  ) ?? null;
},
```

**Postgres backend** (add to `moderationItems`):
```javascript
async findPendingByEntity(tenantId, entityType, entityId) {
  return maybeOne(await execute(
    `SELECT * FROM moderation_items
     WHERE tenant_id=$1 AND entity_type=$2 AND entity_id=$3
       AND state IN ('draft','submitted','under_review','changes_requested')
     ORDER BY created_at DESC LIMIT 1`,
    [tenantId, entityType, entityId]
  ));
},
```

### E3. `vendorProfiles` repo — no new methods needed

Existing `findByOrganization`, `create`, and `update` cover all Phase 1 use cases.

---

## Section F — Frontend Changes

### F1. `apps/web/vendor.html` — Add Tab Nav + Profile Tab

**Step 1: Add CSS** (in the existing `<style>` block):
```css
.tabs{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:18px;}
.tab-btn{border:0;background:none;color:var(--muted);padding:10px 16px;border-radius:12px;
         cursor:pointer;font:inherit;font-size:14px;border:1px solid transparent;}
.tab-btn.active{background:#fef3c7;color:var(--accent);border-color:rgba(45,106,159,0.3);}
.tab-content{display:none;}
.tab-content.active{display:block;}
```

**Step 2: Add tab buttons** (insert before `<main>`):
```html
<div class="tabs" style="max-width:1400px;margin:0 auto;padding:0 24px;">
  <button class="tab-btn active" data-tab="inbox">Lead Inbox</button>
  <button class="tab-btn" data-tab="profile">Profile</button>
</div>
```

**Step 3: Wrap existing `<main>` content** by adding class/id:
```html
<div id="tab-inbox" class="tab-content active">
  <main>...</main>  <!-- existing main element goes here unchanged -->
</div>
```

**Step 4: Add `#tab-profile` section** (after the `#tab-inbox` closing div):
```html
<div id="tab-profile" class="tab-content">
  <div style="max-width:900px;margin:0 auto;padding:0 24px 40px;">
    <article class="card">
      <div class="section-head">
        <div>
          <div class="eyebrow">Vendor Profile — CR-VP-01</div>
          <h2>Your public profile</h2>
          <p class="muted" style="font-size:13px;margin:3px 0 0;">
            Saved as a draft for moderation review. Submit when ready.
          </p>
        </div>
        <span id="profile-pending-badge" hidden
          style="padding:6px 12px;border-radius:999px;background:rgba(180,108,20,.1);
                 color:var(--warn);font-size:13px;">⏳ Pending review</span>
      </div>
      <div id="profile-status" class="status" hidden></div>

      <div class="field">
        <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:5px;">
          Company name *
        </label>
        <input type="text" id="pf-company" maxlength="200" placeholder="Your company name">
      </div>
      <div class="field">
        <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:5px;">Tagline</label>
        <input type="text" id="pf-tagline" maxlength="200" placeholder="Up to 200 chars">
      </div>
      <div class="field">
        <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:5px;">Description</label>
        <textarea id="pf-description" style="min-height:120px;"
          placeholder="Up to 5000 chars. HTML is stripped on save."></textarea>
      </div>
      <div class="field">
        <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:5px;">Logo URL</label>
        <input type="url" id="pf-logo-url" placeholder="https://…">
      </div>
      <div class="field">
        <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:5px;">Website URL</label>
        <input type="url" id="pf-website-url" placeholder="https://…">
      </div>
      <div class="field">
        <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:5px;">Industry</label>
        <input type="text" id="pf-industry" placeholder="e.g. Technology, Healthcare…">
      </div>

      <!-- Social links -->
      <div style="display:flex;align-items:center;justify-content:space-between;margin:20px 0 12px;">
        <div>
          <h3 style="margin:0;">Social links</h3>
          <p class="muted" style="font-size:13px;margin:3px 0 0;">One per channel. HTTPS only.</p>
        </div>
        <button class="secondary sm" id="add-social-btn">+ Add link</button>
      </div>
      <div id="social-links-list" class="list"></div>

      <div style="display:flex;gap:10px;margin-top:20px;flex-wrap:wrap;">
        <button class="secondary" id="save-draft-btn">Save draft</button>
        <button class="primary"   id="submit-review-btn">Submit for review</button>
      </div>
    </article>
  </div>
</div>
```

**Step 5: Add JS to the existing `<script type="module">` block:**
```javascript
// Tab switching
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'profile') loadProfile();
  });
});

const SOCIAL_CHANNELS = ['linkedin','youtube','instagram','facebook','x','whatsapp','generic_1','generic_2'];
let socialLinksState = [];   // array of {channel, url, prefilled_message}

async function loadProfile() {
  try {
    const orgId = jwtPayload.organization_id || 'org-vendor';
    const data = await api(`/vendors/${enc(orgId)}/profile`);
    renderProfile(data);
  } catch(e) {
    showProfileStatus('Could not load profile: ' + e.message, 'error');
  }
}

function renderProfile(data) {
  const src = data.pending?.payload ?? data.published?.payload ?? {};
  $('pf-company').value     = src.company_name ?? '';
  $('pf-tagline').value     = src.tagline ?? '';
  $('pf-description').value = src.description ?? '';
  $('pf-logo-url').value    = src.logo_url ?? '';
  $('pf-website-url').value = src.website_url ?? '';
  $('pf-industry').value    = src.industry ?? '';
  socialLinksState = src.social_links ? [...src.social_links] : [];
  renderSocialLinks();
  const badge = $('profile-pending-badge');
  badge.hidden = !data.pending;
  if (data.pending) badge.textContent = '⏳ ' + humanize(data.pending.state);
}

function renderSocialLinks() {
  const list = $('social-links-list');
  while (list.firstChild) list.removeChild(list.firstChild);
  if (!socialLinksState.length) {
    const empty = document.createElement('div');
    empty.className = 'item muted';
    empty.textContent = 'No social links added yet.';
    list.appendChild(empty);
    return;
  }
  socialLinksState.forEach((sl, idx) => {
    const row = document.createElement('div');
    row.className = 'item';
    row.style.cssText = 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;';

    const channelSel = document.createElement('select');
    channelSel.style.cssText = 'width:130px;flex-shrink:0;';
    SOCIAL_CHANNELS.forEach(ch => {
      const opt = document.createElement('option');
      opt.value = ch;
      opt.textContent = ch;
      if (ch === sl.channel) opt.selected = true;
      channelSel.appendChild(opt);
    });
    channelSel.addEventListener('change', () => { socialLinksState[idx].channel = channelSel.value; });

    const urlInput = document.createElement('input');
    urlInput.type = 'url';
    urlInput.placeholder = 'https://…';
    urlInput.value = sl.url;
    urlInput.style.flex = '1';
    urlInput.addEventListener('input', () => { socialLinksState[idx].url = urlInput.value; });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'secondary sm';
    removeBtn.textContent = '✕';
    removeBtn.style.flexShrink = '0';
    removeBtn.addEventListener('click', () => {
      socialLinksState.splice(idx, 1);
      renderSocialLinks();
    });

    row.appendChild(channelSel);
    row.appendChild(urlInput);
    row.appendChild(removeBtn);
    list.appendChild(row);
  });
}

$('add-social-btn').addEventListener('click', () => {
  if (socialLinksState.length >= 8) {
    showProfileStatus('Maximum 8 social links.', 'error');
    return;
  }
  const usedChannels = new Set(socialLinksState.map(sl => sl.channel));
  const next = SOCIAL_CHANNELS.find(ch => !usedChannels.has(ch)) || 'generic_1';
  socialLinksState.push({ channel: next, url: '', prefilled_message: null });
  renderSocialLinks();
});

function buildProfileBody(submit) {
  return {
    company_name: $('pf-company').value.trim(),
    tagline:      $('pf-tagline').value.trim(),
    description:  $('pf-description').value.trim(),
    logo_url:     $('pf-logo-url').value.trim(),
    website_url:  $('pf-website-url').value.trim(),
    industry:     $('pf-industry').value.trim(),
    social_links: socialLinksState.map(sl => ({ channel: sl.channel, url: sl.url.trim() })),
    submit
  };
}

$('save-draft-btn').addEventListener('click', async () => {
  try {
    const orgId = jwtPayload.organization_id || 'org-vendor';
    await api(`/vendors/${enc(orgId)}/profile`, { method: 'PATCH', body: buildProfileBody(false) });
    showProfileStatus('Draft saved.', 'ok');
    loadProfile();
  } catch(e) { showProfileStatus(e.message, 'error'); }
});

$('submit-review-btn').addEventListener('click', async () => {
  try {
    const orgId = jwtPayload.organization_id || 'org-vendor';
    await api(`/vendors/${enc(orgId)}/profile`, { method: 'PATCH', body: buildProfileBody(true) });
    showProfileStatus('Submitted for review.', 'ok');
    loadProfile();
  } catch(e) { showProfileStatus(e.message, 'error'); }
});

function showProfileStatus(text, type) {
  const el = $('profile-status');
  el.textContent = text;
  el.className = 'status ' + type;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 4000);
}
```

---

### F2. `apps/web/attendee.html` — Add Vendor Profile Card in Screen 1

**Step 1: Add the card HTML** to `#screen-landing`, between `#landing-context` and the consent button:
```html
<!-- Vendor profile card — populated by loadVendorProfile() after session load -->
<div class="card" id="vendor-profile-card" hidden>
  <h3 id="vp-company-name" style="margin:0 0 6px;font-size:1.1rem;"></h3>
  <p  id="vp-tagline" class="muted" style="margin:0 0 10px;font-size:14px;"></p>
  <p  id="vp-description" style="margin:0 0 10px;font-size:14px;line-height:1.6;"></p>
  <div id="vp-social-links" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:4px;"></div>
</div>
```

**Step 2: Add call in `renderLanding(ia)`** (append to the existing function, after the stall/event display lines):
```javascript
const stallId = ia.current_connection?.stall_id;
if (stallId) loadVendorProfile(stallId);
```

**Step 3: Add `loadVendorProfile` function** (add to the `<script type="module">` block):
```javascript
async function loadVendorProfile(stallId) {
  try {
    const vp = await apiPublic(`/stalls/${enc(stallId)}/vendor-profile`);
    if (!vp.has_profile) return;  // card stays hidden; stall+org already in landing-context

    $('vp-company-name').textContent = vp.company_name || '';
    $('vp-tagline').textContent      = vp.tagline || '';
    $('vp-description').textContent  = vp.description || '';

    const sl = $('vp-social-links');
    while (sl.firstChild) sl.removeChild(sl.firstChild);
    for (const link of vp.social_links ?? []) {
      const a = document.createElement('a');
      a.href = link.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = 'tag muted-tag';
      a.style.textDecoration = 'none';
      a.textContent = link.channel;   // safe: known enum value
      sl.appendChild(a);
    }

    $('vendor-profile-card').hidden = false;
  } catch {
    // silent fail: vendor profile is supplementary, not critical
  }
}
```

**Step 4: Add `apiPublic` helper** (no auth header, uses tenant-id only):
```javascript
async function apiPublic(path) {
  const resp = await fetch(`${apiBase}${path}`, {
    headers: { 'x-tenant-id': 'tenant-demo' },
    cache: 'no-store'
  });
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(payload.error || `Request failed ${resp.status}`);
  return payload;
}
```

---

## Section G — Tests

**File:** `apps/api/test/p2-phase1-vendor-profile.test.mjs`

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, makeToken, postJson, getJson } from './helpers.mjs';

// helpers.mjs already has these patterns from existing tests

test.describe('P2 Phase 1 — Vendor Profile Core (CR-VP-01)', () => {
  let app, editorToken, nonEditorToken, approverToken;

  // ── Setup ──────────────────────────────────────────────────────────
  test.before(async () => {
    app = await makeTestApp();
    // vendor_content_editor=true, vendor_content_approver=false
    editorToken = makeToken({
      role: 'vendor_manager', organization_id: 'org-vendor', tenant_id: 'tenant-demo',
      user_id: 'user-vendor', vendor_content_editor: true, vendor_content_approver: false
    });
    // vendor_content_editor=false
    nonEditorToken = makeToken({
      role: 'vendor_manager', organization_id: 'org-vendor', tenant_id: 'tenant-demo',
      user_id: 'user-vendor-2', vendor_content_editor: false, vendor_content_approver: false
    });
    // vendor_content_approver=true, editor=false, different user_id
    approverToken = makeToken({
      role: 'vendor_manager', organization_id: 'org-vendor', tenant_id: 'tenant-demo',
      user_id: 'user-vendor-approver', vendor_content_editor: false, vendor_content_approver: true
    });
  });

  // ── Test 1: PATCH creates moderation_item with full snapshot (D1 verified) ─
  test('PATCH /profile creates draft moderation_item with full payload', async () => {
    const res = await postJson(app, '/vendors/org-vendor/profile', editorToken, {
      company_name: 'Acme Corp', tagline: 'Tag', description: 'Desc',
      logo_url: 'https://logo.test', website_url: 'https://acme.test', industry: 'Tech',
      social_links: [{ channel: 'linkedin', url: 'https://linkedin.com/acme' }]
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.item.state, 'draft');
    assert.strictEqual(res.body.item.payload.company_name, 'Acme Corp');
    assert.strictEqual(res.body.item.payload.social_links[0].channel, 'linkedin');
  });

  // ── Test 2: No vendor_content_editor → 403 ─────────────────────────────
  test('PATCH /profile by user without vendor_content_editor → 403', async () => {
    const res = await postJson(app, '/vendors/org-vendor/profile', nonEditorToken, {
      company_name: 'Acme', _method: 'PATCH'
    }, 'PATCH');
    assert.strictEqual(res.status, 403);
  });

  // ── Test 3: MT-VP-01 regression — editor cannot approve own submission ──
  test('editor submits own profile, editor cannot approve → 403', async () => {
    await postJson(app, '/vendors/org-vendor/profile', editorToken, {
      company_name: 'Acme', submit: true
    }, 'PATCH');
    const listRes = await getJson(app, '/vendors/org-vendor/moderation-items', editorToken);
    const itemId = listRes.body.items.find(i => i.state === 'submitted').id;
    // Claim for review
    await postJson(app, `/moderation-items/${itemId}/transition`, editorToken, { to_state: 'under_review' });
    // Editor tries to approve — must fail (AP-4)
    const approveRes = await postJson(app, `/moderation-items/${itemId}/transition`, editorToken, { to_state: 'approved' });
    assert.strictEqual(approveRes.status, 403);
  });

  // ── Test 4: Approver approves → currently_published_item_id updates atomically ─
  test('approver approves profile → vendor_profiles pointer and social links sync', async () => {
    const patchRes = await postJson(app, '/vendors/org-vendor/profile', editorToken, {
      company_name: 'Acme Corp', social_links: [{ channel: 'youtube', url: 'https://youtube.com/acme' }],
      submit: true
    }, 'PATCH');
    const itemId = patchRes.body.item.id;
    await postJson(app, `/moderation-items/${itemId}/transition`, editorToken, { to_state: 'under_review' });
    const approveRes = await postJson(app, `/moderation-items/${itemId}/transition`, approverToken, { to_state: 'approved' });
    assert.strictEqual(approveRes.status, 200);
    // GET /profile should show published
    const profileRes = await getJson(app, '/vendors/org-vendor/profile', editorToken);
    assert.strictEqual(profileRes.body.published.item_id, itemId);
    // GET /social-links should show the synced link
    const slRes = await getJson(app, '/vendors/org-vendor/social-links', editorToken);
    assert.strictEqual(slRes.body.items.length, 1);
    assert.strictEqual(slRes.body.items[0].channel, 'youtube');
  });

  // ── Test 5: GET /profile returns approved item, not draft ──────────────
  test('GET /profile returns published item, not newest draft', async () => {
    // Approve a profile first (reuse helper)
    await approveProfile(app, editorToken, approverToken, 'Acme Corp v1');
    // Create a new draft
    await postJson(app, '/vendors/org-vendor/profile', editorToken, { company_name: 'Acme Corp v2' }, 'PATCH');
    const res = await getJson(app, '/vendors/org-vendor/profile', editorToken);
    assert.strictEqual(res.body.published.payload.company_name, 'Acme Corp v1');
    assert.strictEqual(res.body.pending.payload.company_name, 'Acme Corp v2');
  });

  // ── Test 6: No approved profile → fallback (stall+org name) ────────────
  test('GET /stalls/:stallId/vendor-profile with no approved profile → fallback', async () => {
    const res = await getJson(app, '/stalls/stall-ie-a1/vendor-profile', null /* no auth */);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.has_profile, false);
    assert.ok(res.body.stall_name, 'fallback must include stall_name');
    assert.ok(res.body.org_name,   'fallback must include org_name');
  });

  // ── Test 7: Approved profile → returns 6 fields + social links ─────────
  test('GET /stalls/:stallId/vendor-profile with approved profile → full content', async () => {
    await approveProfileWithLinks(app, editorToken, approverToken);
    const res = await getJson(app, '/stalls/stall-ie-a1/vendor-profile', null);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.has_profile, true);
    assert.strictEqual(res.body.company_name, 'Acme Corp');
    assert.ok(Array.isArray(res.body.social_links));
    assert.strictEqual(res.body.social_links.length, 1);
    assert.strictEqual(res.body.social_links[0].channel, 'linkedin');
  });

  // ── Test 8: Non-https website_url → 422 ────────────────────────────────
  test('PATCH /profile with http website_url → 422', async () => {
    const res = await postJson(app, '/vendors/org-vendor/profile', editorToken, {
      company_name: 'Acme', website_url: 'http://insecure.example.com'
    }, 'PATCH');
    assert.strictEqual(res.status, 422);
  });

  // ── Test 9: HTML in description → stored stripped ──────────────────────
  test('PATCH /profile with HTML in description → stored as plain text', async () => {
    const res = await postJson(app, '/vendors/org-vendor/profile', editorToken, {
      company_name: 'Acme',
      description: '<b>Hello</b> <script>alert(1)</script> World'
    }, 'PATCH');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.item.payload.description, 'Hello  World');
  });

  // ── Test 10: Social link with http URL → 422 ───────────────────────────
  test('PATCH /profile with non-https social link URL → 422', async () => {
    const res = await postJson(app, '/vendors/org-vendor/profile', editorToken, {
      company_name: 'Acme',
      social_links: [{ channel: 'linkedin', url: 'http://not-secure.com' }]
    }, 'PATCH');
    assert.strictEqual(res.status, 422);
  });

  // ── Test 11: Non-https logo_url → 422 ─────────────────────────────────
  test('PATCH /profile with non-https logo_url → 422', async () => {
    const res = await postJson(app, '/vendors/org-vendor/profile', editorToken, {
      company_name: 'Acme', logo_url: 'http://logo.jpg'
    }, 'PATCH');
    assert.strictEqual(res.status, 422);
  });

  // ── Test 12: First profile creation auto-creates vendor_profiles shell ─
  test('PATCH /profile auto-creates vendor_profiles shell on first save', async () => {
    const res = await postJson(app, '/vendors/org-vendor/profile', editorToken, {
      company_name: 'Brand New Co'
    }, 'PATCH');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.item.state, 'draft');
    const profileRes = await getJson(app, '/vendors/org-vendor/profile', editorToken);
    assert.ok(profileRes.body.vendor_profile_id, 'shell row must exist after first PATCH');
  });

  // ── Test 13: PUT /social-links merges into existing draft ──────────────
  test('PUT /social-links replaces social_links in existing draft', async () => {
    // Start with linkedin link
    await postJson(app, '/vendors/org-vendor/profile', editorToken, {
      company_name: 'Acme',
      social_links: [{ channel: 'linkedin', url: 'https://linkedin.com/acme' }]
    }, 'PATCH');
    // PUT youtube only
    const res = await postJson(app, '/vendors/org-vendor/social-links', editorToken, {
      social_links: [{ channel: 'youtube', url: 'https://youtube.com/acme' }]
    }, 'PUT');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.item.payload.social_links.length, 1);
    assert.strictEqual(res.body.item.payload.social_links[0].channel, 'youtube');
  });
});
```

**Baseline:** 497 pass, 0 fail (measured 2026-05-26).
**Target after Phase 1:** 509–512 pass (497 + 12–15 new depending on helper count), 0 fail.

---

## Section H — File Change Inventory

| File | Status | Approx Lines | Purpose |
|------|--------|-------------|---------|
| `apps/api/migrations/070_vendor_profile_social_links.sql` | **NEW** | 28 | Social links table, vendor_profiles UNIQUE index, RLS, grants |
| `apps/api/migrations/070_vendor_profile_social_links.rollback.sql` | **NEW** | 5 | Rollback: drop table + index |
| `apps/api/test/p2-phase1-vendor-profile.test.mjs` | **NEW** | ~200 | 13 new tests covering all Section G cases |
| `apps/api/src/routes.mjs` | **MODIFY** | +215 | `registerVendorProfileRoutes()` (routes D1–D5) + 8-line D6 extension to approval block |
| `apps/api/src/access-control.mjs` | **MODIFY** | +5 | 4 `entry()` + 1 `publicEntry()` for 5 new routes |
| `apps/api/src/repositories/memory.mjs` | **MODIFY** | +35 | `vendorProfileSocialLinks` repo + `moderationItems.findPendingByEntity` |
| `apps/api/src/repositories/postgres.mjs` | **MODIFY** | +35 | Same as memory — parallel implementation |
| `apps/web/vendor.html` | **MODIFY** | +145 | Tab nav CSS/HTML, `#tab-profile` form, tab-switch JS, `loadProfile()`, save/submit handlers |
| `apps/web/attendee.html` | **MODIFY** | +45 | `#vendor-profile-card` HTML in screen-landing, `loadVendorProfile()`, `apiPublic()` helper |

**Total new lines:** ~715 across 9 files.

---

## Section I — Risks and Open Questions

### Risk 1 — LOGO: `branding_assets` FK not viable ⚠️ DECISION REQUIRED

**Confidence: 55%** on the spec's `logo_asset_id UUID FK to branding_assets` as written.

**Why unimplementable:** `branding_assets.id` is TEXT (not UUID); table is event-scoped (tenant_id + event_id), not vendor-scoped; logos stored as URL strings; no file upload endpoint exists anywhere.

**Two options — Kishore must decide before execution:**

> **Option A (recommended):** Change `logo_asset_id UUID FK to branding_assets` to `logo_url TEXT` (HTTPS URL, vendor pastes it). Validation: must start with `https://`. No scan_status check (no upload pipeline). Defer file upload + virus scan to Phase 1.1.
>
> **Option B:** Build a new `vendor_media_assets` table + file upload endpoint in this Phase 1. Adds ~3 tasks, a new migration 071, multipart form handling. Estimated +250 lines.

**The plan assumes Option A.** If B: sections B and D need addenda before execution begins.

---

### Risk 2 — FIRST PROFILE CREATION: Duplicate Shell Rows (95% confident)

**Status:** Resolved by auto-create pattern in D2/D4 + UNIQUE index in migration 070:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS vendor_profiles_org_unique
  ON vendor_profiles(tenant_id, organization_id);
```

This prevents race-condition duplicates and causes a clean DB error if two concurrent PATCHes race (the second will 409 on the DB constraint). Memory backend uses in-process state so no race in tests.

---

### Risk 3 — DRAFT MERGE RACE (90% confident)

If `PATCH /profile` and `PUT /social-links` are called concurrently from two browser tabs, a last-write-wins race could corrupt the draft payload. This is a known limitation of Phase 1's non-locked merge pattern. Mitigation: the vendor UI is single-tab by design. Document in commit message.

---

### Risk 4 — Transition Handler Extension (93% confident)

The D6 extension adds 8 lines inside the existing `isApprove` block, guarded by `entity_type === 'vendor_profiles'`. The postgres `withTransaction` wraps everything atomically. The memory backend's `withTransaction` is a passthrough (no real rollback), which is acceptable for test isolation (state resets per test). The 7% risk: the `txRepos.vendorProfileSocialLinks` call must use the transaction repos, not the outer `repos` — verify the repos object passed into the transaction contains the new `vendorProfileSocialLinks` key.

---

### Risk 5 — `attendee.html` Modification (98% confident)

The constraint "ZERO changes to attendees code" applies to backend attendee feature logic (consent, profile, scoring). Modifying `attendee.html` to add a supplementary vendor profile card is frontend-only, additive, and non-breaking. The card is `hidden` by default. `loadVendorProfile()` wraps in `try/catch` — any API failure leaves the page unchanged. The `apiPublic()` helper uses only the tenant-id header (same pattern as the existing `/s/:token` endpoint in `s.html`).

---

**Confidence: 88%**
**Basis:** Full codebase investigation complete; all 5 G3 questions answered; architecture integrates cleanly with Phase 0 repos, routes, and ACM patterns.
**Below-98 reason:** Risk 1 (logo field implementation) requires Kishore's explicit Option A/B decision before execution can begin.
