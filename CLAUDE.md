# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Stack

Node.js (ESM modules — all source files use `.mjs`), PostgreSQL, native `node:http` (no Express/Fastify), `node --test` built-in test runner.

## Commands

### Development

```bash
# Start API with in-memory backend (no Postgres needed)
node apps/api/src/server.mjs

# Start API with Postgres backend
REPOSITORY_BACKEND=postgres DATABASE_URL=postgres://pilot@127.0.0.1:5432/pilot_platform node apps/api/src/server.mjs

# Or use npm scripts (reads from .env automatically via dotenv/config)
npm run api:dev
```

### Database

```bash
# Start/stop local Postgres via Docker
bash scripts/postgres-local-start.sh
bash scripts/postgres-local-stop.sh

# Run migrations
MIGRATOR_DATABASE_URL=postgres://pilot@127.0.0.1:5432/pilot_platform \
DATABASE_URL=postgres://pilot@127.0.0.1:5432/pilot_platform \
node apps/api/src/scripts/migrate.mjs

# Seed demo data
MIGRATOR_DATABASE_URL=... DATABASE_URL=... node apps/api/src/scripts/seed-demo.mjs
```

### Testing

```bash
# Run all tests (memory backend, no Postgres required)
node --test apps/api/test/*.test.mjs packages/runtime/test/*.test.mjs

# Run a single test file
node --test apps/api/test/foundation.test.mjs

# Run Postgres integration tests (requires live DB)
DATABASE_URL=postgres://pilot@127.0.0.1:5432/pilot_platform \
node --test apps/api/test/postgres.integration.test.mjs

# Run e2e web tests (Playwright)
node --test apps/web/test/*.test.mjs
```

### Docker

```bash
make dev        # Build from source, start all services
make up         # Pull from GHCR, start production stack
make staging    # Start staging stack
make down       # Stop all services
make test       # Run tests inside the container
make migrate    # Run migrations inside the container
make psql       # Open PostgreSQL shell
make grants     # Re-apply app_runtime table grants
make health     # Check /health endpoint
make clean      # Remove containers and volumes (destructive)
```

### IoT Scripts

```bash
node apps/api/src/iot/mock-server.mjs   # Start mock IoT device server on :4010

# Sync streams (requires IOT_BASE_URL, IOT_EXPECTED_CONTRACT_VERSION, IOT_EXPECTED_ENVIRONMENT)
node apps/api/src/scripts/sync-iot-taps.mjs
node apps/api/src/scripts/sync-iot-heartbeats.mjs
node apps/api/src/scripts/sync-iot-incidents.mjs
node apps/api/src/scripts/sync-iot-device-ops.mjs

# Run certification, orchestration, and health checks
node apps/api/src/scripts/run-iot-contract-certification.mjs
node apps/api/src/scripts/run-iot-integration-orchestrator.mjs
node apps/api/src/scripts/run-iot-certification-health.mjs
node apps/api/src/scripts/run-iot-parity-check.mjs
node apps/api/src/scripts/cleanup-iot-operational-data.mjs
```

### Initial Setup

```bash
cp .env.example .env
# Edit .env, then:
bash scripts/postgres-local-start.sh
MIGRATOR_DATABASE_URL=... DATABASE_URL=... node apps/api/src/scripts/migrate.mjs
MIGRATOR_DATABASE_URL=... DATABASE_URL=... node apps/api/src/scripts/seed-demo.mjs
```

## Architecture

### Monorepo Layout

- `apps/api/` — the single Node.js API server; also serves `apps/web/` as static files
- `apps/web/` — static HTML/JS shells for each role (attendee, kiosk, vendor, sponsor, organizer, admin)
- `packages/runtime/` — edge primitives: offline queue store and state machine (used by kiosk devices)

### Request Pipeline (`apps/api/src/`)

Every HTTP request flows through this chain in `app.mjs`:

1. **Router** (`router.mjs`) — custom pattern matcher; routes defined in `routes.mjs`
2. **Auth** (`auth/`) — verifies bearer token as OIDC JWT (`oidc.mjs`), platform JWT (`platform-jwt.mjs`), or device credential; builds a `principal` with role + scopes
3. **`enforceRoleScope`** (`policy.mjs`) — checks the principal's role and event_ids against the route's `allowedRoles`
4. **`enforceAccessControlMatrix`** (`access-control.mjs`) — every registered route must appear in the ACM; tests fail if any route is missing or drifts from its declared role gates
5. **Route handler** — business logic in `routes.mjs` (and patch files `routes_patch_b2/b3/final.mjs`)
6. **`maskResponse`** (`masking.mjs`) — strips PII fields from lead responses based on consent and caller role

### Repository Pattern

`repositories.mjs` switches between two identical-interface backends:
- `repositories/memory.mjs` — in-process objects; used by all unit/integration tests
- `repositories/postgres.mjs` — real SQL via `pg`; selected by `REPOSITORY_BACKEND=postgres`

The `store.mjs` module provides the in-memory seed state and the `nextId()` generator for the memory backend.

### Auth Security Modes

Controlled by `APP_SECURITY_MODE`:
- `local_demo` — accepts seeded bearer tokens from `store.mjs`; no OIDC; no rate limiting
- `secure` — requires OIDC JWT verification; enables security headers, rate limiting, and CORS enforcement; rejects seed tokens unless `AUTH_ALLOW_SEED_TOKENS=true`

### Migrations

Numbered SQL files in `apps/api/migrations/` (e.g. `001_init.sql`, `037_phase1_rbac_foundation.sql`). Many have paired rollback files (`*.rollback.sql`). The migrator (`db/migrator.mjs`) applies them in lexicographic order. Always run against the dev database only.

### Background Jobs (`jobs/`)

Long-running workers started inside `createApp()`:
- `break-glass-expiry.mjs` — expires break-glass sessions
- `retention-purge.mjs` — post-event data retention and anonymization
- `full-export-worker.mjs` — async export generation
- `dsr-worker.mjs` — data subject request fulfillment
- `email-delivery-worker.mjs` — notification delivery via SMTP
- `drive-token-refresh.mjs` — OAuth token refresh for Google/OneDrive

### IoT Layer (`iot/`)

- `mock-server.mjs` / `mock-app.mjs` — simulates the physical NFC device fleet API
- `platform-adapter.mjs` — translates IoT API responses into platform domain objects
- `tap-sync-service.mjs`, `heartbeat-sync-service.mjs`, `incident-sync-service.mjs` — paginated sync with checkpoint persistence
- `contract-certification-runner.mjs` — verifies IoT contract version and environment before go-live
- `integration-orchestrator.mjs` — end-to-end run coordination with persisted step outcomes
- `retention-manager.mjs` — cleans up stale sync history and device snapshots

### Access Control

`access-control.mjs` is the authoritative permission matrix. Every API route must be registered here with its allowed roles and sensitivity level. Tests in `foundation.test.mjs` and `phase5-middleware.test.mjs` assert that no registered route is missing matrix coverage — adding a route without an ACM entry will cause test failures.

### Roles

`platform_admin`, `organizer_admin`, `vendor_manager`, `sponsor_user`, `ops_user`, `device_principal`

## Rules

- Run migrations against dev database only
- Commit after each phase completes successfully
- If a step fails, stop and report — do not skip ahead
- Add new routes to both `routes.mjs` (handler) and `access-control.mjs` (matrix entry) in the same change or tests will fail

## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
| ------ | ---------- |
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.
