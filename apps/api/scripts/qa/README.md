# QA Smoke Scripts

Reusable backend smoke tests for each phase. Each script runs without Postgres by hitting
the live (or local) API over HTTP, then optionally runs psql assertions if DATABASE_URL is set.

## Purpose

These scripts cover the §1 "Backend smoke tests" section of each Phase Closure QA Checklist
(per developer preferences §16). They are:

- **Idempotent** — re-running does not pollute state (cleanup step at top resets pending items)
- **Destructive-safe** — every write operation is labelled `[WRITE]` in stdout
- **Structured** — every item records PASS / FAIL / SKIP; final report written to markdown
- **CI-ready** — exit 0 = all pass, exit 1 = failures, exit 2 = env error

## How to set env vars

```bash
export VENDOR_TOKEN="demo-vendor-token"
export VENDOR_APPROVER_TOKEN="demo-vendor-approver-token"

# Optional — defaults to production URL if not set:
export API_BASE_URL="https://codex-api-production-064f.up.railway.app"

# Optional — enables psql DB assertions (item 1.4 etc):
export DATABASE_URL="postgres://pilot@127.0.0.1:5432/pilot_platform"
```

## How to run

```bash
# Run all tests against production:
bash apps/api/scripts/qa/phase1_backend_smoke_v1_0.sh

# Dry-run (prints what would run, no writes):
bash apps/api/scripts/qa/phase1_backend_smoke_v1_0.sh --dry-run

# Run against local dev server:
API_BASE_URL="http://localhost:3000" bash apps/api/scripts/qa/phase1_backend_smoke_v1_0.sh
```

The script prints inline progress, then writes a timestamped markdown report to three locations:
- `/tmp/outputs/phase1_backend_smoke_report_<YYYYMMDD-HHMM>.md`
- `docs/qa_reports/phase1_backend_smoke_report_<YYYYMMDD-HHMM>.md`
- `Obsidian: Codex Platform/qa_reports/…`

## How to add new tests to an existing script

1. Add a function `smoke_<id>_<description>()` following the pattern of existing functions.
2. Call it in `main()` at the appropriate position.
3. Each function should call exactly one of: `pass_item`, `fail_item`, or `skip_item`.
4. Update the comment block at the top of the script listing all covered items.

## Naming convention

```
phaseN_<phase_name>_smoke_v<major>_<minor>.sh
```

Examples:
- `phase1_vendor_profile_core_smoke_v1_0.sh` — initial version
- `phase1_vendor_profile_core_smoke_v1_1.sh` — updated version after fix-up commit
- `phase2_stall_branding_smoke_v1_0.sh` — next phase

## Shared fixtures

`test-fixtures.sh` — sourced by all smoke scripts. Contains the fixed demo org/stall/tenant IDs.
Edit only when the underlying demo seed data changes.

## Report files

Reports land in `docs/qa_reports/` (git-tracked) and Obsidian. Do NOT commit reports with
failing items — fix first, then re-run, then commit the passing report alongside the fix-up commit.
