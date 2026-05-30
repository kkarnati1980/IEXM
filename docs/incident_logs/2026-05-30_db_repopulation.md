# DB Repopulation Incident Log — 2026-05-30

## Incident Summary

Production Railway Postgres data was lost during credential rotation on 2026-05-29.
The old service was renamed `Postgres → Postgres-KrxY` (tombstone). The new empty
Postgres service became the active target for `codex-api`.

All data confirmed lost and accepted as test/seed/development only — no real customer
data, no real attendee consent records.

## Timeline

| Time (IST) | Event |
|---|---|
| 2026-05-29 | Credential rotation; old DB renamed to Postgres-KrxY |
| 2026-05-30 | Rebuild plan authored by Claude Sonnet 4.6, approved by Kishore |
| 2026-05-30 | Phase 1 — schema rebuild: 71 migrations applied to empty DB |
| 2026-05-30 | Phase 2 — QA seed: seed-prod-qa.mjs run against rebuilt schema |

## Phase 1 — Schema Rebuild

**Approved by:** Kishore (via chat, 2026-05-30)

**Pre-check:** Confirmed target DB empty (`information_schema.tables WHERE table_schema='public'` = 0 or 1)

**Migration command:**
```bash
DATABASE_URL=<redacted> DATABASE_SSL=true DATABASE_SSL_REJECT_UNAUTHORIZED=false \
node apps/api/src/scripts/migrate.mjs
```

**Result:**
- 71 forward migrations applied (001_init.sql → 070_vendor_profile_social_links.sql)
- 14 rollback files correctly excluded by migrator regex `/^\d+_[a-z0-9_]+\.sql$/`
- `schema_migrations` table populated with 71 rows
- All Phase 0/1/1.5 tables confirmed present: `vendor_profiles`, `stall_branding`, `moderation_items`, `moderation_notes`, `users.vendor_content_editor/approver` columns

## Phase 2 — QA Seed

**Approved by:** Kishore (via chat, 2026-05-30, "approve and execute Phase 2")

**Seed script:** `apps/api/src/scripts/seed-prod-qa.mjs` (created this incident)

**Records inserted (all idempotent — ON CONFLICT DO NOTHING):**
- 1 tenant: `tenant-demo`
- 4 organizations: org-organizer, org-vendor, org-sponsor, org-platform
- 6 users: demo-admin, demo-organizer, demo-vendor (editor only), demo-vendor-approver (approver only), demo-sponsor, demo-ops — all password `TestPass123!` (scrypt)
- 3 events: event-demo (live), event-other (draft), event-indiaexpo (live)
- 3 halls: hall-main, hall-secondary, hall-a
- 6 stalls: stall-a1/a2 (event-demo), stall-b1 (event-other), stall-ie-a1/a2/a3 (event-indiaexpo)
- 3 event_data_policies
- 1 sponsor_package: pkg-gold-ie
- 1 device: device-01 (SN-001)
- 1 device_assignment: assign-01
- 6 user_role_assignments (all scoped to event-indiaexpo)
- 6 user_access_scopes (including demo-vendor-approver scope, absent from legacy seed)
- 1 device_credential: cred-device-01 (token: `dvc_seed_device_01`, SHA256 hashed)
- 1 consent_version: cv-v1-demo
- 1 app_config for tenant-demo

**AP-4 separation:**
- `vendor@test.com`: `vendor_content_editor=true`, `vendor_content_approver=false`
- `vendor-approver@test.com`: `vendor_content_editor=false`, `vendor_content_approver=true`

## What Was NOT Rebuilt

The following were intentionally omitted (created by QA runs, not seed):
- Vendor profiles and moderation items
- Leads and interactions
- Audit logs
- The Phase 0 moderation_notes immutability-proof row (accepted loss — verification artifact only)

## Verification

Post-seed verification via `POST /auth/login` for all three QA users confirmed
200 responses with valid JWTs. Full Phase 1/1.5 smoke suite (`phase1_backend_smoke_v1_0.sh`)
passed after seed.

## Files Changed This Incident

| File | Action |
|---|---|
| `apps/api/src/scripts/seed-prod-qa.mjs` | Created — minimum QA seed for production |
| `docs/incident_logs/2026-05-30_db_repopulation.md` | Created — this log |
