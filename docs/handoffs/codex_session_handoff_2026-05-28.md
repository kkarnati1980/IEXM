# Codex Session Handoff — 2026-05-28

## Purpose
Resume point for a new chat. Captures phase status, open items, and where work stopped.

## Current phase
P2 Phase 1 — Vendor Profile Core. Status: QA complete, closing in progress. Build log is the last remaining artifact.

## Preferences in force
- v2.0 base (§1-13, §15)
- v2.1 (§14 revised — confidence with Tested/NOT-tested/Plan-coverage breakdown; §16 — Phase Closure QA Checklist)
- v2.2 (§13a — Script Grouping)
- v2.3 (§13b — Follow-up fixes must not short-circuit on git history)
All four preference files are in docs/preferences/ and Claude project knowledge.

## What shipped in Phase 1

Commits from initial vendor profile build through latest mobile-header fix, in chronological order:

| SHA | Description |
|-----|-------------|
| `24f59cb` | feat(p2-phase1): Vendor Profile Core (CR-VP-01) — moderation-backed profile + social links |
| `08b1882` | fix(vendor-ui): remove redundant subtitle, restyle tab nav to match organizer pattern |
| `34f6a98` | fix(vendor-profile): add missing Industry field to Phase 1 form |
| `ca04b5b` | fix(vendor-profile): 500 on PATCH /vendors/:vendorOrgId/profile + improve error logging |
| `d57aad3` | fix(moderation): PATCH submit=true was inserting null new_status into moderation_notes |
| `03c2fdf` | trigger: Railway redeploy for d57aad3 |
| `c62319a` | feat(qa): reusable backend smoke test script for Phase 1 |
| `e2d8878` | feat(qa): reusable backend smoke test script for Phase 1 (finalised) |
| `3780da0` | feat(qa): seed-approver-user script for AP-4 flag separation |
| `43d23c6` | fix(vendor-profile): enforce 2000-char description limit in backend (matches UI) |
| `0ca0d38` | chore: untrack .env (secrets stay local), finalize 058 migration rename |
| `02bd209` | trigger: Railway redeploy for A4 description-limit fix (43d23c6) |
| `b8a315c` | fix(vendor-profile): Phase 1 QA fix-up — moderation integrity, refresh button, mobile header |
| `70cbdf4` | fix(vendor-ui): mobile header button-group overflow at 375px (follow-up to b8a315c) |

## Production state
- API: https://codex-api-production-064f.up.railway.app
- Migration 070 (vendor_profile_social_links) applied to production
- vendor-approver@test.com user created on prod; AP-4 flags separated (vendor=editor, approver=approver)
- Backend smoke: 37/37 pass on production (latest report in docs/qa_reports/)
- Full test suite: 519 pass / 0 fail / 24 skip (skips are Postgres integration tests)

## QA results (from phase1_vendor_profile_core_qa_checklist_v1_0.md)
- §1 Backend smoke: 37/37 via automated script
- §2 UI walk-through: core flows pass; approver UI = scope gap; attendee landing render = deferred
- §3 Alignment: pass including mobile header (fixed in b8a315c + 70cbdf4)
- §4 Cross-flow: covered by smoke script's full chain
- §5 Regression: pass; consent flow marked N/A (Phase 1 didn't touch consent code)

## Bugs found + fixed this phase (for the build log)
1. Industry field silently dropped from plan execution — fixed
2. UUID vs TEXT id bug (memory backend accepted non-UUID, Postgres rejected) — fixed, prod 500
3. Missing new_status in moderation_notes insert (PATCH-submit path bypassed helper) — fixed, prod 500
4. PATCH save-draft on submitted item overwrote payload without transition/audit (§1.3) — fixed (auto-transition to draft, VP-22)
5. A4: description silently truncated instead of 422 — fixed (hard 2000-char limit)
6. Refresh button on status panel did nothing — fixed
7. Mobile header overlap at 375px (badge/title/tabs, then button group) — fixed in two commits
8. Missing vendor-approver user on prod — fixed via seed-approver-user_v1_0.sh
9. AP-4 flag overlap (both flags on both users) — fixed via same script

## Scope gaps logged (NOT bugs — future sprints)
- Approver moderation queue UI (Phase 1.5 / next sprint) — approver currently has no UI to approve; API-only
- Logo upload infrastructure (deferred per CR-VENDOR — vendor_media_assets, R2, malware scan)
- Attendee landing render — deferred to next kiosk test session (couldn't mint attendee session token from DB; smoke verified the public API instead)

## Reusable tooling built this phase
- apps/api/scripts/qa/phase1_backend_smoke_v1_0.sh (37 items, 3-path report fan-out)
- apps/api/scripts/qa/seed-approver-user_v1_0.sh (idempotent user seed + AP-4 flag setup, writes /tmp/codex_qa_tokens.env)
- apps/api/scripts/qa/README.md
- Pattern established: every phase gets a backend smoke script + QA checklist per §16

## Housekeeping done this session
- .env untracked from git (was committed in initial commit with placeholder values; verified live secrets were never committed; .env now gitignored)
- 058 migration rename finalized (plural → singular)
- claude CLI reinstalled (was broken — npm install -g @anthropic-ai/claude-code)
- Baseline files refreshed through v1.4-fix4b (70cbdf4)
- **2026-05-29 (Phase 1.5.1):** Pre-push baseline-refresh hook REMOVED (.git/hooks/pre-push deleted). It ran 1–2 min per push and looped on its own commits. Use `npm run refresh-baselines` explicitly when baselines need updating.

## Known minor items not yet addressed (low priority)
- display_name vs company_name: DECISION = keep display_name, update spec wording (do not rename)
- VP-22 vs VP-20 test-number label drift (cosmetic)
- vendor@example.com orphan user with no password hash (cleanup someday)
- Old placeholder .env still in git history at initial commit (low risk — values stale, repo private; full history scrub deferred)
- Custom domain, password rotation from TestPass123!, DATABASE_URL rotation (deferred HIGH bundle)

## NEXT STEP when resuming
Write the Phase 1 build log (per §16) — the last artifact before Phase 1 formally closes. Then update master spec to v1.2 (folding Phase 0 + Phase 1 deltas, noting display_name). After that, plan Phase 1.5 (approver moderation queue UI) or next phase.

## Key facts
- Repo: kkarnati1980/IEXM (private), main branch
- Codebase: /Users/kishore/Codex_Development
- DB: Railway Postgres (connection string in local .env, not in git)
- Seeded creds: vendor@test.com, vendor-approver@test.com, admin@test.com, organizer@test.com (all TestPass123!)
- Tenant: tenant-demo · Event: event-indiaexpo · Org: org-vendor · Stall: stall-ie-a1
