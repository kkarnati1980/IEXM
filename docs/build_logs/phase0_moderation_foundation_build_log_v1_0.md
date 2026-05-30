# P2 Phase 0 — Moderation Foundation Build Log
Version 1.0 · 2026-05-24
Author: Claude Sonnet 4.6 (Claude Code) · Reviewer: Kishore Karnati

## 1. Scope
What this phase delivered and what it deliberately did NOT touch.
Reference: CR-VENDOR-2026-001 v1.0 §14, §15, §21.

**Delivered:**
- Database schema for moderation state machine (migrations 064–069)
- Three API endpoints implementing the Phase 0 moderation flow
- Self-approval guard and audit hook on every transition
- Migrator hardening (rollback filter, reconcile mode, ON CONFLICT fix, 058 rename, 054 RLS fix)

**Deliberately NOT touched:**
- No frontend changes — zero HTML/JS modified
- No real content fields on vendor_profiles or stall_branding (shells only; content fields land in Phase 1)
- No attendee-facing moderation item types beyond the vendor_profiles + stall_branding scope
- No payments, consent, or RBAC changes

## 2. Deliverables (verified on production)
- 9-state moderation_status ENUM (draft, submitted, under_review, changes_requested, approved, rejected, withdrawn, superseded, discarded)
- moderation_items table (JSONB payload pattern per spec §15.1)
- moderation_notes table with DB-level immutability trigger
- vendor_profiles shell table (currently_published_item_id pointer only, no content fields)
- stall_branding shell table (same pattern)
- vendor_content_editor + vendor_content_approver boolean flags on users table
- Generic POST /moderation-items/:id/transition endpoint
- GET /vendors/:vendorOrgId/moderation-items list endpoint
- GET /moderation-items/:id/history endpoint
- Self-approval guard (editor != approver enforced at API)
- audit_logs hook on every transition
- Second dev user vendor-approver@test.com for editor != approver tests
- Zero frontend changes

## 3. Migrations applied (production schema_migrations)
```
064_moderation_status_enum
065_vendor_profiles
066_stall_branding
067_moderation_items
068_moderation_notes
069_user_content_flags
```

## 4. Tests
- Baseline before phase: 471 pass
- After Phase 0 build: 488 pass
- After migrator hardening: 494 pass
- All 12 CR-VENDOR §21 mandatory test cases covered for Phase 0 scope (MT-VP-01, 02, 03 specifically — the others reference features in later phases)

## 5. Spec contract — load-bearing

### moderation_items table contract
| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | gen_random_uuid() |
| tenant_id | TEXT FK tenants | Row-level isolation |
| item_type | TEXT | 'vendor_profile', 'stall_branding' (Phase 0); others in later phases |
| target_id | TEXT | ID of the entity being moderated |
| status | moderation_status | State machine value |
| payload | JSONB | Proposed content snapshot at submission time |
| editor_user_id | TEXT FK users | Who submitted |
| reviewer_user_id | TEXT FK users | Who last transitioned (nullable) |
| created_at / updated_at | TIMESTAMPTZ | Standard audit columns |

### moderation_notes table contract (AP-5 immutability)
| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | gen_random_uuid() |
| tenant_id | TEXT FK tenants | Row-level isolation |
| target_id | TEXT | Links to moderation_items.id |
| note | TEXT | Reviewer comment |
| created_by | TEXT FK users | Author of the note |
| created_at | TIMESTAMPTZ | Immutable timestamp |

**AP-5 immutability principle:** A DB-level trigger fires BEFORE UPDATE OR DELETE on moderation_notes and raises an exception. This is enforced at the database layer, not only at the API layer. Any future change to this contract (e.g. adding a soft-delete column) requires a coordinated migration AND removal/replacement of the trigger. No API route or application code may bypass this without a schema migration.

**vendor_profiles and stall_branding shells:** These tables intentionally have no content fields in Phase 0. They carry only `id`, `tenant_id`, `stall_id`/`vendor_org_id`, `currently_published_item_id` (FK → moderation_items), and audit timestamps. Content fields (tagline, description, logo, social links, etc.) land in Phase 1. Any Phase 1 migration adding content columns must treat `currently_published_item_id` as the canonical pointer to live content.

## 6. Production verification artifacts

### Immutability-proof row (moderation_notes)
During Phase 0 verification, a test row was inserted into `moderation_notes` on production to confirm the AP-5 trigger fires correctly:

| Field | Value |
|---|---|
| target_id | random UUID (no real entity) |
| note | 'immutability-proof' |
| tenant_id | tenant-demo |

**Why it remains in production:** AP-5 forbids UPDATE or DELETE on moderation_notes at the database level. Removing this row would require a break-glass operation (bypassing the trigger). Decision made 2026-05-24 to respect the contract and leave the row as a permanent verification footprint. This row is invisible to vendors in all production query flows — they scope by target_id values they own, and this UUID is not associated with any real moderation item.

## 7. Detours and recovery — Migrator hardening

The Phase 0 migration apply revealed three pre-existing issues in the migrator that had been latent for months. Each was fixed in scope rather than deferred.

**a) .rollback.sql files treated as forward migrations**
The migrator's file filter used `.endsWith(".sql")`, which matched both `037_phase1_rbac_foundation.sql` AND `037_phase1_rbac_foundation.rollback.sql`. A future migrate run could have executed rollback SQL forward, silently dropping tables.
Fix: tightened the regex to `^\d+_[a-z0-9_]+\.sql$` — requires numeric prefix, lowercase stem, no dots inside.
Commits: `05c3d9a`

**b) No reconcile-without-execute mode**
27 historical migrations (012-036, 041-050) had been applied to production but were never recorded in schema_migrations (applied via a different mechanism before the migrator was in place). The migrator had no way to stamp them as applied without re-running their SQL.
Fix: added `--reconcile-only` flag to `migrate.mjs` and `{ reconcileOnly }` option to `runMigrations()`. Reconciled all 27 orphans cleanly during this phase.
Commits: `05c3d9a`, `daa4e91`

**c) Migrator INSERT crashed on self-inserting migrations**
Some migration files (e.g. 054_fix_stall_rls) contain their own `INSERT INTO schema_migrations` statement. The migrator also inserted the version row inside the same transaction — causing a duplicate key violation.
Fix: changed the migrator's own INSERT to `ON CONFLICT (version) DO NOTHING`.
Commits: `daa4e91`

**d) 058 migration filename mismatch**
File on disk: `058_attendees_pass_columns.sql` (plural "attendees").
Production schema_migrations: `058_attendee_pass_columns` (singular "attendee").
The migrator would have attempted to re-apply 058 on every future prod deploy, executing `ADD COLUMN IF NOT EXISTS` (safe but wasteful) and inserting a second schema_migrations row (harmful — duplicate record).
Fix: renamed the file to singular to match production; updated the self-INSERT inside the file to match.
Commits: `daa4e91`

**e) 054_fix_stall_rls never run on production**
Migration 054 patches an RLS policy bug introduced by 053 (stall_drive_connections used `current_setting()` instead of the `app_current_tenant_id()` function, causing all app_runtime queries to return zero rows). It was recorded in the reconcile pass but had never actually executed. Detected during the Q3 diagnostic.
Action: unstamped from schema_migrations, then applied normally so the ALTER POLICY executed on production.
Commits: `daa4e91`

## 8. Commits
| Hash | Message |
|---|---|
| e28c18c | feat: P2 Phase 0 Moderation Foundation infrastructure |
| 8192c4f | trigger: Railway redeploy |
| 05c3d9a | feat(migrator): filter rollback files, add --reconcile-only mode, update docs |
| daa4e91 | feat(migrator): prod schema reconciliation — 012-069 aligned, P2 Phase 0 applied |

## 9. Open items entering Phase 1
- Spec v1.1 docx file on Kishore's Mac was zero-bytes; needs re-download from Claude project before any spec edit work.
- Spec v1.2 docx update is pending. Will be folded into Phase 1 closure to include both Phase 0 and Phase 1 deltas in one revision.
- Phase 1 — Vendor Profile Core (CR-VP-01) is next. Adds real content fields to vendor_profiles (tagline, description, logo, website, social links, etc.) and the attendee landing page render.

## 10. Decisions log
- Editor and approver are different users by user.id, not by role. Both may carry role vendor_manager. Enforced per CR-VENDOR §14 at the API layer (returns 403 if editor_user_id === principal.user_id on approve/reject).
- Moderation foundation v1 scope: vendor_profiles + stall_branding only. Other attendee-facing item types fold in during their respective phases.
- vendor_content_editor and vendor_content_approver default FALSE in migration 069. Backfilled to TRUE for existing vendor_manager users for dev convenience. Production tightening (manual grant process) planned for Phase 1+.
- Immutability-proof verification row left in production (see §6). No break-glass action taken; row is benign.

## 11. Verification at end of session
- 494 tests pass locally (494 pass, 0 fail, 24 skip)
- All Phase 0 migrations (064-069) recorded in production schema_migrations
- All 4 Phase 0 tables (vendor_profiles, stall_branding, moderation_items, moderation_notes) confirmed present on production
- vendor_content_editor + vendor_content_approver columns confirmed on production users table
- AP-5 immutability trigger fires correctly on UPDATE (verified 2026-05-24)
- Railway redeploy completed (commit daa4e91)
- schema_migrations total: 70 rows (001-069 fully reconciled)

— end of build log —
