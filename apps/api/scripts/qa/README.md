# QA Smoke Scripts

Reusable backend smoke tests for each phase. Each script runs without Postgres by hitting
the live (or local) API over HTTP, then optionally runs psql assertions if `DATABASE_URL` is set.

## Purpose

These scripts cover the §1 "Backend smoke tests" section of each Phase Closure QA Checklist
(per developer preferences §16). They are:

- **Idempotent** — re-running resets pending state via a cleanup step before tests run
- **Destructive-safe** — every write operation is labelled `[WRITE]` in stdout
- **Structured** — every item records PASS / FAIL / SKIP; final report written to markdown
- **CI-ready** — exit 0 = all pass, exit 1 = failures, exit 2 = env error

## How to set env vars

```bash
export VENDOR_TOKEN="demo-vendor-token"
export VENDOR_APPROVER_TOKEN="demo-vendor-approver-token"

# Optional — defaults to production URL if not set:
export API_BASE_URL="https://codex-api-production-064f.up.railway.app"

# Optional — enables psql DB assertions (items 1.4a/1.4b):
export DATABASE_URL="postgres://pilot@127.0.0.1:5432/pilot_platform"
```

## How to run

```bash
# Run all tests against production:
bash apps/api/scripts/qa/phase1_backend_smoke_v1_0.sh

# Dry-run (shows what would run, no writes):
bash apps/api/scripts/qa/phase1_backend_smoke_v1_0.sh --dry-run

# Run against local dev server:
API_BASE_URL="http://localhost:3000" bash apps/api/scripts/qa/phase1_backend_smoke_v1_0.sh

# With DB assertions:
VENDOR_TOKEN=demo-vendor-token \
VENDOR_APPROVER_TOKEN=demo-vendor-approver-token \
DATABASE_URL=postgres://pilot@127.0.0.1:5432/pilot_platform \
bash apps/api/scripts/qa/phase1_backend_smoke_v1_0.sh
```

The script prints inline progress (one line per item), then writes a timestamped markdown
report to three locations (§7 fan-out):

- `/tmp/outputs/phase1_backend_smoke_report_<YYYYMMDD-HHMM>.md`
- `docs/qa_reports/phase1_backend_smoke_report_<YYYYMMDD-HHMM>.md` (repo)
- `Obsidian: Codex Platform/qa_reports/…`

## Items covered by phase1_backend_smoke_v1_0.sh

| Item  | Checklist Ref | Description |
|---|---|---|
| 1.1   | §1.1     | GET profile → 200, profile/published/pending keys |
| 1.2a  | §1.2     | PATCH draft → profile.id is UUID (no nextId prefix) |
| 1.2b  | §1.2     | PATCH draft → item.id is UUID |
| 1.2c  | §1.2     | PATCH draft → item.state = draft |
| 1.2d  | §1.2     | PATCH draft → industry field persists (regression) |
| 1.2e  | §1.2     | PATCH draft → HTML stripped from display_name |
| 1.2f  | §1.2     | PATCH draft → HTML stripped from description |
| 1.3a  | §1.3     | PATCH submit=true → 200 (was 500 null new_status) |
| 1.3b  | §1.3     | PATCH submit=true → state = submitted |
| 1.3c  | §1.3     | PATCH submit=true → submitted_at non-null |
| 1.4a  | §1.4     | DB: no moderation_notes rows with null new_status |
| 1.4b  | §1.4     | DB: most recent submit note new_status = submitted |
| 1.5   | §1.5     | GET social-links → 200, social_links is array |
| 1.6a  | §1.6     | PUT social-links → 200, 2 entries stored |
| 1.6b  | §1.6     | PUT social-links → prefilled_message preserved |
| 1.6c  | §1.6     | PUT social-links invalid channel (tiktok) → 422 |
| 1.6d  | §1.6     | PUT social-links >8 entries → 422 |
| 1.6e  | §1.6     | PUT social-links http:// URL → 422 (https-only) |
| 1.6f  | §1.6     | PUT social-links javascript: URL → 422 |
| 1.7a  | §1.7     | Transition: submitted → under_review (claim) |
| 1.7b  | §1.7     | Self-approval guard: vendor cannot approve own item → 403 |
| 1.7c  | §1.7     | Reject without note → 422 |
| 1.7d  | §1.7     | Transition: under_review → approved; decided_at non-null |
| 1.7e  | §1.7     | published.id = approved item; pending = null |
| 1.7f  | §1.7     | Reject-with-note → 200, state = rejected |
| 1.8a  | §1.8     | Public stall profile → 200, display_name + industry + social_links |
| 1.8b  | §1.8     | Public stall profile (no tenant_id) → 400 |
| A1    | extra    | Cross-org isolation: wrong org in URL → 403 |
| A2    | extra    | Invalid logo_url (http://) → 422 |
| A3    | extra    | Invalid logo_url (javascript:) → 422 |
| A4    | extra    | Description >5000 chars (spec: 422; code: silently truncates) |
| A5    | extra    | Industry >80 chars → 422 |

## Idempotency notes

- **In-memory backend**: fully idempotent — server restart clears all state.
- **Postgres backend**: the cleanup step at the top withdraws or rejects any lingering
  pending item before running. If the prior run left an item in an unexpected terminal
  state (e.g. `discarded`), the PATCH will create a fresh draft automatically.
- Do **not** commit report files that show failures — fix first, re-run, commit the passing
  report alongside the fix-up commit.

## How to add new tests

1. Add a function `smoke_<id>_<description>()` following the pattern of existing functions.
2. Each function calls exactly one of: `pass_item`, `fail_item`, or `skip_item`.
3. Add the function call to `main()` in the correct section.
4. Add a row to the "Items covered" table above.
5. Add the item to the comment block at the top of the script.

## Naming convention

```
phaseN_<phase_name>_smoke_v<major>_<minor>.sh
```

Examples:

- `phase1_backend_smoke_v1_0.sh` — Phase 1 initial
- `phase1_backend_smoke_v1_1.sh` — updated after fix-up commit
- `phase2_stall_branding_smoke_v1_0.sh` — next phase

## Shared fixtures

`test-fixtures.sh` — sourced by all smoke scripts. Contains the fixed demo org/stall/tenant IDs
from `apps/api/src/store.mjs`. Edit only when the underlying seed data changes.
