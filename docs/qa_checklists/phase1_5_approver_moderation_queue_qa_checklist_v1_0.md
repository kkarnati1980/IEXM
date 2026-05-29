# P2 Phase 1.5 — Approver Moderation Queue: QA Checklist v1.0

**Date:** 2026-05-29  
**Login credentials:**
- Editor: `vendor@test.com` / `demo` (token: `demo-vendor-token`)
- Approver: `vendor-approver@test.com` / `demo` (token: `demo-vendor-approver-token`)

---

## A. Review Tab Render (approver-only gate)

- [ ] A1. Log in as **editor** (`vendor@test.com`) → vendor.html → tab bar shows **Leads** and **Profile** only; no Review tab
- [ ] A2. Log in as **approver** (`vendor-approver@test.com`) → tab bar shows **Leads**, **Profile**, and **Review**
- [ ] A3. On 375px viewport (iPhone SE): three tabs wrap onto two rows without overflow or truncation; all tabs tappable

---

## B. Queue Loading and Display

- [ ] B1. Click Review tab → "Loading…" appears briefly; queue renders
- [ ] B2. Submit a profile as editor, then reload Review tab as approver → item appears with state pill "Submitted"
- [ ] B3. Empty queue shows "No items pending review." message (not blank)
- [ ] B4. "↻ Refresh" button reloads queue; button shows "↻ …" while loading then restores
- [ ] B5. Editor display name resolves lazily in the Editor column (not a raw ID)

---

## C. Claim

- [ ] C1. Click **Review** on a Submitted item → pane opens with proposed payload, empty thread, and **Claim** button
- [ ] C2. Click **Claim** → pane closes, queue refreshes; item now shows state "Under review (claimed)"
- [ ] C3. Refresh queue → item still shows under_review
- [ ] C4. Click **Review** on the claimed item → action bar shows Approve / Request changes / Reject / Release (not Claim)

---

## D. Approve

- [ ] D1. With item under_review, click **Approve** → item disappears from queue (terminal state); profile tab shows "Live" pill for the editor
- [ ] D2. Verify attendee-facing endpoint (`GET /stalls/:id/vendor-profile?tenant_id=…`) returns the approved payload
- [ ] D3. A `vendor_profile_approved` notification is queued in the admin (check `GET /organizer/notifications` or DB)

---

## E. Request Changes

- [ ] E1. With item under_review, click **Request changes** without entering a note → inline error "A note is required" appears; transition does NOT fire
- [ ] E2. Enter a note and click **Request changes** → item disappears from queue; state returns to "Changes requested" in editor's Profile tab
- [ ] E3. **Editor-feedback loop:** Log in as editor → Profile tab status bar shows "Changes requested" pill + reviewer note text visible below the bar
- [ ] E4. Form fields are editable in changes_requested state (not locked)
- [ ] E5. **Resubmit button:** click "Resubmit for review" → Profile tab shows "Submitted" pill; item reappears in approver queue
- [ ] E6. A `vendor_profile_needs_changes` notification is queued for the editor

---

## F. Reject

- [ ] F1. With item under_review, click **Reject** without note → inline error; no transition
- [ ] F2. Enter note and click **Reject** → item disappears from queue; editor Profile tab shows "Submitted"? (No — rejected is terminal; pending item should be gone and profile shows last published state or no pending)
- [ ] F3. Editor cannot re-submit from rejected state (rejected is terminal; editor must start a new draft)
- [ ] F4. A `vendor_profile_needs_changes` notification is queued

---

## G. Release

- [ ] G1. With item under_review, click **Release** → state goes back to Submitted; item reappears in queue with Submitted pill
- [ ] G2. Log in as a second approver → Submitted item is visible and claimable (advisory claim, no hard lock)

---

## H. Form Lock (Editor side — submitted / under_review)

- [ ] H1. Editor submits a profile → Profile tab form fields become disabled; "Save draft" and "Submit for review" buttons disabled
- [ ] H2. **Withdraw button** appears next to the Refresh button while submitted/under_review
- [ ] H3. Click **Withdraw** → item state becomes "withdrawn"; form fields re-enable; Withdraw button disappears
- [ ] H4. Attempting to edit via direct PATCH (e.g. Postman) while submitted → 422 "Profile is under review — withdraw before editing"

---

## I. Own-Submission Guard (AP-4)

- [ ] I1. Editor submits their own item → in approver queue (same user is approver), Review pane shows "This is your own submission — claim not available." for Submitted state
- [ ] I2. Once claimed (by same user), action bar shows Approve/Request changes/Reject/Release WITH the single-operator warning text (if only one approver in org)
- [ ] I3. Click **Approve** on own item in a **multi-approver org** → 403 response; no modal; error message shown in pane ("Editor cannot approve own submission")

---

## J. Single-Operator Confirm Modal

- [ ] J1. In a demo environment where the org has only one approver-capable user, clicking **Approve** on own item → modal appears: "Single-operator approval — you are the only approver-capable user…"
- [ ] J2. Click **Cancel** → modal closes; no transition; item state unchanged
- [ ] J3. Click **Confirm self-approve** → item approved; audit log shows `self_approved_single_operator` action; system note "[System] Single-operator…" visible in thread
- [ ] J4. Modal does NOT appear for a multi-approver org (SO-3 edge case — verify no modal is ever shown when `details.single_operator` is absent)

---

## K. Thread Rendering

- [ ] K1. After several transitions on an item, open Review pane → thread shows each note with actor display name, action label, and timestamp
- [ ] K2. Notes are read-only — no edit or delete affordance
- [ ] K3. Thread for a freshly claimed item shows the "claim" action with actor name

---

## L. Notification Emails (integration check)

- [ ] L1. Editor submits → at least one `vendor_profile_submitted` notification in the queue (approver's email as recipient); editor's own email NOT in recipients
- [ ] L2. Approver approves → `vendor_profile_approved` notification queued for editor
- [ ] L3. Approver requests changes → `vendor_profile_needs_changes` notification queued; note text present in `system_payload.body`

---

## M. Refresh-after-Transition

- [ ] M1. After every action (claim, approve, request-changes, reject, release), the queue refreshes automatically; the acted-on item either disappears or shows updated state without manual refresh
- [ ] M2. Profile tab "↻ Refresh" button still works after a transition and reflects the new state

---

## N. Edge Cases / Loading States

- [ ] N1. Open Review tab with no items → "No items pending review." shown; pane hidden
- [ ] N2. Double-click Approve quickly → second click does nothing (REVIEW_SUBMITTING guard)
- [ ] N3. Stale approval (approve an item that was already approved by another approver in another tab) → 409 response surfaced as error message, no crash

---

## O. Two-User Cross-Flow (end-to-end)

- [ ] O1. **Step 1:** Log in as editor → PATCH a profile → submit → Profile tab shows "Submitted"
- [ ] O2. **Step 2:** Log in as approver → Review tab → claim the item
- [ ] O3. **Step 3:** Approver requests changes with note "Please add a tagline."
- [ ] O4. **Step 4:** Log in as editor → Profile tab → "Changes requested" pill; note "Please add a tagline." visible; form editable; enter a tagline; click **Resubmit for review**
- [ ] O5. **Step 5:** Log in as approver → item reappears in queue; approver approves
- [ ] O6. **Step 6:** Editor's Profile tab shows "Live" pill; attendee-facing endpoint returns the approved payload
- [ ] O7. Email notifications queued at steps O1 (submitted), O3 (needs_changes), O5 (approved)
