# Baseline Master Specification
## Physical-World Interaction Infrastructure Platform

This file is the running history of the Master System Specification across all known builds.
The v1.0 text is the spine. Every change from v1.1 and v1.2 is annotated inline at the point where it applies.

Re-run `/baseline` any time a new build version drops — it will extend this file automatically.

---

## Version History

| Version | Date | Author | Summary |
|---|---|---|---|
| v1.0 | April 2026 | Platform Team | Original pre-build specification — requirements, architecture, design, trust, data, commercial |
| v1.1 | 1 May 2026 | Platform Team | First production build — 18 phases complete; technology stack confirmed; Phase 6 deferred |
| v1.2 | 8 May 2026 | Platform Team | Google Drive/OneDrive integration; MFA; snapshot comparison; unified UI; 79 tables; 438 tests |
| v1.3 | 24 May 2026 | Platform Team | Pass types + NFC tag batches; walk-in/bulk import; consent versioning; Pi 5 hardware; CI/CD; P2 Phase 0 moderation foundation; ~90 tables; 488 tests |
| v1.3-patch | 25 May 2026 | Platform Team | Prod schema reconciliation: 70 migrations recorded in prod DB; migrator --reconcile-only + ON CONFLICT DO NOTHING; 494 tests (9 new migrator tests) |
| v1.4 | 26 May 2026 | Platform Team | P2 Phase 1 — Vendor Profile Core (CR-VP-01): moderation-backed vendor profile editor (6 fields + social links), public attendee profile card, migration 070 (`vendor_profile_social_links`), 5 new routes, 510 tests. |
| v1.4-patch | 26 May 2026 | Platform Team | Vendor tab-nav restyle: removed redundant profile subtitle, aligned tab nav with organizer dashboard pattern. Frontend-only; no API or data model changes. |
| v1.4-fix | 26 May 2026 | Platform Team | Industry field restored to vendor profile: was listed in v1.4 spec but silently dropped during execution. Backend validation (max 80 chars), vendor.html form, attendee.html profile card, 2 new tests. 512 tests total. |
| v1.4-hotfix | 26 May 2026 | Platform Team | Fix 500 on PATCH /vendors/:vendorOrgId/profile: ID generation in vendor profile + moderation routes switched from nextId() to randomUUID() for PostgreSQL UUID PK compatibility. Improved 5xx error logging in app.mjs. Regression test VP-16 added; 513 tests total. |
| v1.4-fix2 | 26 May 2026 | Platform Team | Fix null new_status in moderation_notes on PATCH /vendors/:vendorOrgId/profile?submit=true: extracted recordModerationTransition() helper shared by submit + transition paths; memory backend mirrors NOT NULL constraint; regression tests VP-17/VP-18/VP-19 added; 516 tests total. |
| v1.4-qa | 26 May 2026 | Platform Team | Phase 1 QA automation: `phase1_backend_smoke_v1_0.sh` replaces 28 manual checklist items with one idempotent bash script; covers all Phase 1 §1.1–1.8 items plus 10 extra validation cases; establishes `phaseN_backend_smoke_v1_0.sh` pattern for future phases. No schema, route, or node:test count changes. |
| v1.4-qa2 | 27 May 2026 | Platform Team | QA tooling: `seed-approver-user_v1_0.sh` (518 lines) — seeds vendor-approver@test.com, configures AP-4 flag separation (editor vs. approver), writes JWT tokens to /tmp for smoke script. Idempotent. No spec, schema, or route changes. |
| v1.4-fix3 | 27 May 2026 | Platform Team | Fix description field limit: backend now enforces 2000-char max (was 5000 in v1.4 spec; UI already said "2000 chars max"); smoke test A4 updated to boundary-test 2001 chars; 2 new unit tests (2000 → 200, 2001 → 422). |
| v1.4-fix4 | 28 May 2026 | Platform Team | Phase 1 QA fix-up: save-draft on a submitted/under_review item now auto-transitions back to draft before overwriting (moderation integrity); Refresh button loading state + toast added to vendor.html; mobile header responsive reflow at ≤480px. 519 tests. |
| v1.4-fix4b | 28 May 2026 | Platform Team | Mobile header follow-up: `.shell-nav` top-right action group (Vendor / My Account / Sign out) was missing `width:100%` in the `@media(max-width:480px)` block, causing overflow at 375px. Added `width:100%` to `.shell-nav`. Pure CSS; no API, schema, or test count changes. |
| v1.5 | 29 May 2026 | Platform Team | P2 Phase 1.5 — Approver moderation queue UI (CR-VENDOR-2026-001 §14): Review tab in vendor.html (approver-only, dynamically injected); single-operator self-approve fallback (two-call confirm + system audit note); optimistic-concurrency 409 guard; notification fan-out on submit/approve/reject (3 new templates); edit-lock on submitted/under_review items (M4 fix, VP-22 inverted); Release action (under_review → submitted); history enriched with actor names. 539 tests. |

---

## Change Summary

| Version | Added | Changed | Removed | Clarified |
|---|---|---|---|---|
| v1.1 | 3 | 6 | 1 | 4 |
| v1.2 | 12 | 5 | 0 | 2 |
| v1.3 | 9 | 5 | 0 | 0 |
| v1.3-patch | 1 | 1 | 0 | 0 |
| v1.4 | 6 | 4 | 0 | 0 |
| v1.4-patch | 0 | 0 | 0 | 1 |
| v1.4-fix | 0 | 1 | 0 | 1 |
| v1.4-hotfix | 0 | 1 | 0 | 1 |
| v1.4-fix2 | 0 | 2 | 0 | 1 |
| v1.4-qa | 1 | 0 | 0 | 0 |
| v1.4-qa2 | 1 | 0 | 0 | 0 |
| v1.4-fix3 | 0 | 1 | 0 | 1 |
| v1.4-fix4 | 0 | 2 | 0 | 2 |
| v1.4-fix4b | 0 | 1 | 0 | 0 |
| v1.5 | 5 | 6 | 0 | 0 |

---

## Quick Index — All Changes

**v1.5 changes**
- [v1.5-A1] §5.4 Review tab added to vendor.html (approver-only, dynamically injected after `/auth/me` confirms `vendor_content_approver: true`). Shows pending moderation queue for the vendor org; actions: Claim (→ under_review), Approve, Request Changes (note required), Reject (note required), Release (under_review → submitted). Discussion thread displays all moderation notes with actor names. No new routes, no new DB tables.
- [v1.5-A2] §6.3 3 new notification templates: `vendor_profile_submitted` (notifies all org approvers on submit, self-suppressed), `vendor_profile_approved` (notifies editor on approval), `vendor_profile_needs_changes` (notifies editor on changes_requested or rejected).
- [v1.5-A3] §6.3 2 new policy functions: `canReleaseModeration` (approver-flag required) and async `canSelfApproveAsSingleOperator` (returns true only when `countApproverCapableInOrg <= 1`).
- [v1.5-A4] §6.3 2 new repository methods: `users.countApproverCapableInOrg` and `users.listApproverCapableInOrg` (active, non-deleted users only) — used by notification fan-out and single-operator guard.
- [v1.5-A5] §D 20 new tests in `p2-phase1-5-moderation-queue.test.mjs` (Auth-1, VP-22b/c, VP-23, MT-VP-10, SO-1–4, Conc-1/2, Rel-1/2, Resub-1/2, Notif-1–3, Hist-1, Audit-1); total 539 tests.
- [v1.5-C1] §6.3 `GET /auth/me` principal now includes `vendor_content_editor` and `vendor_content_approver` boolean flags; frontend gates Review tab and action buttons on these values.
- [v1.5-C2] §6.3 `MODERATION_TRANSITIONS`: `under_review` allowed-targets now includes `"submitted"` (enables Release — sends item back to queue without rejection note).
- [v1.5-C3] §6.3 `PATCH /vendors/:vendorOrgId/profile`: when item is `submitted` or `under_review`, now returns 422 "Profile is under review — withdraw before editing" (M4 fix). Previous auto-draft behavior (v1.4-fix4 VP-22) was a latent bug — Phase 1.5 closes it; VP-22 test inverted to assert 422 + unchanged state.
- [v1.5-C4] §6.3 `PUT /vendors/:vendorOrgId/social-links`: same 422 edit-lock applied. Social links share the same moderation item as the profile PATCH (`entity_type="vendor_profiles"`) so the lock is shared.
- [v1.5-C5] §6.3 `GET /moderation-items/:itemId/history`: each note now includes `actor_display_name` (resolved via `users.findByIdGlobal`).
- [v1.5-C6] §D Test count: 519 → 539 (20 new; 1 existing VP-22 inverted).

**v1.4-fix4b changes**
- [v1.4-fix4b-C1] §5.4 Mobile header follow-up: `.shell-nav` (the top-right action group containing Vendor / My Account / Sign out links) was not assigned `width:100%` in the `@media(max-width:480px)` block introduced by v1.4-fix4. At 375px viewport this caused the nav to overflow the right edge of the shell bar. Fix: added `width:100%` to `.shell-nav` inside that breakpoint. 1-line CSS change in vendor.html. Desktop and wider-mobile layouts unchanged.

**v1.4-fix4 changes**
- [v1.4-fix4-C1] §6.3 PATCH /vendors/:vendorOrgId/profile: save-draft on a submitted or under_review item now auto-transitions back to draft (via `recordModerationTransition(action='withdraw_to_draft')`) before overwriting the payload. Previously the overwrite was silent with no state transition or audit record. Test VP-22 added.
- [v1.4-fix4-C2] §D Test count: 516 → 519 (3 new tests in p2-phase1-vendor-profile.test.mjs: VP-22 moderation-integrity regression + 2 supporting edge-case tests; smoke script updated with item 1.3b-integrity).
- [v1.4-fix4-CL1] §5.4 Vendor.html Refresh button: now shows disabled/loading state during fetch and fires a 'Status refreshed.' toast on success. Tab-switch loadProfile calls pass `silent:true` to suppress the toast on navigation. No functional change.
- [v1.4-fix4-CL2] §5.4 Mobile header: `@media(max-width:480px)` added — `.shell-bar`, `.shell-nav`, `.tab-bar`, and `#tab-profile` reflow to prevent element overlap at 375px viewport. Desktop layout unchanged.

**v1.4-fix3 changes**
- [v1.4-fix3-C1] §5.4 Description field max length corrected from 5000 to **2000** chars. The UI helper text already said "Description (2000 chars max)"; the backend was silently accepting longer descriptions. v1.4-fix3 adds server-side validation: >2000 → 422 "Description must be 2000 characters or fewer". Smoke test A4 updated to test the 2001-char boundary.
- [v1.4-fix3-CL1] §13 The v1.4-qa smoke test previously tested "description >5000 chars → 422" (the pre-fix threshold). The corrected enforced limit is 2000 chars. 2 new unit tests confirm the boundary: 2000 chars → 200, 2001 chars → 422.

**v1.4-qa2 changes**
- [v1.4-qa2-A1] §13 New QA script: `apps/api/scripts/qa/seed-approver-user_v1_0.sh` (518 lines). Seeds `vendor-approver@test.com` via /users/invite + /auth/accept-invite; sets `vendor_content_editor=true` on vendor@test.com and `vendor_content_approver=true` on vendor-approver@test.com (AP-4 flag separation: editor ≠ approver). Writes both JWT tokens to /tmp/codex_qa_tokens.env for the smoke script to source. Idempotent: re-logs in and refreshes tokens if approver already exists. QA README.md updated (97 lines).

**v1.4-qa changes**
- [v1.4-qa-A1] §13 New `apps/api/scripts/qa/` directory: `phase1_backend_smoke_v1_0.sh` (816 lines), `README.md` (73 lines), `test-fixtures.sh` (11 lines). Replaces 28 manual Phase 1 checklist items with one idempotent bash script. Covers all §1.1–1.8 items plus 10 extra validation cases: cross-org isolation (403), invalid logo_url formats (http://, javascript:) → 422, description >5000 chars → 422, industry >80 chars → 422, social link invalid channel (tiktok) → 422, HTML stripping in display_name, UUID id format (nextId regression), industry field persistence, self-approval guard (vendor approves own submission → 403), reject-with-note and reject-without-note flows. Script features: cleanup/reset before each run, [WRITE] labels on all mutations, --dry-run flag, exit codes 0/1/2, inline progress + final summary table, markdown report fan-out to /tmp/outputs/, docs/qa_reports/, and Obsidian. Establishes `phaseN_backend_smoke_v1_0.sh` naming pattern for future phases.

**v1.4-fix2 changes**
- [v1.4-fix2-CL1] §6.3 PATCH /vendors/:vendorOrgId/profile?submit=true — moderation_notes insert now uses `recordModerationTransition()` helper, which correctly computes `new_status` from the TRANSITIONS state machine and `prior_status` from the current item. Previously the submit path constructed moderation_notes inline without these fields, so `new_status` was null, causing a NOT NULL constraint violation (500) in production. The transition endpoint already used the same helper; both paths now share it.
- [v1.4-fix2-C1] §BUILD Memory backend: `moderation_notes` insert now enforces NOT NULL on `new_status` so the test suite catches this class of bug before it reaches production.
- [v1.4-fix2-C2] §D Test count: 513 → 516 (VP-17: prior_status=draft for existing-draft submit; VP-18: prior_status=null for first-ever submit; VP-19: null new_status throws at repo layer. Two pre-existing moderation-foundation tests that omitted new_status were also fixed).

**v1.4-hotfix changes**
- [v1.4-hotfix-CL1] §6.3 PATCH /vendors/:vendorOrgId/profile (and moderation routes) now use `randomUUID()` from `node:crypto` for ID generation. `nextId()` was producing TEXT strings in the form `prefix-<uuid>` (e.g. `vp-<uuid>`, `mi-<uuid>`, `mn-<uuid>`) which PostgreSQL silently accepted in the memory backend but rejected with a 500 for UUID PRIMARY KEY columns in production. No API contract change — IDs were already opaque strings to callers.
- [v1.4-hotfix-CL2] `app.mjs` 5xx error logging improved: server now emits `cause` and the first 10 stack-trace lines to server logs on any 5xx response. HTTP response body unchanged (still returns generic message to clients).
- [v1.4-hotfix-C1] §D Test count: 512 → 513 (regression test VP-16 added: full form payload verifies 200 + valid string IDs on PATCH /vendors/:vendorOrgId/profile)

**v1.4-fix changes**
- [v1.4-fix-CL1] §5.4 Industry field confirmed present in vendor.html editor and attendee.html profile card — was in v1.4 spec but silently dropped in implementation; restored with max 80 chars (OI-VP-02 taxonomy lookup stays open)
- [v1.4-fix-C1] §D Test count: 510 → 512 (2 new tests: industry persistence, industry length validation)

**v1.4-patch changes**
- [v1.4-patch-CL1] §5.4 Vendor tab nav restyled to match organizer dashboard pattern; redundant subtitle under Profile tab removed — functionality unchanged

**v1.4 changes**
- [v1.4-A1] §7.1 New table: `vendor_profile_social_links`; UNIQUE index on `vendor_profiles(tenant_id, organization_id)`
- [v1.4-A2] §6.3 5 new vendor profile routes (D1–D5) + D6 approval extension; route total 265 → 270
- [v1.4-A3] §5.4 Vendor Profile tab added to vendor.html (profile editor form + social link editor)
- [v1.4-A4] §5.3 Vendor profile card added to attendee landing screen (attendee.html screen 1)
- [v1.4-A5] §13 P2 Phase 1 build phase complete
- [v1.4-A6] §D 13 new tests in p2-phase1-vendor-profile.test.mjs; 510 pass, 0 fail
- [v1.4-C1] §6.3 Total API routes: 265 → 270
- [v1.4-C2] §7.1 Total tables: ~90 → ~91
- [v1.4-C3] §7.1 logo_url stored as HTTPS TEXT string (spec'd as UUID FK to branding_assets — deferred to Phase 1.1)
- [v1.4-C4] §D Test count: 494 → 510

**v1.1 changes**
- [v1.1-C1] §4 Technology stack confirmed (custom router, scrypt, ZeptoMail, R2)
- [v1.1-C2] §4 Express.js removed — custom router only
- [v1.1-C3] §4 Redis deferred — in-memory session store
- [v1.1-C4] §4 WebSocket deferred — polling used
- [v1.1-C5] §5 Phase 6 (Google Drive/OneDrive) deferred/pending
- [v1.1-C6] §11 UI label changes (3 labels renamed)
- [v1.1-A1] §BUILD 18 build phases all complete
- [v1.1-A2] §STACK 32 HTML screens built
- [v1.1-R1] §12 Launchpad removed for non-admin roles

**v1.3-patch changes**
- [v1.3-patch-A1] §BUILD Migrator: --reconcile-only mode, rollback file filtering, ON CONFLICT DO NOTHING fix
- [v1.3-patch-C1] §D Test count: 488 → 494 (9 new migrator unit/integration tests in migrator.test.mjs)

**v1.3 changes**
- [v1.3-A1] §3 New sub-role: organizer_import_staff — can bulk-import attendees
- [v1.3-A2] §3 New user flags: vendor_content_editor, vendor_content_approver
- [v1.3-A3] §4 Pi 5 hardware — NFC tap ingestion for Raspberry Pi 5 + ACR122U
- [v1.3-A4] §4 CI/CD — Docker Compose + GitHub Actions pipeline
- [v1.3-A5] §5.4 Vendor lead item shows pass_type_name + colour
- [v1.3-A6] §5.6 Attendees tab added to organizer event-detail (bulk import, NFC assign)
- [v1.3-A7] §7 11 new tables — pass_types, consent_versions, consent_snapshots, consent_attribute_changes, app_config, nfc_tag_batches, nfc_tag_batch_uids, vendor_profiles, stall_branding, moderation_items, moderation_notes
- [v1.3-A8] §BUILD P2 Phase 0 Moderation Foundation — 9-state workflow, 3 new routes, self-approval guard
- [v1.3-A9] §D 488 tests passing (was 438 in v1.2)
- [v1.3-C1] §2 organizer_release_allowed added as third consent dimension; staff_exempt added to consent_status
- [v1.3-C2] §3 Attendees gain registration_source, pass_type_id, age_confirmed_18_plus
- [v1.3-C3] §5 Kiosk — age gate, disclosure footer, nfc_behaviour per pass type (consent/skip/access_only)
- [v1.3-C4] §7 Total tables: 79 → ~90
- [v1.3-C5] §7 consents table extended: +organizer_release_allowed, +consent_version_id

**v1.2 changes**
- [v1.2-A1] §4 Google Drive/OneDrive integration (Phase 6 complete)
- [v1.2-A2] §4 MFA (email OTP, 10-min expiry)
- [v1.2-A3] §4 Snapshot comparison feature
- [v1.2-A4] §4 Unified UI design system (shared-app.css, IBM Plex Sans, #2D6A9F)
- [v1.2-A5] §7 4 new database tables for Drive storage
- [v1.2-A6] §6 20 new Drive API routes
- [v1.2-A7] §11 AES-256-GCM encryption for OAuth tokens
- [v1.2-A8] §14 Attendee document access page (/docs/:token, no login)
- [v1.2-A9] §14 Demo data: 13 orgs, 18 users, 36 attendees, 60 interactions
- [v1.2-A10] §13 438 tests passing, 0 failing, 24 skipped
- [v1.2-A11] §12 DRIVE_ENCRYPTION_KEY environment variable required
- [v1.2-A12] §12 Google Cloud and Azure AD OAuth app registrations
- [v1.2-C1] §4 Node.js upgraded to v25.8.2
- [v1.2-C2] §7 Total tables expanded from ~75 to 79
- [v1.2-C3] §6 Total API routes expanded to 261+
- [v1.2-C4] §11 All sign-out paths now route to /login (Launchpad fully removed)
- [v1.2-C5] §9 Drive token refresh worker added (runs every 30 min)

---

## 1. Executive Scope and Intent

This platform is an offline-first, kiosk-led, API-first physical-world interaction infrastructure platform.
Its purpose is to capture real-world interactions, convert them into structured and consent-controlled data, activate them through dashboards, CRM, and sponsor reporting, and enforce trust by architecture rather than by assurance.
This document is binding for product, engineering, QA, design, analytics, support, deployment, operations, sales, partner enablement, and governance.

> [v1.2 CLARIFIED §1] The platform now explicitly describes itself as targeting high-throughput events with NFC/QR check-in devices applied to attendee identity management. Core value propositions formalised: real-time NFC/QR tap ingestion, role-based data access, data sovereignty (per-event retention, DSR rights, tenant offboarding), Drive-native document distribution, break-glass access, and full export/reporting with tamper-resistant audit log.

---

## 2. Core Non-Negotiable System Laws

Every tap must be stored locally first.
Every cloud sync must be idempotent by (device_id, local_event_id).
Consent gates all personal-data release.
No bulk attendee database ingestion is allowed as a normal operating mode.
Every query and export must be tenant-scoped and event-scoped.
Sponsors see aggregated analytics by default; raw PII requires sponsor consent and event policy.
Every sensitive action must be auditable.
No AI or third-party enrichment may sit in the critical tap path.
Kiosk interaction must work without internet.
Public leaderboard must never display personal data.

> [v1.3 CHANGED from §2] **Third consent dimension added:** `organizer_release_allowed` is now a first-class consent field alongside `vendor_release_allowed` and `sponsor_release_allowed`. Attendees may separately consent to organizer data access. The `consents` table gains `organizer_release_allowed BOOLEAN DEFAULT FALSE`. A new `staff_exempt` value added to `consent_status` for staff/exhibitor passes that bypass the attendee consent surface entirely.

> [v1.2 ADDED §2, no original ancestor] Laws are now formally identified with IDs LAW-01 through LAW-10 and explicitly marked "confirmed implemented in v1.2 production build." Three new laws added beyond the original ten:
> - LAW-08: OAuth tokens for Drive integrations encrypted at rest with AES-256-GCM
> - LAW-09: Device credentials are hashed; raw tokens never stored
> - LAW-10: MFA (email OTP) is available for all user accounts

---

## 3. Actor Model and Responsibility Boundaries

| Role | Responsibilities |
|---|---|
| Attendee | Can interact, consent, review own connections, revoke consent, request export/delete of own data. |
| Vendor Manager | Can view and act on consented leads in own stall scope only, classify Hot/Warm/Cold, add notes, request export if event policy allows, push to CRM if consent and event policy allow. |
| Sponsor User | Can view sponsor-scoped aggregated metrics and sponsor-consented leads only if sponsor PII is enabled by event policy. |
| Organizer Admin | Controls event setup, event-level data policy, export approvals, event analytics, and fleet oversight within own event scope. |
| Platform Admin | Manages infrastructure and masked operations by default; no unrestricted PII browsing; break-glass required for exceptional privileged access. |
| Ops User | Handles device and deployment operations only; no attendee PII access. |
| Device Principal | May fetch config, send heartbeat, report incidents, upload sync batches, and create tap interactions only. |

> [v1.3 ADDED §3] New sub-role: **organizer_import_staff** — a scoped organizer sub-role that may bulk-import attendees and manage NFC tag assignments. Does not have full organizer admin rights. Added to `user_role_assignments` CHECK constraint in migration 063.
>
> [v1.3 ADDED §3] New user flags on the `users` table: `vendor_content_editor` (may submit content for moderation review) and `vendor_content_approver` (may approve/reject content — editor ≠ approver guard enforced). Backfilled to TRUE for all existing vendor_manager users.
>
> [v1.3 CHANGED from §3] **Attendees** now carry: `registration_source` (nfc_tap / walk_in / bulk_import / self_register / import / api), `pass_type_id` (FK to pass_types), `nfc_batch_id`, and `age_confirmed_18_plus`. Walk-in registration creates an attendee record at the kiosk without a prior database entry.

> [v1.2 ADDED §3] New role added: **public** — Attendee document access page (/docs/:token) — no login required. This is a new actor type introduced for the Drive document access feature.
>
> [v1.2 ADDED §3] **Google Drive Access Control Role**: Vendors can grant access to stall shared folders to specific attendees via a 32-byte hex access token (HMAC-signed). Attendees visit /docs/:token without logging in. The platform validates the token, logs the access, and proxies file listings and viewer URLs from Google Drive or OneDrive.

---

## 4. System Architecture

### 4.1 High-Level Layers

Edge/Kiosk Layer: locked PWA runtime, NFC adapter, local queue, sync engine, branding cache, diagnostics, heartbeat agent, QR fallback.
API Layer: API gateway, auth, tenant resolution, resource resolution, policy enforcement, validation, response masking, audit logging.
Core Services Layer: Event Service, Device Service, Interaction Service, Identity Service, Consent Service, Branding Service, Analytics Service, Integration Service, Notification Service, Realtime Gateway, Agent Orchestrator.
Async Layer: enrichment worker, CRM sync worker, notification worker, sponsor insight and lead-summary workers.
Data Layer: PostgreSQL as source of truth, Redis for cache/pubsub only, object storage for assets/files.
Observability Layer: logs, metrics, alerts, audit trails, dead-letter jobs, incident records.

> [v1.1 CHANGED from §4] **Technology stack confirmed vs. original aspirational choices:**
> - Original spec did not name a specific web framework. v1.1 confirms **no Express.js** — custom router (router.mjs) used throughout for lighter, testable routing.
> - Password hashing: spec assumed bcrypt. v1.1 uses **scrypt** (native Node crypto) — bcrypt unavailable on Railway.
> - Email: spec assumed SMTP. v1.1 uses **ZeptoMail HTTP API** — Railway blocks outbound SMTP port 587.
> - File storage: spec assumed generic object storage. v1.1 uses **Cloudflare R2** (S3-compatible, no egress fees).
> - Realtime: spec assumed Realtime Gateway / WebSocket. v1.1 **defers WebSocket** — polling used throughout. Redis also deferred — in-memory session store functional.
>
> [v1.1 CHANGED from §4] Data Layer note: Redis deferred in v1.1. In-memory store in use. Redis is a pending item.
>
> [v1.3 ADDED §4, no original ancestor] **Raspberry Pi 5 hardware support**: NFC tap ingestion implemented for Raspberry Pi 5 + ACR122U USB NFC reader. Includes codex-tap.sh daemon script, tablet push mode for Pi 5 consent screen, and fleet.html NFC reader status monitoring. Physical deployment package ready.
>
> [v1.3 ADDED §4, no original ancestor] **CI/CD pipeline**: Docker Compose (development + production stacks) and GitHub Actions workflow added. CI builds API, runs full test suite inside container, and blocks merge on failure.

> [v1.2 CHANGED from §4] **Node.js upgraded** to v25.8.2 ESM modules. Original spec did not specify a Node version.
>
> [v1.2 ADDED §4, no original ancestor] **Drive Integration layer added**: Google Drive API (OAuth 2.0 read-only) and Microsoft Graph API (OneDrive) added as external provider integrations. Platform proxies file metadata and viewer URLs; never stores binary file content.

### 4.2 Service Boundaries

| Service | Bounded responsibilities |
|---|---|
| API Gateway | Authentication pass-through, rate limiting, routing, tenant header enforcement |
| Auth Service | OIDC/JWT validation, device auth validation, role mapping, refresh/session handling |
| Event Service | Events, halls, stalls, event data policies, sponsor packages, assignment resolution |
| Device Service | Device registry, assignments, heartbeats, incidents, config responses |
| Interaction Service | Tap ingestion, interaction creation, interaction states, notes, scoring, detail retrieval |
| Identity Service | Attendee and company entities, graph links, profile access |
| Consent Service | Consent capture, revoke, effective consent evaluation, DSR linkage |
| Branding Service | Branding profiles, asset resolution, publish workflow |
| Analytics Service | Impressions, clicks, CTR, heatmaps, leaderboard, event traffic metrics |
| Integration Service | CRM push, webhook routing, wallet generation coordination |
| Notification Service | Email, WhatsApp, SMS, short-link communication |
| Realtime Gateway | Live dashboard channels, leaderboard updates, inbox refresh |
| Agent Orchestrator | Async enrichment, summaries, follow-up drafts, sponsor insights |

> [v1.1 CLARIFIED §4.2] The Notification Service uses ZeptoMail HTTP API rather than SMTP. WhatsApp and SMS are deferred; only email is implemented in v1.1.
>
> [v1.2 ADDED §4.2, no original ancestor] **Drive Token Refresh Worker** added to Async Layer: runs every 30 minutes, refreshes Google/OneDrive OAuth tokens before expiry, marks connection error on failure.

---

## 5. Complete Functional Scope by Screen and Flow

### 5.1 Global UI Rules

Every screen must support loading, empty, and error states.
Every action must provide success or failure feedback.
PII fields must be masked whenever consent and policy do not permit display.
All attendee-facing screens must avoid technical error jargon.
All dashboard screens must reflect scope-limited data only.

> [v1.2 ADDED §5] **Unified design system** applied to all 32 screens: shared-app.css, IBM Plex Sans font throughout, accent color #2D6A9F, light theme. Original spec did not prescribe a design system.

### 5.2 Kiosk Application Screens

| Screen | Authoritative purpose and behavior |
|---|---|
| Boot Screen | Initialize local services, load cached config, attempt device config fetch, verify reader connectivity, show retry if config unavailable. |
| Idle Screen | Default attendee-facing state showing sponsor creative, event logo, tap CTA, QR fallback, local/offline-safe branding. |
| Tap Processing Screen | Immediate feedback after NFC read; generates local_event_id and persists local queue record before any cloud call. |
| Active Interaction Screen | Displays attendee preview or anonymous placeholder plus sponsor panel and optional staff controls. |
| Interaction Exception Screen | Handles unreadable tags, unresolved local preview, duplicate suppression, and safe fallback actions. |
| Diagnostics Screen | Hidden admin-only screen showing device identity, assignment, queue depth, last sync, reader status, logs, force sync, refresh config, restart adapter. |

> [v1.3 CHANGED from §5.2] **Per-pass-type NFC behaviour**: each pass type defines `nfc_behaviour` which controls the kiosk flow on tap:
> - `consent` (default) — show consent screen as normal
> - `skip` — silent staff/exhibitor access, no interaction created
> - `access_only` — log entry without showing consent screen
>
> **Age gate added**: kiosk consent screen includes age confirmation (18+). `age_confirmed_18_plus` recorded on the attendee.
>
> **Disclosure footer**: kiosk consent screen now shows a configurable disclosure footer from `app_config`.

> [v1.1 ADDED §5.2] Kiosk page shows `CONFIG_ERROR` in browser by design — physical device required.

### 5.3 Attendee Mobile Flow

> [v1.4 ADDED §5.3, no original ancestor] **Vendor profile card** inserted in attendee landing screen (screen 1) after the landing-context card. The card is hidden by default; populated by a second API call to `GET /stalls/:stallId/vendor-profile` (public, no auth). If no approved profile exists the card stays hidden and the stall + org name from the session remain as the only context. On approved profile: shows company name, tagline, description, and social link chips. Fails silently — the card is supplementary and its failure must never affect consent or vault flows.

| Screen | Required behavior |
|---|---|
| Landing Page | Shows event and vendor context, confirms contact exchange, presents save/contact actions. |
| Consent Page | Captures separate vendor-share and sponsor-outreach choices; no pre-ticked options; records timestamp, locale, IP, user agent. |
| Contact Vault | Lists attendee's own connections, brochures, notes, and privacy controls. |
| Contact Detail | Shows own stored connection detail and provides revoke/export/delete actions. |
| Privacy/Unsubscribe | Allows per-vendor revoke, sponsor opt-out, export request, delete request. |

### 5.4 Vendor Dashboard

| Screen | Required behavior |
|---|---|
| Lead Inbox | Chronological, paginated, filterable list with timestamp, attendee, company, title, score, consent status, next action, CRM state. Anonymous masking required when no vendor consent. |
| Lead Detail | Profile, company, enrichment evidence, interaction history, notes, follow-up timeline; hide PII if consent unavailable. |
| Scoring and Notes | Inline Hot/Warm/Cold scoring and note capture. |
| CRM Settings | Connection to Salesforce/HubSpot/Zoho, field mapping, test push, sync rules. |
| Export | Consent-filtered export request only; approval workflow respected. |

> [v1.3 ADDED §5.4, no original ancestor] **Vendor lead item** now shows `pass_type_name` and `colour_hex` from the attendee's pass type.
>
> [v1.4-patch CLARIFIED §5.4] Tab navigation bar in vendor.html restyled to match the organizer dashboard's tab pattern; redundant subtitle text below the Profile tab label removed. Same tabs, same routes, same functionality — visual consistency fix only.
>
> [v1.4-fix CLARIFIED §5.4] **Industry field restored** — the v1.4 spec listed `industry` in the vendor profile field set but it was silently dropped during execution. v1.4-fix restores it: optional free-text, max 80 chars (the spec said "no taxonomy" — Open Item OI-VP-02 stays open). Implemented in backend validation (routes.mjs), vendor.html editor form, and attendee.html profile card. No schema or migration changes — field lives in `moderation_items.payload.industry`.

> [v1.4 ADDED §5.4, no original ancestor] **Vendor Profile tab** added to vendor.html. Vendors can now author their public profile:
> - Company name (required), tagline (max 200), description (**max 2000** [v1.4-fix3; was 5000], HTML stripped), logo URL (HTTPS), website URL (HTTPS), industry
> - Up to 8 social links (channels: linkedin, youtube, instagram, facebook, x, whatsapp, generic_1, generic_2); each requires HTTPS URL
> - Save draft / Submit for review workflow feeds the Phase 0 moderation engine
> - Pending badge shows current moderation state; published profile loaded on tab open Allows vendor to immediately identify attendee category (e.g. VIP, Exhibitor, General) in the lead inbox.

> [v1.4-fix3 CHANGED from §5.4] Description field max length corrected from 5000 to **2000** chars. The UI helper text already said "Description (2000 chars max)"; the backend was silently accepting descriptions longer than 2000 chars without error. v1.4-fix3 aligns the backend to the UI: >2000 → 422 "Description must be 2000 characters or fewer". Smoke test A4 updated. 2 new unit tests: exact 2000 chars → 200, 2001 chars → 422.

> [v1.4-fix4 CLARIFIED §5.4] **Refresh button** in the vendor.html status panel: now shows a disabled/loading state (button disabled + '↻ …' label) during the status fetch, and fires a 'Status refreshed.' toast on success. Tab-switch calls to `loadProfile` pass `silent:true` to suppress the toast during navigation. Functionality unchanged — this is a UX polish only.
>
> [v1.4-fix4 CLARIFIED §5.4] **Mobile header responsive fix**: `@media(max-width:480px)` rules added to vendor.html — `.shell-bar`, `.shell-nav`, `.tab-bar`, and `#tab-profile` reflow to prevent header element overlap at 375px viewport (e.g. iPhone SE). Desktop layout unchanged.
>
> [v1.4-fix4b CHANGED from §5.4] **Mobile header shell-nav follow-up**: `.shell-nav` (top-right action group — Vendor / My Account / Sign out) was not given `width:100%` in the `@media(max-width:480px)` block, causing the group to overflow the right edge of the shell bar at 375px. Added `width:100%` to `.shell-nav` inside that breakpoint. 1-line CSS change; desktop unchanged.

> [v1.5 ADDED §5.4, no original ancestor] **Review tab** added to vendor.html for `vendor_content_approver` users. Injected dynamically after `/auth/me` returns `vendor_content_approver: true` — non-approver users never see the tab. Shows the moderation queue for the vendor org. Each item shows company name, current state, and submission time. Approver actions: Claim (draft/submitted → under_review), Approve (under_review → approved), Request Changes (under_review → changes_requested; note required), Reject (under_review → rejected; note required), Release (under_review → submitted — sends back to queue without rejection). Discussion thread shows all moderation notes with actor display names. All server-provided values escaped before HTML insertion; single-operator confirm modal built with DOM methods (no inline event handlers with server data).
>
> [v1.5 CHANGED from §5.4] **Profile tab form-lock (M4 fix)**: the profile form and social-links editor are now locked (read-only) when the moderation item is in `submitted` or `under_review` state. A status-bar message explains the lock and offers a Withdraw button. Previously (v1.4-fix4 / VP-22) saving would silently auto-transition the item back to draft — this was a latent bug. Phase 1.5 closes it: `PATCH /vendors/:vendorOrgId/profile` and `PUT /vendors/:vendorOrgId/social-links` now return 422 "Profile is under review — withdraw before editing" instead of performing the auto-draft. VP-22 test inverted.

> [v1.2 ADDED §5.4, no original ancestor] **Vendor Drive screen added**: connect Google Drive or OneDrive, manage shared folders, issue/revoke attendee access grants. Auto-grant document access on attendee NFC tap.

### 5.5 Sponsor Dashboard

| Screen | Required behavior |
|---|---|
| Overview | Total impressions, total clicks, CTR, opted-in leads, top hour, top zone. |
| Heatmap | Hall plan, hot zones, filters by time/category/cluster, no raw PII. |
| Campaign Performance | Funnel from impression → mobile view → click → consent → exportable lead. |
| Audience Insights | Industry, seniority, geo, company size, intent theme in aggregate. |
| Lead Export | Only sponsor-consented leads and only if event_data_policies.sponsor_pii_enabled = true. |

### 5.6 Organizer Dashboard

| Screen | Required behavior |
|---|---|
| Event Overview | Total interactions, active devices, top stalls, queue depth, sync latency. |
| Fleet Page | Per-device status, hall, stall, battery, signal, queue depth, last heartbeat, app version, incident state. |
| Traffic Analytics | Taps by hour, visitor velocity, booth traffic map, top stalls. |
| Data Control | vendor_exports_enabled, sponsor_pii_enabled, require_export_approval, allow_crm_push, retention_days, allow_cross_event_identity_graph. |
| Export Approval | Pending/approved/rejected export requests and approval actions. |
| Audit Log | Sensitive actions, actor, action, target, timestamp. |

> [v1.3 ADDED §5.6, no original ancestor] **Attendees tab** added to organizer event-detail UI. Allows organizers and import staff to:
> - View full attendee roster with pass type, registration source, and NFC assignment status
> - Bulk import attendees via CSV upload (organizer_import_staff role)
> - Assign NFC tag UIDs to attendees from pre-registered batch
> - Register walk-in attendees at the door
> - Search and filter by pass type, registration source, NFC status

> [v1.1 CHANGED from §5.6] **UI label changes in v1.1:**
> - "IAM Audit" → "Access Change History"
> - "Security Hardening" → retains name but adds warning banner
> - "Access Control" → adds enable/disable toggle

---

## 6. Backend Architecture, APIs, and Middleware

### 6.1 Request Lifecycle Order

1. requestIdMiddleware
2. transportSecurityCheckMiddleware
3. authMiddleware
4. tenantResolutionMiddleware
5. resourceResolutionMiddleware
6. roleScopeMiddleware
7. policyEngineMiddleware
8. validationMiddleware
9. endpoint handler
10. responseMaskingMiddleware
11. auditMiddleware
12. metricsMiddleware

### 6.2 Trust Enforcement Policies

- Tenant isolation: no cross-tenant read or write.
- Event scope restriction: all event-scoped actors limited to their assigned event(s) and stall(s).
- Consent gating: vendor PII requires vendor_release_allowed = true; sponsor PII requires sponsor_release_allowed = true and sponsor_pii_enabled = true.
- Event policy override: event_data_policies can further block export, CRM push, sponsor PII, and cross-event graph access.
- No bulk attendee ingestion or export: there is no raw event attendee export endpoint.
- Internal restriction: ops users never receive attendee PII; platform admins default to masked access; break-glass required for exceptional access.
- Async boundary: enrichment and AI helpers must never delay /interactions/tap.

### 6.3 Core API Surface (v1.0 — original)

| Endpoint | Binding behavior |
|---|---|
| POST /device/heartbeat | Device sends battery, signal, reader status, app version, local_queue_depth, timestamp every 60 seconds. |
| GET /device/config | Returns active event assignment, stall assignment, branding profile and feature flags. |
| POST /device/sync | Uploads queued local tap events in chronological order; partial success allowed; duplicates resolve as success. |
| POST /device/incident | Logs reader/app/power/network incidents. |
| POST /interactions/tap | Creates tap_event and interaction from a device-originated tap without waiting on enrichment. |
| GET /interactions/{id} | Scope-limited interaction detail with masking obligations applied. |
| POST /interactions/{id}/classify | Sets Hot/Warm/Cold lead score. |
| POST /interactions/{id}/note | Creates interaction note. |
| GET /stalls/{id}/leads | Consent-filtered lead inbox for vendor or organizer. |
| POST /consents/capture | Creates or updates effective consent state and consent event history. |
| POST /consents/revoke | Revokes vendor and/or sponsor release rights prospectively. |
| GET /events/{id}/branding | Returns branding profile for kiosks and event-scoped UIs. |
| POST /branding/publish | Publishes updated branding to fleet. |
| GET /sponsors/{id}/metrics | Sponsor-scoped overview metrics, never raw PII by default. |
| GET /events/{id}/heatmap | Aggregated event heatmap data. |
| GET /events/{id}/leaderboard | Leaderboard dataset with no personal data. |
| POST /integrations/crm/push | Queues CRM push only if consent and event policy allow. |
| POST /exports/request | Creates export request for approval/generation workflow. |
| POST /exports/{id}/approve | Organizer approves pending export. |
| GET /exports/{id}/download | Serves signed expiring export file URL when completed. |

> [v1.1 CHANGED from §6.3] **Route paths confirmed in implementation** differ slightly from spec. Implemented paths include /auth/login, /auth/logout, /devices/register, /devices/auth, /devices/:id/heartbeat, /devices/:id/config, /devices/:id/incidents, /iot/runs. Rate limiting added: auth (20/window), public (20), sensitive (30), admin (15).
>
> [v1.2 ADDED §6.3, no original ancestor] **20 new Drive API routes** added for Phase 6:
>
> | Method | Path | Description |
> |---|---|---|
> | GET | /stalls/:stallId/drive/connect/google | Initiate Google Drive OAuth |
> | GET | /stalls/:stallId/drive/connect/onedrive | Initiate OneDrive OAuth |
> | GET | /auth/drive/google/callback | Handle Google OAuth callback |
> | GET | /auth/drive/onedrive/callback | Handle OneDrive OAuth callback |
> | GET | /stalls/:stallId/drive/connection | Get drive connection status |
> | DELETE | /stalls/:stallId/drive/disconnect | Revoke drive connection |
> | GET | /stalls/:stallId/drive/folders | List Drive root folders |
> | GET | /stalls/:stallId/drive/shared-folders | List configured shared folders |
> | POST | /stalls/:stallId/drive/shared-folders | Add shared folder |
> | PATCH | /stalls/:stallId/drive/shared-folders/:folderId | Update shared folder |
> | DELETE | /stalls/:stallId/drive/shared-folders/:folderId | Remove shared folder |
> | GET | /stalls/:stallId/drive/access-grants | List access grants |
> | POST | /stalls/:stallId/drive/access-grants | Create access grant |
> | POST | /stalls/:stallId/drive/access-grants/:grantId/revoke | Revoke grant |
> | POST | /stalls/:stallId/drive/access-grants/:grantId/suspend | Suspend grant |
> | POST | /stalls/:stallId/drive/access-grants/:grantId/restore | Restore grant |
> | GET | /docs/:accessToken/folders | List folders (no login; token-auth) |
> | GET | /docs/:accessToken/folders/:folderId/files | List files in folder |
> | GET | /docs/:accessToken/folders/:folderId/files/:fileId/view | Get viewer URL |
> | GET | /docs/:accessToken/folders/:folderId/files/:fileId/download | Get download URL |
>
> [v1.2 ADDED §6.3] **MFA routes added:**
> - POST /auth/send-otp — sends 6-digit OTP via email (10-min expiry)
> - POST /auth/verify-otp — verifies OTP; returns JWT if valid
>
> [v1.2 CHANGED from §6.3] **Total API routes: 261+** (original spec did not number routes).
>
> [v1.3 CHANGED from §6.3] **Total API routes: 265** (261 from v1.2 + 3 moderation routes + 1 bulk-import route).
>
> [v1.4 ADDED §6.3, no original ancestor] **5 new Vendor Profile routes + 1 approval extension** (Phase 1):
>
> | Method | Path | Auth | Description |
> |---|---|---|---|
> | GET | /vendors/:vendorOrgId/profile | vendor_manager | Editor view: published + pending moderation item |
> | PATCH | /vendors/:vendorOrgId/profile | vendor_manager | Create or update vendor profile draft; `submit:true` transitions to submitted |
> | GET | /vendors/:vendorOrgId/social-links | vendor_manager | Published social links from `vendor_profile_social_links` table |
> | PUT | /vendors/:vendorOrgId/social-links | vendor_manager | Bulk-replace social links in current draft (or create new draft) |
> | GET | /stalls/:stallId/vendor-profile | public (no auth) | Attendee-facing: approved vendor profile or fallback |
>
> `POST /moderation-items/:itemId/transition` extended (D6): on `approved` + `entity_type = vendor_profiles`, atomically swaps `vendor_profiles.currently_published_item_id` pointer and bulk-replaces `vendor_profile_social_links`.
>
> [v1.4 CHANGED from §6.3] **Total API routes: 270** (265 + 5 new vendor profile routes).
>
> [v1.4-fix2 CHANGED from §6.3] **PATCH /vendors/:vendorOrgId/profile?submit=true behaviour corrected**: the submit path previously built the moderation_notes record inline without computing `new_status` or `prior_status`, causing a NOT NULL constraint violation (500) in production. A `recordModerationTransition()` helper is now extracted and shared by both the submit path and the `/moderation-items/:itemId/transition` endpoint. The helper reads `prior_status` from the current item state and derives `new_status` from the TRANSITIONS state machine. No API contract change — same request/response shape.
>
> [v1.4-fix4 CHANGED from §6.3] **PATCH /vendors/:vendorOrgId/profile save-draft corrected (moderation integrity)**: when the existing moderation item is already in `submitted` or `under_review` state, a save-draft call now auto-transitions the item back to `draft` (via `recordModerationTransition(action='withdraw_to_draft')`) before applying the new payload. Previously the payload was silently overwritten with no state transition and no moderation_notes audit record, leaving the item's status inconsistent with its content. No API contract change — same request/response shape. Test VP-22 added.
>
> [v1.5 CHANGED from §6.3] **PATCH /vendors/:vendorOrgId/profile — M4 edit-lock (VP-22 inverted)**: the Phase 1.5 review workflow requires items to stay in `submitted`/`under_review` while under review. The v1.4-fix4 auto-draft was a latent bug. Phase 1.5 replaces it with a hard 422 "Profile is under review — withdraw before editing". To edit, the vendor must use the Withdraw action first (submitted → draft via the transition endpoint). VP-22 test inverted to assert 422 + unchanged state.
>
> [v1.5 CHANGED from §6.3] **PUT /vendors/:vendorOrgId/social-links — same 422 edit-lock**: social-link saves share the same moderation item as the profile PATCH (`entity_type="vendor_profiles"`). The 422 lock applies here too — social links cannot be saved when the item is submitted or under review.
>
> [v1.5 CHANGED from §6.3] **MODERATION_TRANSITIONS — Release action added**: `under_review` allowed-targets now includes `"submitted"`. This enables the Release action (approver sends item back to the queue without rejection). Requires `canReleaseModeration(principal)` to pass — i.e., `vendor_content_approver: true`.
>
> [v1.5 CHANGED from §6.3] **Transition handler enhancements** (POST /moderation-items/:itemId/transition):
> - Optimistic-concurrency guard: if `expected_updated_at` is provided and differs from the stored `item.updated_at`, returns 409 Conflict. Prevents stale overwrites when two approvers act concurrently. Note: claim (under_review) is advisory in v1.5 — hard reviewer lock deferred to v2.
> - Single-operator self-approve: if the approver is also the editor and is the sole approver-capable user in the org (checked via `countApproverCapableInOrg <= 1`), a two-call confirm protocol is supported. First call without `confirm_single_operator` returns 403 `{ error: "self_approval_blocked", details: { single_operator: true } }`; second call with `confirm_single_operator: true` re-checks and, if still true, allows approval + records `self_approved_single_operator` audit note + system note. Multi-approver orgs always get plain 403.
> - Notification fan-out: on `submitted` → email all org approvers (actor suppressed); on `approved` → email editor; on `changes_requested`/`rejected` → email editor. Errors are caught and logged without failing the transition.
> - Audit metadata now includes `action` name alongside from/to states.
>
> [v1.5 CHANGED from §6.3] **GET /auth/me principal**: now includes `vendor_content_editor` and `vendor_content_approver` boolean flags. Frontend uses these to gate the Review tab injection and action-bar rendering.
>
> [v1.5 CHANGED from §6.3] **GET /moderation-items/:itemId/history**: each note now includes `actor_display_name` (resolved via `users.findByIdGlobal`). Null if user not found.
>
> [v1.5 ADDED §6.3, no original ancestor] **3 new notification templates** added to `notification-templates.mjs`:
>
> | Template key | Trigger | Recipient |
> |---|---|---|
> | `vendor_profile_submitted` | Item transitions to `submitted` | All `vendor_content_approver` users in org (actor excluded) |
> | `vendor_profile_approved` | Item transitions to `approved` | Item's `editor_user_id` |
> | `vendor_profile_needs_changes` | Item transitions to `changes_requested` or `rejected` | Item's `editor_user_id` |

---

## 7. Data Model and Persistence Contract

### 7.1 Core Tables (v1.0)

| Table/domain | Purpose |
|---|---|
| tenants | Top-level isolation boundary for all data |
| organizations | Organizer, sponsor, vendor, or internal organization |
| users / roles / user_role_assignments | Human users and role model |
| events / halls / stalls | Event topology |
| devices / nfc_readers / device_assignments / device_heartbeats / device_incidents | Fleet inventory, health, and assignment |
| attendees / attendee_profiles / companies / person_company_links | Identity and profile entities |
| tap_events | Raw deduplicated cloud-ingested tap record; unique by (device_id, local_event_id) |
| interactions | Business interaction lifecycle record |
| interaction_notes | User-authored notes |
| consents / consent_events | Effective consent state and immutable consent history |
| enrichment_requests / enrichment_results | Async enrichment pipeline |
| sponsor_packages / branding_profiles | Commercial sponsorship and branding |
| banner_impressions / banner_clicks / brochure_views | Analytics events |
| crm_connections / crm_sync_jobs | Integration state and CRM pushes |
| audit_logs | Sensitive action audit trail |

> [v1.1 CHANGED from §7.1] **Total tables in v1.1: ~75.** Implementation adds tables beyond the original spec: api_clients, device_credentials, stalls, sponsor_packages, event_data_policies, attendee_profiles, tap_events, consents, consent_events, interaction_notes, lead_scores, leaderboard_snapshots, short_links, devices, device_assignments, device_heartbeats, device_incidents, iot_integration_runs, iot_sync_checkpoints, notifications, notification_attempts, notification_receipts, followup_messages, audit_log, privacy_audit_log, pentest_findings, final_launch_approvals, commercial_approvals, pilot_signoff_approvals, pilot_dry_run_records, compliance_runs, schema_migrations, export_requests, export_worker_queue, data_subject_requests, break_glass_access, tenant_offboarding_jobs, report_snapshots, event_report_snapshots, downstream_deletion_records, crm_connections, crm_sync_jobs, crm_sync_records, commercial_partners, commercial_deals, communication_channel_consents, communication_suppressions, wallet_passes, webhook_subscriptions, webhook_event_types, webhook_deliveries, branding_assets.
>
> [v1.3 ADDED §7.1] **11 new tables** added across migrations 057–068 (new in v1.3, no original ancestor):
>
> | Table | Purpose |
> |---|---|
> | pass_types | Attendee pass categories; controls nfc_behaviour (consent/skip/access_only), vendor visibility, colour |
> | consent_versions | Versioned consent form definitions; tracks retention period, grievance officer, data residency zones |
> | consent_snapshots | Immutable snapshot of consent state at capture time, linked to consent_version_id |
> | consent_attribute_changes | Audit log for individual consent field changes (who, when, old→new) |
> | app_config | Singleton per tenant; deployment region, data controller, grievance officer, retention defaults |
> | nfc_tag_batches | Physical NFC tag batch management; links batch to pass_type; tracks quantity issued |
> | nfc_tag_batch_uids | Individual NFC tag UIDs within a batch; pre_registered/active/returned status; assigned_to_attendee_id |
> | vendor_profiles | Shell table for vendor org identity (Phase 0 — content fields added in Phase 1); points to currently_published_item_id |
> | stall_branding | Shell table for stall-level branding overrides (Phase 0); points to currently_published_item_id |
> | moderation_items | JSONB payload store for each proposed change to vendor_profiles or stall_branding; 9-state machine |
> | moderation_notes | Immutable audit trail for moderation transitions (AP-5 trigger blocks UPDATE/DELETE) |
>
> **Additional columns on existing tables (v1.3):**
> - `users`: +vendor_content_editor, +vendor_content_approver
> - `consents`: +organizer_release_allowed, +consent_version_id
> - `attendees`: +pass_type_id, +registration_source, +nfc_batch_id, +age_confirmed_18_plus
> - `moderation_status` ENUM: draft / submitted / under_review / changes_requested / approved / rejected / withdrawn / superseded / discarded
>
> [v1.3 CHANGED from §7.1] **Total tables: ~90** (v1.2 had 79).
>
> [v1.4 ADDED §7.1] **1 new table** added in migration 070:
>
> | Table | Purpose |
> |---|---|
> | vendor_profile_social_links | Published social links for approved vendor profile; channels: linkedin, youtube, instagram, facebook, x, whatsapp, generic_1, generic_2; bulk-replaced on approval; RLS enabled |
>
> **Unique index added to vendor_profiles:** `(tenant_id, organization_id)` — prevents duplicate shells on concurrent first-save.
>
> [v1.4 CHANGED from §7.1] **Total tables: ~91** (v1.3 had ~90).
>
> [v1.4 CHANGED from §7.1] **logo_url field in vendor_profiles payload**: stored as HTTPS TEXT string (the original spec referenced `logo_asset_id UUID FK to branding_assets`). The `branding_assets` table is event-scoped with a TEXT PK — not usable as a vendor asset store. File upload and R2 scanning deferred to Phase 1.1. Validation: must start with `https://` if provided.

> [v1.2 ADDED §7.1] **4 new tables** for Drive storage (new in v1.2, no original ancestor):
>
> | Table | Purpose |
> |---|---|
> | stall_drive_connections | One connection per stall; provider, folder, encrypted tokens, status |
> | stall_shared_folders | Folders shared from a connection; multiple per connection |
> | stall_folder_access | Access grants linking attendees to shared folders; 32-byte token |
> | stall_folder_access_log | Immutable log of every document access event |
>
> [v1.2 CHANGED from §7.1] **Total tables: 79** (v1.1 had ~75).

### 7.2 Clause 20 Additions — Fully In Scope

| Addition | Authoritative scope |
|---|---|
| event_data_policies | Event-level data governance switches; mandatory |
| export_requests | Approval and generation lifecycle for exports; mandatory |
| break_glass_access | Privileged emergency access tracking; mandatory |
| tap_events.created_at | Cloud insert timestamp for sync latency; mandatory |
| leaderboard_snapshots | Historical leaderboard state; required when history/reporting needed |
| notifications | Logical outbound messages; required for full notification stack |
| notification_attempts | Provider-level send attempts; required for full notification stack |
| short_links | Signed/expiring tokenized links; required for attendee sessions/exports/wallet |
| wallet_passes | Wallet artifact tracking; required if wallet output is supported |
| data_subject_requests | Persisted export/delete privacy workflow; required if DSR workflow is supported |
| branding_assets | Versioned remote asset registry; required for managed branding publish |
| webhook_subscriptions | Outbound webhook registrations; required if webhooks are supported |
| webhook_deliveries | Webhook delivery history; required if webhooks are supported |
| interactions.captured_by_user_id | Strongly recommended for staff-specific performance |
| tap_events.cloud_received_at | Strongly recommended explicit receipt timestamp |
| followup_messages | Strongly recommended for detailed outbound response analytics |

### 7.3 Event Data Policies — Exact Fields

| Field | Meaning |
|---|---|
| vendor_exports_enabled | Boolean; if false, vendors cannot export even with consent |
| sponsor_pii_enabled | Boolean; if false, sponsors never receive raw PII |
| require_export_approval | Boolean; if true, export_requests begin in pending state |
| allow_crm_push | Boolean; if false, CRM push blocked for event |
| retention_days | Enum-constrained integer: 30, 60, 90, 180, 365 only |
| allow_cross_event_identity_graph | Boolean; if false, no cross-event graph output |

---

## 8. Authoritative Dashboard Metrics and Calculations

### 8.1 Sponsor Metrics

| Metric | Fixed formula |
|---|---|
| Total Impressions | COUNT(banner_impressions) for sponsor_package_id in selected time range |
| Total Clicks | COUNT(banner_clicks) for sponsor_package_id in selected time range |
| CTR | total_clicks / total_impressions; if impressions = 0 then CTR = 0 |
| Opted-in Leads | COUNT DISTINCT interactions where sponsor_release_allowed = true |
| Top Hall Zone | Highest zone_score where zone_score = impressions_in_zone + clicks_in_zone * 3 |
| Hourly Trend | Time-bucketed impressions and clicks by truncated hour |
| Lead Funnel | impression → mobile view → click → consent → exportable lead |

### 8.2 Organizer Metrics

| Metric | Fixed formula |
|---|---|
| Online Devices | Latest heartbeat within last 2 minutes |
| Offline Devices | Assigned devices with no heartbeat inside 2 minutes |
| Low Battery Devices | Latest heartbeat battery_percent < 20 |
| Average Queue Depth | Average latest local_queue_depth across active devices |
| Average Sync Latency | AVG(cloud_received_at or tap_events.created_at − tap_events.occurred_at) |
| Visitor Velocity | count(interactions in bucket) / bucket_duration |
| Top Stalls | Rank by interactions, tie-break by hot leads, then unique attendees |
| Fleet Health | Online/Warning/Critical by heartbeat, battery, queue depth, incidents |

### 8.3 Vendor Metrics

| Metric | Fixed formula |
|---|---|
| Total Taps | COUNT interactions in stall scope and selected period |
| Unique Leads | COUNT DISTINCT attendee_id where attendee_id IS NOT NULL |
| Hot Leads | COUNT interactions where lead_score = 'hot' |
| Enriched Leads | COUNT DISTINCT interactions with at least one enrichment_result |
| CRM Pushed | COUNT DISTINCT interactions with crm_sync_jobs.status = 'succeeded' |
| Response Rate | (distinct CRM pushed or followup sent) / distinct vendor-consented leads; if denominator = 0 then 0 |
| Qualification Breakdown | Counts by hot, warm, cold, unscored |
| Hot Lead Capture Ratio | hot_leads / total_interactions |

> [v1.2 ADDED §8, no original ancestor] **Snapshot comparison metric**: multi-select snapshots, side-by-side bar chart data, CSV export. Added as new reporting feature.

---

## 9. Device Runtime and Offline-First Contract

### 9.1 Approved Runtime States

BOOTING, CONFIG_LOADING, CONFIG_ERROR, READER_ERROR, IDLE, OFFLINE_IDLE, TAP_READING, INTERACTION_ACTIVE, INTERACTION_EXCEPTION, SYNCING_BACKGROUND, DIAGNOSTICS, LOCKED_UNASSIGNED

### 9.2 Runtime Rules

- A tap is not valid unless durably written to local queue first.
- The queue must preserve chronological order by queue_sequence_number.
- Sync runs every 30 seconds in normal mode and uses exponential backoff after retryable failures.
- Maximum sync batch size is 100 items.
- Reader debounce window is 2 seconds.
- Active interaction screen auto-resets after 15 seconds, extendable to 20 seconds while staff action continues.
- Heartbeat frequency is 60 seconds.
- Warning thresholds: 2 missed heartbeats, battery < 20%, queue depth > 100.
- Critical thresholds: 5 missed heartbeats, battery < 10%, reader disconnected, local queue write failure, queue depth > 500.
- Reboot recovery must restore cached config and queued unsynced records automatically.

> [v1.2 ADDED §9, no original ancestor] **Drive token refresh worker**: runs every 30 minutes. For each active connection with token_expiry within 10 minutes, calls the provider refresh endpoint and updates access_token and token_expiry. On failure, connection status set to "error" and vendor notified.

### 9.3 Failure Matrix

| Failure scenario | Required behavior |
|---|---|
| No internet before tap | Continue in OFFLINE_IDLE; capture locally; sync later |
| No internet during sync | Partial success allowed; remaining items stay retryable |
| Reader disconnected while idle | Move to READER_ERROR; keep QR visible if config valid |
| Reader disconnected during tap | If local write succeeded, continue; else fallback to exception/QR |
| Local storage write failure | Do not claim success; show failure; log critical error |
| Duplicate replay from sync | Treat backend duplicate-existing as success |
| Enrichment failure | Leave interaction valid with basic profile only |
| CRM provider down | Does not affect tap flow; CRM job fails/retries in cloud |
| App crash | Auto-restart; restore queue and config |
| Power loss | After reboot, restore queue and config; no silent loss of queued records |

---

## 10. Trust Architecture and Enforcement

Organizer-owned event policy determines export, sponsor PII, CRM push, retention, and graph permissions.
No bulk attendee database ingestion is permitted.
Every sensitive action is audited: consent, export, approval, CRM push, policy change, break-glass.
Sponsors are aggregate-first and consent-limited.
Platform admin access is masked by default and requires break-glass for exceptional PII access.
Exports are request-driven, policy-checked, consent-filtered, approval-aware, and signed for expiry.
Event trust controls are visible in organizer UI, not hidden in backend only.

### 10.1 Response Masking Rules

| Actor case | Required masking |
|---|---|
| Vendor without vendor consent | display_name = Anonymous Visitor; company/title/email/phone null; export disabled; CRM push disabled |
| Sponsor default | only aggregate metrics and counts; no raw attendee PII |
| Organizer | event-scoped visibility; downstream sharing still governed by policy |
| Platform admin | masked by default; unmasked only during approved break-glass session |

> [v1.2 CHANGED from §10] **Break-glass access**: dual approval required; auto-expires 4 hours after approval; full audit trail. Audit log is tamper-resistant: REVOKE UPDATE DELETE on audit_logs.

---

## 11. Operations, Deployment, and Support

### 11.1 Approval Gates

| Gate | Required approvers |
|---|---|
| Design Freeze | Founder/Product Owner + System Architect + Engineering Lead |
| Build Complete | Engineering Lead + QA/Validation Owner + System Architect |
| Event Configuration Complete | Organizer Success Owner + Ops Lead + Implementation Owner |
| Go-Live Approval | Field Ops Lead + Organizer Representative + Internal Command Owner |
| Event Close | Organizer Representative + Ops Lead + Account Owner |

### 11.2 Event Deployment Checklist

- Create event, halls, stalls, sponsor packages, organizer users, and event_data_policies.
- Plan devices, spares, chargers, readers, network fallback, and dispatch manifest.
- Approve branding inputs: logos, CTAs, URLs, idle/active messages.
- Load assignments and preload branding cache on every device.
- At venue, verify power, kiosk mode, assignment, 10 rapid NFC taps, QR scan, offline capture, reconnect sync, sponsor branding, and heartbeat visibility.
- Do not go live until all checks pass.

### 11.3 Incident Severity Model

| Severity | Definition |
|---|---|
| P0 | Event-blocking or trust-breaking: taps not captured, data leakage, wrong-stall data, export bypass, cross-tenant leakage |
| P1 | Major degradation: one or more key devices down, queue growth critical, sponsor metrics broken, CRM broken event-wide |
| P2 | Moderate issue: slow dashboard, single kiosk restart needed, non-critical metric mismatch |
| P3 | Minor issue: cosmetic or low-impact behavior |

> [v1.1 REMOVED from §11] **Launchpad page removed** for non-admin roles. All sign-out paths → /login. Vendor, sponsor, ops, and attendee roles no longer route through a launchpad.
>
> [v1.2 CHANGED from §11] **UI label changes confirmed in v1.1, still current in v1.2:**
> - Old: "IAM Audit" → New: "Access Change History"
> - "Security Hardening" retains name + warning banner added
> - "Access Control" adds enable/disable toggle

---

## 12. Commercial, Sales, and Partner Operating Model

Commercial positioning must always be exhibitor ROI + sponsor revenue + measurable engagement, not NFC novelty or AI novelty.
Primary target event classes: B2B expos in real estate, education, pharma/medical, industrial/manufacturing, franchise/business segments with 50–200 stalls and sponsor dependency.
Offer structures: Organizer-paid, Sponsor-funded, Mixed monetization.
Sales pipeline stages are fixed: Lead Added → Contacted → Replied → Call Scheduled → Demo Done → Proposal Sent → Negotiation → Closed Won / Closed Lost.
Every CRM record must always include stage, next action, and next action date.
Partner types: Referrer, Channel Partner, Delivery Ecosystem Partner.
Partner payouts must be tracked, approved, and paid after client payment receipt.

### 12.1 Standard Daily Sales Minimums

| Daily metric | Minimum |
|---|---|
| New leads added | 20 |
| Outreach touches / connections | 20 |
| Follow-ups | 10+ |
| Qualification calls | 2 target |
| Demos | 1 target |

---

## 13. Build Phases

> [v1.1 ADDED §13, no original ancestor] **18 build phases** — all complete as of v1.1:

| Phase | Name | Status in v1.1 | Status in v1.2 | Status in v1.3 |
|---|---|---|---|---|
| 1 | Database Migrations | Done | Done | Done (069 migrations) |
| 2 | Authentication & JWT | Done | Done | Done |
| 3 | Role-Based Access Control | Done | Done | Done (+import_staff role) |
| 4 | Organizer Module | Done | Done | Done (+Attendees tab) |
| 5 | Vendor Module | Done | Done | Done (+pass type visibility) |
| 6 | Google Drive / OneDrive Storage | **Pending in v1.1** | **Done in v1.2** | Done (fixes) |
| 7 | Sponsor Module | Done | Done | Done |
| 8 | Attendee Module & Privacy | Done | Done | Done (+consent versioning, walk-in, bulk import) |
| 9 | Ops / Fleet Module | Done | Done | Done (+Pi 5 NFC) |
| 10 | Kiosk Check-in | Done | Done | Done (+age gate, pass nfc_behaviour) |
| 11 | Analytics & Reporting | Done | Done | Done |
| 12 | MFA Two-Step Verification | Done | Done | Done |
| 13 | Snapshot Comparison | Done | Done | Done |
| 14 | Data Population (seed) | Done | Done | Done (+pass types seed) |
| 15 | Vendor Export & Stall Metrics | Done | Done | Done |
| 16 | Security Hardening | Done | Done | Done (+CI/CD) |
| 17 | Access Control Matrix | Done | Done | Done (+moderation routes) |
| 18 | Browser Testing — All 6 Roles | Done | Done | Done |
| P2-0 | Moderation Foundation | — | — | **Done in v1.3** |
| P2-1 | Vendor Profile Core (CR-VP-01) | — | — | **Done in v1.4** |
| P2-1.5 | Approver Moderation Queue UI | — | — | **Done in v1.5** |

> [v1.4-qa ADDED §13, no original ancestor] **Phase 1 QA automation** (26 May 2026): `apps/api/scripts/qa/phase1_backend_smoke_v1_0.sh` (816 lines) is a reusable, idempotent backend smoke test script that replaces manual checklist items 1–28 for P2 Phase 1. Covers all checklist items (1.1–1.8) and 10 extra validation cases: cross-org isolation (403), invalid logo_url formats → 422, description >5000 chars → 422, industry >80 chars → 422, invalid social link channel → 422, HTML stripping, UUID id format regression, industry field persistence regression, self-approval guard (403), reject-with/without-note flows. Script features: cleanup/reset before each run (idempotent), [WRITE] labels on all mutations, --dry-run flag, exit codes 0/1/2, inline progress + final summary table, markdown report fan-out to /tmp/outputs/, docs/qa_reports/, and Obsidian. Establishes `phaseN_backend_smoke_v1_0.sh` naming convention for future phases. No schema, API route, or node:test count changes.

> [v1.3-patch ADDED §13, no original ancestor] **Migrator improvements** (25 May 2026):
> - `MIGRATION_FILE_RE` regex filters out `.rollback.sql` and non-standard filenames
> - `--reconcile-only` flag records migration versions without executing SQL (used for prod schema reconciliation)
> - `ON CONFLICT DO NOTHING` on schema_migrations INSERT — prevents duplicate-key error when SQL self-inserts in same transaction
> - Production Railway DB now has **70 migrations recorded** in schema_migrations (migrations 012–069 reconciled)
> - Migration `058_attendees_pass_columns.sql` renamed to singular form `058_attendee_pass_columns.sql` to match prod record

> [v1.3 ADDED §13, no original ancestor] **P2 Phase 0 — Moderation Foundation** complete. Zero frontend changes. Infrastructure only:
> - 9-state moderation_status ENUM (draft → submitted → under_review → changes_requested → approved/rejected → withdrawn/superseded/discarded)
> - vendor_profiles + stall_branding shell tables (content fields to be added in Phase 1)
> - moderation_items (JSONB payload per proposed change; deferred FKs to shell tables)
> - moderation_notes (immutable audit trail — AP-5 trigger blocks UPDATE/DELETE)
> - vendor_content_editor + vendor_content_approver flags on users (MT-VP-01 self-approval guard)
> - 3 new routes: POST /moderation-items/:itemId/transition, GET /vendors/:vendorOrgId/moderation-items, GET /moderation-items/:itemId/history
> - 14/14 moderation-foundation tests pass; full suite 488 pass, 0 fail, 24 skip

---

## 14. Screen Inventory

> [v1.1 ADDED §14, no original ancestor] **32 HTML screens** confirmed built:

| URL Path | File | Purpose |
|---|---|---|
| /login | apps/web/login.html | All roles — email + password + MFA OTP |
| /index | apps/web/index.html | Platform root / landing |
| /select-context | apps/web/select-context.html | Multi-org context selector |
| /account | apps/web/account.html | Account settings (all authed roles) |
| /forgot-password | apps/web/forgot-password.html | Password reset request |
| /reset-password | apps/web/reset-password.html | Password reset form (token) |
| /set-password | apps/web/set-password.html | Invite acceptance / initial set password |
| /s | apps/web/s.html | Short-link redirect handler |
| /kiosk | apps/web/kiosk.html | Kiosk check-in (device-only) |
| /leaderboard | apps/web/leaderboard.html | Public event leaderboard |
| /docs | apps/web/docs.html | Attendee document access (tokenised, no login) |
| /organizer | apps/web/organizer.html | Organizer dashboard |
| /organizer/events | apps/web/organizer/events.html | Event list |
| /organizer/event-detail | apps/web/organizer/event-detail.html | Event detail + stalls |
| /organizer/stall-detail | apps/web/organizer/stall-detail.html | Stall detail + drive docs |
| /organizer/sponsor-package-detail | apps/web/organizer/sponsor-package-detail.html | Sponsor package detail |
| /organizer/team | apps/web/organizer/team.html | Team member management |
| /organizer/team-member | apps/web/organizer/team-member.html | Individual member detail |
| /organizer/data-export | apps/web/organizer/data-export.html | Full data export |
| /organizer/privacy-requests | apps/web/organizer/privacy-requests.html | DSR management |
| /organizer/platform-access-log | apps/web/organizer/platform-access-log.html | Access audit log |
| /vendor | apps/web/vendor.html | Vendor dashboard (leads, drive, metrics) |
| /sponsor | apps/web/sponsor.html | Sponsor analytics dashboard |
| /attendee | apps/web/attendee.html | Attendee privacy portal |
| /attendee/privacy | apps/web/attendee/privacy.html | Attendee privacy detail / DSR |
| /ops/fleet | apps/web/ops/fleet.html | Ops device fleet dashboard |
| /admin | apps/web/admin.html | Platform admin dashboard |
| /admin/tenants | apps/web/admin/tenants.html | Tenant list |
| /admin/tenant-detail | apps/web/admin/tenant-detail.html | Tenant detail |
| /admin/compliance | apps/web/admin/compliance.html | Compliance overview |
| /admin/offboarding | apps/web/admin/offboarding.html | Tenant offboarding |
| /admin/privacy-audit-log | apps/web/admin/privacy-audit-log.html | Privacy audit log |
| /admin/retention | apps/web/admin/retention.html | Retention policy management |
| /admin/status | apps/web/admin/status.html | System status |
| /admin/user-detail | apps/web/admin/user-detail.html | User detail (admin) |

> [v1.2 ADDED §14] `/docs` (attendee document access page — no login required) added as part of Phase 6 Drive integration.

---

## 15. Approval Matrix and Change Control

| Change item | Required approvers |
|---|---|
| New feature | Product Owner + System Architect |
| Schema change | System Architect + Engineering Lead |
| Metric formula change | Product Owner + System Architect |
| Trust policy change | Founder/Product Owner + System Architect |
| Export workflow change | System Architect + Organizer-facing policy owner |
| Live-event hotfix | Engineering Lead + System Architect |
| Free pilot or non-standard discount | Founder/Product Owner |
| Partner payout exception | Founder/Product Owner |

---

## 16. Final Non-Negotiable Master Laws

No event goes live without configuration, reader, offline, sync, heartbeat, and branding validation.
No export occurs outside consent and event data policy.
No production event-critical release happens inside the freeze window without emergency approval.
No one bypasses trust controls to keep an event moving.
No dashboard or report metric may use an undefined or changed formula.
No partner or internal role receives data outside documented scope.
No incident affecting trust or PII is treated as minor.
All policy changes, approvals, exports, and privileged access actions are auditable.
Commercial teams sell ROI and trust, not technical novelty.
Field reliability outranks feature breadth.

---

## Appendix A — Role Permissions and Data Visibility Matrix

| Actor | Allowed actions | Forbidden actions |
|---|---|---|
| Attendee | Own contact vault, revoke consent, request DSR export/delete | Any dashboard, any other user's data, policy changes |
| Vendor Manager | Own stall lead inbox, notes, scoring, CRM push if allowed, export request if allowed | Other stalls, non-consented PII, sponsor analytics, policy changes |
| Sponsor User | Sponsor-scoped metrics, heatmaps, aggregate audience insights, sponsor-consented export if allowed | Vendor inbox, non-consented PII, organizer controls |
| Organizer Admin | Event analytics, fleet, export approvals, event data policy, branding approval | Cross-tenant data, implicit bypass of consent |
| Platform Admin | Infrastructure, masked operational access, tenant config, incidents | Unrestricted PII browsing, raw exports without break-glass |
| Ops User | Fleet diagnostics, assignments, incidents | Attendee PII, exports, sponsor data |
| Device Principal | Config fetch, heartbeat, sync, incident logging, tap creation | Dashboards, exports, metrics reads |

---

## Appendix B — End-to-End Flow Definitions

### B.1 Attendee Phone Tap Flow

1. Kiosk is in IDLE or OFFLINE_IDLE with valid event and stall assignment.
2. NFC reader detects phone/tag input.
3. State changes to TAP_READING.
4. Runtime generates local_event_id and queue_sequence_number.
5. Canonical local event is durably written to local queue before any network action.
6. State changes to INTERACTION_ACTIVE.
7. If online, backend /interactions/tap is called asynchronously.
8. Backend creates tap_event and interaction, returns interaction_id, resolution_status, attendee_preview, branding_payload, and customer_link.
9. Attendee opens mobile landing page through NFC or QR/session link.
10. Attendee selects vendor and sponsor consent choices.
11. Consent capture updates consents table, consent_events history, and interactions.consent_status.
12. Vendor inbox updates in real time with masked or unmasked fields according to effective consent and event policy.

> [v1.2 ADDED §B, no original ancestor] **Attendee Document Access Flow**:
> 1. Vendor connects Google Drive/OneDrive via OAuth.
> 2. Vendor configures shared folders and creates access grant for attendee.
> 3. On NFC tap, platform auto-grants document access and generates a 32-byte hex token.
> 4. Attendee visits /docs/:token (no login required).
> 5. Platform validates token, checks expiry, proxies file listing from Drive provider.
> 6. Every access (browse, view, download) is logged in stall_folder_access_log.

### B.2 Offline Recovery Flow

1. Queued unsynced local events remain in queue_store with sync_status = queued or failed_retryable.
2. When network connectivity returns, sync engine starts automatically or on next sync interval.
3. Queue is replayed strictly in ascending queue_sequence_number order.
4. Backend deduplicates by (device_id, local_event_id).
5. Duplicate items are treated as success and marked locally as synced.
6. Retryable failures are retried with exponential backoff; terminal failures remain visible in diagnostics.

---

## Appendix C — Kiosk State Definitions

| State | Definition |
|---|---|
| BOOTING | Initialize local services, storage, reader adapter, network monitor |
| CONFIG_LOADING | Load cached config, attempt GET /device/config, verify assignment and branding |
| CONFIG_ERROR | No usable config; attendee flow blocked; admin retry only |
| READER_ERROR | Reader unavailable; QR fallback remains if config valid |
| LOCKED_UNASSIGNED | Device not assigned; no attendee-facing interaction |
| IDLE | Default branded state with sponsor creative and QR fallback |
| OFFLINE_IDLE | Same as IDLE but explicit offline status for diagnostics |
| TAP_READING | Immediate NFC processing and local queue write |
| INTERACTION_ACTIVE | Attendee preview/basic interaction state with sponsor panel and timer |
| INTERACTION_EXCEPTION | Fallback handling for invalid read or non-recoverable preview issues |
| SYNCING_BACKGROUND | Concurrent state for queued upload and retry handling |
| DIAGNOSTICS | Hidden support state with operational controls and no destructive queue wipe |

---

## Appendix D — Test Coverage

> [v1.5 CHANGED from §D] **539 tests passing | 0 fail | 24 skipped** (was 519 in v1.4-fix4). New test file:
> - `p2-phase1-5-moderation-queue.test.mjs` — 20 tests: Auth-1 (vendor_content_* flags in /auth/me), VP-22b/c (edit-lock on submitted/under_review for profile and social-links), VP-23 (Release transition), MT-VP-10 (under_review → submitted allowed), SO-1–4 (single-operator fallback, FIX-1 multi-approver plain-403 verification), Conc-1/2 (optimistic-concurrency 409 guard), Rel-1/2 (Release authz), Resub-1/2 (resubmit authz), Notif-1–3 (notification fan-out), Hist-1 (actor_display_name in history), Audit-1 (audit metadata includes action).
>
> VP-22 test in `p2-phase1-vendor-profile.test.mjs` inverted: now asserts 422 + state unchanged (was: asserts auto-draft success).

> [v1.4-fix4 CHANGED from §D] **519 tests passing | 0 fail | 24 skipped** (was 516 in v1.4-fix3). 3 new tests added to p2-phase1-vendor-profile.test.mjs:
> - VP-22: PATCH /vendors/:vendorOrgId/profile on a submitted item auto-transitions to draft before overwriting (moderation integrity regression test)
> - 2 supporting edge-case tests for the auto-withdraw flow (submitted → draft, under_review → draft)
>
> Smoke script `phase1_backend_smoke_v1_0.sh` updated with item 1.3b-integrity.

> [v1.4-fix2 CHANGED from §D] **516 tests passing | 0 fail | 24 skipped** (was 513 in v1.4-hotfix). 3 new regression tests added to p2-phase1-vendor-profile.test.mjs + 2 existing moderation-foundation tests corrected:
> - VP-17: submit on an existing draft sets `prior_status = draft` in moderation_notes
> - VP-18: first-ever submit (no prior item) sets `prior_status = null` in moderation_notes
> - VP-19: null new_status is rejected at the repo layer (NOT NULL constraint mirrored in memory backend)
> - Two pre-existing moderation-foundation tests that omitted `new_status` were corrected to pass the required field.

> [v1.4-hotfix CHANGED from §D] **513 tests passing | 0 fail | 24 skipped** (was 512 in v1.4-fix). 1 new test added to p2-phase1-vendor-profile.test.mjs:
> - Regression test VP-16: full form payload on PATCH /vendors/:vendorOrgId/profile returns 200 and IDs are valid UUID strings (not `prefix-uuid` TEXT strings)

> [v1.4-fix CHANGED from §D] **512 tests passing | 0 fail | 24 skipped** (was 510 in v1.4). 2 new tests added to p2-phase1-vendor-profile.test.mjs:
> - Industry field persistence (PATCH /vendors/:vendorOrgId/profile stores and retrieves industry)
> - Industry field length validation (> 80 chars rejected with 400)

> [v1.4 CHANGED from §D] **510 tests passing | 0 fail | 24 skipped** (was 494 in v1.3-patch). New test file:
> - p2-phase1-vendor-profile.test.mjs — 13 tests covering vendor profile draft creation, self-approval guard (MT-VP-01), approval pointer swap + social link sync, public attendee endpoint fallback/full-content, validation (HTTPS enforcement, HTML stripping, channel enum), auto-shell creation on first save

> [v1.3-patch CHANGED from §D] **494 tests passing | 0 fail | 24 skipped** (was 488 in v1.3). New test file:
> - migrator.test.mjs — 9 new unit/integration tests covering rollback filtering, reconcileOnly mode, ON CONFLICT DO NOTHING behaviour

> [v1.3 CHANGED from §D] **488 tests passing | 0 fail | 24 skipped** (was 438 in v1.2). New test file:
> - moderation-foundation.test.mjs — 14 tests covering 9-state machine, self-approval guard, org isolation, history audit trail

> [v1.2 ADDED §D, no original ancestor] **438 tests passing | 0 fail | 24 skipped**

| Test File | Coverage Area |
|---|---|
| foundation.test.mjs | Core platform invariants and law enforcement |
| phase2-auth.test.mjs | Authentication, JWT, MFA, password flows |
| phase3-users.test.mjs | User management, RBAC, invitations |
| phase4-events.test.mjs | Events, halls, stalls, sponsor packages |
| phase5-middleware.test.mjs | Middleware, rate limiting, security headers |
| phase6-notifications.test.mjs | Notification dispatch, templates, retry |
| phase7-audit.test.mjs | Audit log, tamper resistance, privacy audit |
| phase8-ui-api.test.mjs | UI API routes, frontend integration |
| phase9-fixes.test.mjs | Regression tests for all identified fixes |
| phase11-routing.test.mjs | Route matching, access control matrix |
| phase12-integration.test.mjs | CRM integration, webhook delivery |
| phase13-integration.test.mjs | Export pipeline, DSR, offboarding |
| phase15-sovereignty.test.mjs | Data sovereignty, retention, purge |
| phase16-workers.test.mjs | Background worker integration |
| phase17-notifications.test.mjs | Advanced notification flows |
| drive-storage.test.mjs | Drive OAuth, token encryption, access grants (v1.2) |
| e2e-full-system.test.mjs | End-to-end system test |
| moderation-foundation.test.mjs | Moderation 9-state machine, self-approval guard, org isolation (v1.3) |
| pass-types.test.mjs | Pass type CRUD, nfc_behaviour validation, vendor visibility (v1.3) |
| nfc-batches.test.mjs | NFC tag batch creation, UID assignment, status lifecycle (v1.3) |
| nfc-tap.test.mjs | NFC tap ingestion with pass-type resolution (v1.3) |
| attendee-import.test.mjs | Bulk CSV import, walk-in registration (v1.3) |
| attendee-management.test.mjs | Attendee roster, NFC assignment, pass-type filtering (v1.3) |
| import-staff.test.mjs | organizer_import_staff role permissions and scope (v1.3) |
| email-delivery.test.mjs | Email delivery worker, retry logic, dead-letter handling |
| iot-integration.test.mjs | IoT sync run management, checkpoint persistence |
| infra-compliance.test.mjs | Compliance report generation, pilot sign-off flows |
| infra-crm-deletion.test.mjs | CRM deletion cascade on DSR delete events |
| infra-storage.test.mjs | R2/S3 storage backend, export file lifecycle |
| server.security.test.mjs | Server-level security headers, transport enforcement |
| postgres.integration.test.mjs | PostgreSQL backend integration (requires live DB) |
| p2-phase1-5-moderation-queue.test.mjs | Approver queue: edit-lock, Release, single-operator, optimistic-concurrency, notifications, history, audit (v1.5) |

---

## Appendix E — Error Codes

| Error code | Meaning |
|---|---|
| UNAUTHENTICATED | Missing/invalid credentials |
| TENANT_MISMATCH | Principal tenant and resource tenant differ |
| ROLE_FORBIDDEN | Role not eligible for route |
| SCOPE_FORBIDDEN | Actor not scoped to event/stall/resource |
| CONSENT_REQUIRED | Vendor release consent absent |
| SPONSOR_CONSENT_REQUIRED | Sponsor release consent absent |
| EVENT_POLICY_BLOCKED | Event data policy forbids action |
| EXPORT_REQUIRES_APPROVAL | Request accepted but waiting organizer approval |
| VALIDATION_ERROR | Request body or parameter invalid |
| RESOURCE_NOT_FOUND | Requested object not found in caller scope |
| PROVIDER_UNAVAILABLE | Downstream provider temporarily unavailable |
| RATE_LIMITED | Gateway or service rate limit applied |
| TRANSPORT_NOT_SECURE | TLS or trusted secure transport not present |

> [v1.2 ADDED §E] Additional error codes introduced for Drive integration:
> - `not_configured` (503) — Drive OAuth env vars not configured on server
> - `token_error` (502) — Drive OAuth token exchange or refresh failed
> - `network_error` (502) — Drive provider API unreachable
> - `db_permission_error` (500) — PostgreSQL RLS or permission denied (internal)
> - `conflict` (409) — State conflict (e.g., drive connection already active)

---

## Appendix F — Event-Time Checklists

### F.1 Pre-Dispatch Checklist
- Device cleaned, labeled, and serial verified.
- Reader paired and functional.
- Correct app version installed.
- Kiosk mode verified.
- Assignment and branding preloaded.
- Offline queue empty before dispatch.
- Battery health verified.
- Charger, spare cable, and spare reader packed as per manifest.

### F.2 Venue Go-Live Checklist
- Correct stall placement and power confirmed.
- 10 rapid NFC taps successful.
- QR fallback successful.
- Offline tap test successful.
- Reconnect sync test successful.
- Heartbeat visible on organizer dashboard.
- Sponsor branding visible and correct.
- No cross-stall or cross-event data visibility observed.

### F.3 End-of-Event Checklist
- All devices accounted for.
- Unsynced queue count reviewed.
- Open incidents triaged.
- Final analytics sanity checked.
- Report freeze approved or scheduled.
- Retention clock confirmed from policy.

---

## Appendix G — Mandatory Manual Validation Set

- No-internet tap capture and later sync replay.
- Duplicate prevention on repeated upload of same local_event_id.
- Consent capture, revoke, and masking behavior across vendor and sponsor roles.
- Sponsor metrics sanity: impressions not equal clicks not equal leads.
- Reboot recovery with queued unsynced local events present.
- Reader disconnect fallback with QR still available.
- Export request, approval, rejection, completion, and expiry behavior.
- CRM push blocked when consent absent or event policy forbids push.
- Public leaderboard contains no personal data.
- Break-glass request, approval, expiry, and audit trace.

> [v1.2 ADDED §G] Additional validation items for v1.2:
> - Google Drive OAuth connect, folder listing, file viewing (no binary download to server).
> - Attendee document access via /docs/:token with no login.
> - Token expiry enforcement on access grants.
> - AES-256-GCM encrypted token storage in database.
> - MFA OTP flow: send, verify, single-use, 10-minute expiry.
> - Snapshot comparison: multi-select, bar chart data, CSV export.

---

## Appendix H — Production Infrastructure and Environment Variables

> [v1.2 ADDED §H, no original ancestor] Full environment variable list as of v1.2:

| Variable | Purpose |
|---|---|
| DATABASE_URL | PostgreSQL connection string (Railway) |
| USE_POSTGRES | true — enables PostgreSQL repositories |
| BASE_URL | https://codex-api-production-064f.up.railway.app |
| SESSION_SECRET | JWT signing secret (min 32 chars) |
| STORAGE_BACKEND | s3 (Cloudflare R2) |
| S3_BUCKET | R2 bucket name |
| S3_REGION | auto (R2 default) |
| S3_ENDPOINT | R2 account endpoint URL |
| S3_ACCESS_KEY_ID | R2 access key |
| S3_SECRET_ACCESS_KEY | R2 secret key |
| ZEPTO_API_KEY | ZeptoMail API key |
| EMAIL_FROM | noreply@communication.feturtles.com |
| DRIVE_ENCRYPTION_KEY | 64-char hex (32 bytes) for AES-256-GCM — **new in v1.2** |
| GOOGLE_OAUTH_CLIENT_ID | Google Cloud OAuth client ID — **new in v1.2** |
| GOOGLE_OAUTH_CLIENT_SECRET | Google Cloud OAuth client secret — **new in v1.2** |
| GOOGLE_OAUTH_REDIRECT_URI | /auth/drive/google/callback — **new in v1.2** |
| ONEDRIVE_OAUTH_CLIENT_ID | Azure AD app registration client ID — **new in v1.2** |
| ONEDRIVE_OAUTH_CLIENT_SECRET | Azure AD client secret — **new in v1.2** |
| ONEDRIVE_OAUTH_REDIRECT_URI | /auth/drive/onedrive/callback — **new in v1.2** |
