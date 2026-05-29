# P2 Phase 1.5 — Approver Moderation Queue UI: Build Log v1.0

**Date:** 2026-05-29  
**Branch:** main  
**Tests:** 539 pass, 0 fail (baseline 519; 20 net new)  
**Schema changes:** NONE

---

## Scope

Vendor-side approver Review tab in `apps/web/vendor.html`. Gives `vendor_content_approver` users the ability to claim, approve, request-changes, reject, and release vendor-profile moderation items, with the append-only discussion thread. Closes the editor-feedback loop (approver note surfaced in status panel, re-submit button, form lock while under review). Backend slice: transition-handler enhancements (no new routes, no new tables).

---

## Governing Spec

CR-VENDOR-2026-001 v1.0 §14 — Approver Moderation Queue.  
Built on: Phase 0 (moderation foundation) + Phase 1 (vendor profile core, CR-VP-01).

---

## Changes

### Backend

| File | Change |
|------|--------|
| `apps/api/src/policy.mjs` | Added `canReleaseModeration`, async `canSelfApproveAsSingleOperator` |
| `apps/api/src/repositories/memory.mjs` | Added `users.countApproverCapableInOrg`, `users.listApproverCapableInOrg` |
| `apps/api/src/repositories/postgres.mjs` | Same two methods (raw SQL, status='active' AND deleted_at IS NULL) |
| `apps/api/src/notification-templates.mjs` | Three new templates: `vendor_profile_submitted`, `vendor_profile_approved`, `vendor_profile_needs_changes` |
| `apps/api/src/routes.mjs` | See detail below |

**routes.mjs changes:**
- `/auth/me`: exposes `vendor_content_editor` and `vendor_content_approver` in the response principal
- `MODERATION_TRANSITIONS`: added `"submitted"` to `under_review`'s allowed list (enables Release)
- Transition handler: optimistic-concurrency 409 guard (`expected_updated_at`); classify release/resubmit; C5 authz by from-state; single-operator self-approve two-call path (FIX-1 applied: count check runs FIRST, plain 403 for multi-approver orgs even with confirm flag); note-action detection (release, self_approved_single_operator); system note for self-approve; notification fan-out (M2 self-notify suppression); audit metadata includes action name
- VP-22: replaced auto-draft-on-edit block with hard 422 for submitted/under_review states (regardless of `submit` flag) — **Phase 1 minor asterisk (M4):** this was a latent Phase 1 bug where save-draft on a submitted item silently reverted state. Phase 1.5 closes it; the Phase 1 suite test for VP-22 has been inverted accordingly
- Social links PUT (D5): same 422 edit-lock applied — social links saves share `entity_type="vendor_profiles"` and the same moderation item as the profile PATCH (see M3 decision below)
- History handler: enriches each note with `actor_display_name` via `findByIdGlobal`

### Frontend

`apps/web/vendor.html` (+~320 lines):
- `api()` helper: attaches `err.payload` and `err.status` to thrown errors (enables `details.single_operator` detection in doTransition)
- Tab bar: Review button injected dynamically after `/auth/me` if `vendor_content_approver === true`
- `switchTab`: handles 'review'
- `loadProfile`: fetches latest `request_changes` note for `changes_requested` state and passes to `renderProfileStatus`
- `renderProfileStatus` (enhanced): form-lock on submitted/under_review; approver note panel; Withdraw button; Resubmit button; approved confirmation toast
- `withdrawProfile` / `resubmitProfile`: both call `POST /transition` directly (M4 fix: resubmit no longer goes through the PATCH path which was a no-op from changes_requested)
- Review tab JS: `loadModerationQueue`, `renderQueue`, `openReviewPane`, `renderReviewPane`, `doTransition`, `showSingleOperatorModal`, `confirmSingleOpApprove`, `showReviewMsg`
- Security: Review button uses `data-item-id` + addEventListener (no inline onclick with server-provided IDs); single-operator modal built with DOM methods (no user text in innerHTML); `esc()` applied to all server-provided values rendered as HTML
- 375px CSS guard added

---

## M3 Decision — Social Links and the Review Queue

Social-link saves via `PUT /vendors/:orgId/social-links` always produce a `vendor_profiles`-typed moderation item (same entity_type and entity_id as the profile PATCH). They share the same moderation item and therefore appear in the Review queue automatically. The edit-lock (submitted/under_review → 422) applies to the social-links PUT as well. Social links are **IN SCOPE** for the Review queue and edit-lock in v1.5. No separate entity_type, no separate queue.

---

## Claim Advisory Statement (v1.5 design boundary — read before assuming hard lock exists)

**Claim is advisory in v1.5.** The `under_review` state (reached via "Claim") is enforced by the state machine — only explicit transitions can leave it. However, the 409 optimistic-concurrency guard prevents stale overwrite only when the caller echoes `expected_updated_at`. A second approver who fetches the item after the first approver claims it (and therefore receives the updated `updated_at`) can still transition the item. Hard claim lock with a `reviewer_user_id` column is deferred to v2. The "Take over" / "Release" affordance (under_review → submitted) is available to any approver-capable user.

---

## Notification Design

| Trigger | Recipients | Template | M2 Self-suppress |
|---------|-----------|----------|-----------------|
| `→ submitted` | All `vendor_content_approver` users in org, `status='active'`, `deleted_at IS NULL` | `vendor_profile_submitted` | Yes — actor excluded |
| `→ approved` | Item's `editor_user_id` | `vendor_profile_approved` | N/A |
| `→ changes_requested` or `→ rejected` | Item's `editor_user_id` | `vendor_profile_needs_changes` | N/A |

---

## Single-Operator Self-Approve Fallback

Three conditions required:
- (a) `principal.vendor_content_approver === true`  
- (b) `principal.user_id === item.editor_user_id`  
- (c) `countApproverCapableInOrg(tenant, org) <= 1` (active, non-deleted users only)

**FIX-1 (applied):** Condition (c) is checked FIRST, before the confirm-flag check. If the org has multiple approvers, the API returns plain 403 "Editor cannot approve own submission" — never `self_approval_blocked`. This ensures the single-operator modal never appears for a multi-approver org even if the confirm flag is somehow sent.

Two-call protocol:  
1. Call without `confirm_single_operator` → 403 `{ error: "self_approval_blocked", details: { single_operator: true } }` → frontend shows modal  
2. Call with `{ confirm_single_operator: true }` → re-checks (c); if still true → allowed + audit note `self_approved_single_operator` + system note "[System] Single-operator self-approval…"

---

## AP-4 Contract Summary (Phase 1.5)

| Scenario | API result | Frontend behaviour |
|----------|-----------|-------------------|
| Approver approves different user's item | 200 | Allowed |
| Approver requests changes on different user's item | 200 | Allowed |
| Editor tries to approve own (multi-approver org) | 403 plain | Action bar disabled; API blocks |
| Editor/approver (single-operator) tries to approve own, no confirm | 403 single_operator:true | Modal shown |
| Editor/approver (single-operator) confirms | 200 + audit + system note | Allowed |
| Non-approver tries release | 403 | Not available (release button only shown to approver-flagged users via /auth/me gate) |
| Non-editor tries resubmit | 403 | Resubmit button only in editor's Profile tab status bar |

---

## Tests Added / Modified

**Modified (1):** VP-22 test in `p2-phase1-vendor-profile.test.mjs` — inverted from asserting auto-draft success to asserting 422 + state unchanged.

**New file:** `apps/api/test/p2-phase1-5-moderation-queue.test.mjs` — 20 tests:
Auth-1, VP-22b, VP-22c, VP-23, MT-VP-10, SO-1, SO-2, SO-3 (FIX-1), SO-4, Conc-1, Conc-2, Rel-1, Rel-2, Resub-1, Resub-2 (FIX-3), Notif-1, Notif-2, Notif-3, Hist-1, Audit-1.

**Confirmed passing:** MT-VP-01 (editor cannot self-approve), MT-VP-02 (notes immutable), MT-VP-03 (no-gap publishing pointer swap).

**Total:** 539 pass, 0 fail.

---

## Phase Completion Table

| Phase | Status | Tests |
|-------|--------|-------|
| P2 Phase 0 — Moderation foundation | ✓ Done | included in 539 |
| P2 Phase 1 — Vendor profile core (CR-VP-01) | ✓ Done (VP-22 latent bug closed by P1.5) | included in 539 |
| P2 Phase 1.5 — Approver moderation queue UI | ✓ Done | 20 new (539 total) |

---

## UI Categories (NOT tested by automated suite — require §16 checklist walk)

- Review tab render (approver-only gate via /auth/me)
- Claim/approve/changes/reject/release flows in the browser
- Mandatory-note UI block (inline error, not alert)
- Own-submission guard (action bar hint for self-items)
- Single-operator confirm modal render and flow
- Thread rendering with actor names
- Editor-feedback loop: note visible in status panel → re-submit button works
- Refresh-after-transition (same pattern as 70cbdf4 fix)
- Empty queue / loading states
- 375px layout (3-tab bar no overflow)
- Two-user cross-flow: editor submits → approver claims/acts → editor sees note → email queued
