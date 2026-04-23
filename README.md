# Physical-World Interaction Platform

This repository bootstraps the pilot-first implementation of the physical-world interaction platform defined in the master PRD.

What is implemented today:
- Spec Closure Pack with frozen pilot decisions
- OpenAPI v1 and schema v1 artifacts
- Node-based modular monolith foundation for trust, policy, masking, export, audit, and device flows
- Edge runtime primitives for offline queueing, checksums, replay ordering, and corruption detection
- Static seed shells for attendee, kiosk, vendor, sponsor, and organizer interfaces
- Automated tests for idempotency, masking, policy enforcement, break-glass, and queue integrity
- Repository split with `memory` and `postgres` backends
- Postgres adapter, SQL migrations, Docker-based local database setup, and transactional pilot write flows
- Generic OIDC bearer-token verification with local user and scope mapping
- Device credential provisioning, revocation, and last-used tracking
- Local Postgres start/stop/backup automation and a staging Docker deployment scaffold
- Organizer operations for exports, audit, break-glass, incidents, sponsor snapshots, and report freeze
- Phase 5 compliance lifecycle controls for DSR intake/completion, downstream deletion tracking, post-event retention/anonymization, and compliance operational reporting
- Pilot CRM sync workflow with consent-gated lead push, persisted CRM sync records, organizer CRM history, downstream CRM/webhook delete dispatch, and compliance audit export packaging
- Mandatory commercial partner governance for fixed partner types, status-only partner updates, sales pipeline stages, pricing exception approvals, and partner payout lifecycle tracking

What is intentionally deferred:
- Full Android host implementation
- CRM providers beyond the pilot CRM adapter
- Full billing, wallet, and advanced notification features

## Repository Layout

- [docs/spec-closure-pack/README.md](/Users/kishore/Codex%20Development/docs/spec-closure-pack/README.md)
- [docs/requirements-traceability-matrix.md](/Users/kishore/Codex%20Development/docs/requirements-traceability-matrix.md)
- [docs/iot-platform-integration/README.md](/Users/kishore/Codex%20Development/docs/iot-platform-integration/README.md)
- [apps/api/src/server.mjs](/Users/kishore/Codex%20Development/apps/api/src/server.mjs)
- [packages/runtime/src/queue-store.mjs](/Users/kishore/Codex%20Development/packages/runtime/src/queue-store.mjs)
- [apps/web/index.html](/Users/kishore/Codex%20Development/apps/web/index.html)

## Local Commands

```bash
node apps/api/src/server.mjs
node apps/api/src/iot/mock-server.mjs
node apps/api/src/scripts/sync-iot-taps.mjs
node apps/api/src/scripts/sync-iot-heartbeats.mjs
node apps/api/src/scripts/sync-iot-incidents.mjs
node apps/api/src/scripts/sync-iot-device-ops.mjs
node apps/api/src/scripts/run-iot-contract-certification.mjs
node apps/api/src/scripts/run-iot-integration-orchestrator.mjs
node apps/api/src/scripts/run-iot-certification-health.mjs
node apps/api/src/scripts/run-iot-parity-check.mjs
node apps/api/src/scripts/cleanup-iot-operational-data.mjs
node apps/api/src/scripts/migrate.mjs
node apps/api/src/scripts/seed-demo.mjs
node --test apps/api/test/*.test.mjs packages/runtime/test/*.test.mjs
bash scripts/postgres-local-start.sh
bash scripts/postgres-local-stop.sh
bash scripts/postgres-local-backup.sh
```

## Local Postgres Setup

```bash
cp .env.example .env
bash scripts/postgres-local-start.sh
MIGRATOR_DATABASE_URL=postgres://pilot@127.0.0.1:5432/pilot_platform DATABASE_URL=postgres://pilot@127.0.0.1:5432/pilot_platform node apps/api/src/scripts/migrate.mjs
MIGRATOR_DATABASE_URL=postgres://pilot@127.0.0.1:5432/pilot_platform DATABASE_URL=postgres://pilot@127.0.0.1:5432/pilot_platform node apps/api/src/scripts/seed-demo.mjs
REPOSITORY_BACKEND=postgres DATABASE_URL=postgres://pilot@127.0.0.1:5432/pilot_platform node apps/api/src/server.mjs
```

## OIDC and Device Credentials

- Set `APP_SECURITY_MODE=local_demo` for local seeded-token development, or `APP_SECURITY_MODE=secure` for staging/production.
- `AUTH_ALLOW_SEED_TOKENS` defaults to `true` only in `local_demo`; set it to `false` in secure environments so demo bearer tokens are rejected.
- `SESSION_SECRET` is required in secure mode so attendee session signing does not rely on seeded defaults.
- Set `OIDC_ENABLED=true`, `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_CLIENT_ID`, and optionally `OIDC_SCOPES` to accept real user bearer tokens from your identity provider and enable browser PKCE login for the web shells.
- `OIDC_ALLOW_EMAIL_FALLBACK` should remain `false` in secure environments unless you are performing a tightly controlled identity-link migration.
- `SECURITY_HEADERS_ENABLED` and `RATE_LIMITING_ENABLED` default to `true` in secure mode and should remain enabled outside local development.
- Configure `REQUEST_BODY_LIMIT_BYTES`, `REQUEST_TIMEOUT_MS`, and `CORS_ALLOW_ORIGINS` for your deployment boundary.
- When `DATABASE_SSL=true`, `DATABASE_SSL_REJECT_UNAUTHORIZED` should remain `true` in secure environments.
- Users are mapped to local roles through `users.external_identity_provider`, `users.external_subject`, and `user_access_scopes`.
- Browser and API user access is now lifecycle-aware: only `users.status = 'active'` can authenticate, while `pending_invite`, `disabled`, `suspended`, and `deleted` users are denied and audited.
- Successful user authentication updates `users.last_login_at`, which is also surfaced by `GET /auth/me` for smoke checks and future IAM administration.
- Sprint 5 browser auth endpoints are now available for secure-mode web login:
  - `GET /auth/browser-config`
  - `POST /auth/oidc/exchange`
- In `APP_SECURITY_MODE=secure`, the vendor, sponsor, organizer, and platform-admin shells bootstrap from browser-managed OIDC sessions instead of pasted bearer tokens or token-in-URL launch links.
- Platform-admin IAM backend routes are now available for Sprint 3:
  - `GET /admin/reference-data`
  - `GET /admin/access-control-matrix`
  - `GET /admin/security/readiness`
  - `GET /admin/security/alerts`
  - `GET /admin/security/pentest-pack`
  - `GET /admin/security/pentest/attack-surface`
  - `GET /admin/security/pentest/findings`
  - `POST /admin/security/pentest/findings`
  - `PATCH /admin/security/pentest/findings/:findingId`
  - `GET /admin/events/:eventId/final-go-live`
  - `POST /admin/events/:eventId/final-go-live/approvals`
  - `POST /admin/events/:eventId/final-go-live/export`
  - `GET /admin/users`
  - `POST /admin/users`
  - `GET /admin/users/:userId`
  - `PATCH /admin/users/:userId`
  - `POST /admin/users/:userId/activate`
  - `POST /admin/users/:userId/disable`
  - `POST /admin/users/:userId/suspend`
  - `POST /admin/users/:userId/delete`
  - `POST /admin/users/:userId/access-scopes`
  - `DELETE /admin/users/:userId/access-scopes/:scopeId`
- Role-to-organization compatibility is enforced for managed users, and scoped access assignments are validated against the user role before they are saved.
- Sprint 6 access-control coverage is enforced by [docs/spec-closure-pack/access-control-matrix.md](/Users/kishore/Codex%20Development/docs/spec-closure-pack/access-control-matrix.md) and `apps/api/src/access-control.mjs`; tests fail if any registered route is missing matrix coverage or drifts from route role gates.
- Sprint 7 security hardening adds platform-admin security alerts, readiness controls, pen-test evidence export, append-only runtime audit logs, and Postgres TLS certificate verification support. See [docs/spec-closure-pack/security-hardening-and-pentest-readiness.md](/Users/kishore/Codex%20Development/docs/spec-closure-pack/security-hardening-and-pentest-readiness.md).
- Sprint 8 production deployment readiness adds `/ready`, `GET /admin/deployment/readiness`, production env validation, Docker health checks, and a production deployment baseline in [deploy/production/README.md](/Users/kishore/Codex%20Development/deploy/production/README.md).
- Sprint 9 external penetration-testing support adds sanitized server errors, no-store API responses, stricter CORS/content-type/method handling, authorized attack-surface export, and platform-admin pen-test finding tracking. See [docs/spec-closure-pack/external-pentest-support.md](/Users/kishore/Codex%20Development/docs/spec-closure-pack/external-pentest-support.md).
- Sprint 10 final launch readiness adds the platform-admin final go-live package, four-role launch approvals, exportable launch evidence, and production operator checklists. See [docs/spec-closure-pack/final-go-live-package.md](/Users/kishore/Codex%20Development/docs/spec-closure-pack/final-go-live-package.md).
- Deferred/Gap Step 1 commercial partner governance is mandatory production scope and is now covered by [docs/spec-closure-pack/commercial-partner-governance.md](/Users/kishore/Codex%20Development/docs/spec-closure-pack/commercial-partner-governance.md):
  - `GET /admin/commercial/governance`
  - `GET /admin/commercial/partners`
  - `POST /admin/commercial/partners`
  - `PATCH /admin/commercial/partners/:partnerId`
  - `POST /admin/commercial/partners/:partnerId/status-updates`
  - `GET /admin/commercial/deals`
  - `POST /admin/commercial/deals`
  - `PATCH /admin/commercial/deals/:dealId`
  - `GET /admin/commercial/payouts`
  - `POST /admin/commercial/payouts`
  - `PATCH /admin/commercial/payouts/:payoutId`
  - `GET /admin/commercial/approvals`
  - `POST /admin/commercial/approvals`
- Devices can authenticate with seeded test tokens or DB-backed provisioned bearer tokens from:
  - `POST /devices/:deviceId/credentials/provision`
  - `GET /devices/:deviceId/credentials`
  - `POST /devices/:deviceId/credentials/:credentialId/revoke`
- `GET /auth/me` is available as a staging smoke-check for both OIDC and device principals.
- Postgres runtime connections default to `DATABASE_RUNTIME_ROLE=app_runtime`, which is the dedicated role used with tenant security context and selective RLS policies on the most sensitive tables.

## Staging

- API image build: [Dockerfile](/Users/kishore/Codex%20Development/Dockerfile)
- Staging compose stack: [deploy/staging/docker-compose.yml](/Users/kishore/Codex%20Development/deploy/staging/docker-compose.yml)
- Staging env template: [deploy/staging/api.env.example](/Users/kishore/Codex%20Development/deploy/staging/api.env.example)
- Staging runbook: [deploy/staging/README.md](/Users/kishore/Codex%20Development/deploy/staging/README.md)
- Production env template: [deploy/production/api.env.example](/Users/kishore/Codex%20Development/deploy/production/api.env.example)
- Production deployment guide: [deploy/production/README.md](/Users/kishore/Codex%20Development/deploy/production/README.md)
- Final go-live checklist: [deploy/production/FINAL_GO_LIVE_CHECKLIST.md](/Users/kishore/Codex%20Development/deploy/production/FINAL_GO_LIVE_CHECKLIST.md)
- Post-launch monitoring checklist: [deploy/production/POST_LAUNCH_MONITORING.md](/Users/kishore/Codex%20Development/deploy/production/POST_LAUNCH_MONITORING.md)

## Phase 2 Scaffold

- Mock IoT server: [apps/api/src/iot/mock-server.mjs](/Users/kishore/Codex%20Development/apps/api/src/iot/mock-server.mjs)
- Mock IoT app and routes: [apps/api/src/iot/mock-app.mjs](/Users/kishore/Codex%20Development/apps/api/src/iot/mock-app.mjs)
- Platform-side IoT adapter: [apps/api/src/iot/platform-adapter.mjs](/Users/kishore/Codex%20Development/apps/api/src/iot/platform-adapter.mjs)
- Real tap sync service: [apps/api/src/iot/tap-sync-service.mjs](/Users/kishore/Codex%20Development/apps/api/src/iot/tap-sync-service.mjs)
- Real heartbeat sync service: [apps/api/src/iot/heartbeat-sync-service.mjs](/Users/kishore/Codex%20Development/apps/api/src/iot/heartbeat-sync-service.mjs)
- Real incident sync service: [apps/api/src/iot/incident-sync-service.mjs](/Users/kishore/Codex%20Development/apps/api/src/iot/incident-sync-service.mjs)
- Device ops sync service: [apps/api/src/iot/device-ops-sync-service.mjs](/Users/kishore/Codex%20Development/apps/api/src/iot/device-ops-sync-service.mjs)
- Contract certification runner: [apps/api/src/iot/contract-certification-runner.mjs](/Users/kishore/Codex%20Development/apps/api/src/iot/contract-certification-runner.mjs)
- End-to-end integration orchestrator: [apps/api/src/iot/integration-orchestrator.mjs](/Users/kishore/Codex%20Development/apps/api/src/iot/integration-orchestrator.mjs)
- Unified certification and health runner: [apps/api/src/iot/certification-health-runner.mjs](/Users/kishore/Codex%20Development/apps/api/src/iot/certification-health-runner.mjs)
- Alert router: [apps/api/src/iot/alert-router.mjs](/Users/kishore/Codex%20Development/apps/api/src/iot/alert-router.mjs)
- Staging-to-production parity runner: [apps/api/src/iot/environment-parity-runner.mjs](/Users/kishore/Codex%20Development/apps/api/src/iot/environment-parity-runner.mjs)
- Operational retention manager: [apps/api/src/iot/retention-manager.mjs](/Users/kishore/Codex%20Development/apps/api/src/iot/retention-manager.mjs)
- Tap sync runner: [apps/api/src/scripts/sync-iot-taps.mjs](/Users/kishore/Codex%20Development/apps/api/src/scripts/sync-iot-taps.mjs)
- Heartbeat sync runner: [apps/api/src/scripts/sync-iot-heartbeats.mjs](/Users/kishore/Codex%20Development/apps/api/src/scripts/sync-iot-heartbeats.mjs)
- Incident sync runner: [apps/api/src/scripts/sync-iot-incidents.mjs](/Users/kishore/Codex%20Development/apps/api/src/scripts/sync-iot-incidents.mjs)
- Device ops sync runner: [apps/api/src/scripts/sync-iot-device-ops.mjs](/Users/kishore/Codex%20Development/apps/api/src/scripts/sync-iot-device-ops.mjs)
- Contract certification script: [apps/api/src/scripts/run-iot-contract-certification.mjs](/Users/kishore/Codex%20Development/apps/api/src/scripts/run-iot-contract-certification.mjs)
- Integration orchestrator script: [apps/api/src/scripts/run-iot-integration-orchestrator.mjs](/Users/kishore/Codex%20Development/apps/api/src/scripts/run-iot-integration-orchestrator.mjs)
- Certification/health runner: [apps/api/src/scripts/run-iot-certification-health.mjs](/Users/kishore/Codex%20Development/apps/api/src/scripts/run-iot-certification-health.mjs)
- Environment parity script: [apps/api/src/scripts/run-iot-parity-check.mjs](/Users/kishore/Codex%20Development/apps/api/src/scripts/run-iot-parity-check.mjs)
- Operational cleanup script: [apps/api/src/scripts/cleanup-iot-operational-data.mjs](/Users/kishore/Codex%20Development/apps/api/src/scripts/cleanup-iot-operational-data.mjs)
- Fixture loader sourced from the frozen payload pack: [apps/api/src/iot/mock-fixtures.mjs](/Users/kishore/Codex%20Development/apps/api/src/iot/mock-fixtures.mjs)

Organizer ops endpoints now include:
- `GET /organizer/events/:eventId/overview`
- `GET /organizer/events/:eventId/device-fleet`
- `GET /organizer/events/:eventId/iot-health`
- `GET /organizer/events/:eventId/iot-runs`
- `GET /organizer/events/:eventId/iot-alerts`
- `GET /organizer/events/:eventId/iot-go-live-readiness`
- `GET /organizer/events/:eventId/pilot-rehearsal-report`
- `GET /organizer/events/:eventId/pilot-signoff-pack`
- `GET /organizer/events/:eventId/pilot-go-live-execution`
- `POST /organizer/events/:eventId/iot-runs/trigger`
- `POST /organizer/events/:eventId/iot-parity/trigger`
- `POST /organizer/events/:eventId/pilot-signoff-export`
- `POST /organizer/events/:eventId/pilot-go-live-dry-run`
- `POST /organizer/events/:eventId/pilot-go-live-approvals`
- `POST /admin/events/:eventId/iot-runs/trigger`
- `POST /admin/events/:eventId/iot-cleanup/trigger`

Failure hardening now includes:
- retryable vs terminal failure classification recorded on each stream checkpoint
- checkpoint pinning to page-start on partial-page failures
- repeated stream failure and repeated assignment mismatch escalation in IoT health warnings
- persisted certification-pack results in organizer-visible contract status
- persisted end-to-end orchestration run history with per-step outcomes and latest-run visibility
- persisted failed/critical alert routing with optional webhook delivery hooks
- persisted staging-to-production parity status before pilot go-live
- cleanup policies for old run history, alert records, parity states, and stale device snapshots
- environment-aware alert escalation destinations for staging, production, parity, and critical paths
- release-manifest enforcement on parity checks before pilot go-live
- organizer-readable go-live readiness checklist tied directly to current health, parity, alerts, and latest-run state
- pilot rehearsal evidence report tying incident response, break-glass, export control, privacy, and report-freeze exercises into a single organizer readiness gate
- pilot signoff pack that aggregates IoT go-live readiness, rehearsal evidence, compliance closeout readiness, and official report-freeze state into one exportable organizer signoff artifact
- joint go-live execution tracking for the real staging dry run plus organizer/platform/IoT approvals before final pilot release

## Phase 5 Compliance

Organizer compliance endpoints now include:
- `GET /organizer/events/:eventId/compliance`
- `GET /organizer/events/:eventId/compliance/report`
- `GET /organizer/events/:eventId/compliance/closeout-readiness`
- `GET /organizer/events/:eventId/crm-sync`
- `GET /organizer/events/:eventId/dsr`
- `POST /organizer/events/:eventId/dsr`
- `POST /organizer/events/:eventId/dsr/:requestId/complete`
- `POST /organizer/events/:eventId/downstream-deletions/:recordId`
- `POST /organizer/events/:eventId/downstream-deletions/:recordId/dispatch`
- `POST /organizer/events/:eventId/compliance/audit-export`
- `POST /organizer/events/:eventId/compliance/retention`

Pilot CRM endpoints now include:
- `POST /interactions/:interactionId/crm-sync`

Phase 5 lifecycle behavior now includes:
- access-request packaging for event-scoped data subject requests
- delete-request fulfillment with event interaction anonymization and downstream deletion tracking
- consent-aware CRM lead sync with stable external record ids for deletion propagation
- organizer-triggered downstream CRM and webhook deletion dispatch from the DSR queue
- organizer CRM activity/history visibility for synced, pending-delete, and deleted leads
- retention-aware local cleanup of CRM sync artifacts after post-event anonymization
- retention preview and apply flows with compliance-run history
- compliance operational reporting for DSR throughput, downstream failures, CRM sync state, retention history, and audit activity
- post-event compliance audit export generation through the standard export approval/download flow
- compliance closeout readiness gating with blockers, warnings, runbook links, and recommended operator actions
- event archival and export expiry during post-event retention apply

Pilot-readiness artifacts:
- Release manifest template: [deploy/release-manifest.example.json](/Users/kishore/Codex%20Development/deploy/release-manifest.example.json)
- Pilot go-live runbook: [deploy/staging/PILOT_GO_LIVE_RUNBOOK.md](/Users/kishore/Codex%20Development/deploy/staging/PILOT_GO_LIVE_RUNBOOK.md)
- Pilot go-live checklist: [deploy/staging/PILOT_GO_LIVE_CHECKLIST.md](/Users/kishore/Codex%20Development/deploy/staging/PILOT_GO_LIVE_CHECKLIST.md)
- Pilot rehearsal runbook: [deploy/staging/PILOT_REHEARSAL_RUNBOOK.md](/Users/kishore/Codex%20Development/deploy/staging/PILOT_REHEARSAL_RUNBOOK.md)
- Pilot compliance closeout runbook: [deploy/staging/PILOT_COMPLIANCE_CLOSEOUT_RUNBOOK.md](/Users/kishore/Codex%20Development/deploy/staging/PILOT_COMPLIANCE_CLOSEOUT_RUNBOOK.md)
- Pilot downstream integrations runbook: [deploy/staging/PILOT_DOWNSTREAM_INTEGRATIONS_RUNBOOK.md](/Users/kishore/Codex%20Development/deploy/staging/PILOT_DOWNSTREAM_INTEGRATIONS_RUNBOOK.md)
- Pilot signoff pack guide: [deploy/staging/PILOT_SIGNOFF_PACK.md](/Users/kishore/Codex%20Development/deploy/staging/PILOT_SIGNOFF_PACK.md)
- Joint pilot signoff execution guide: [deploy/staging/JOINT_PILOT_SIGNOFF_EXECUTION.md](/Users/kishore/Codex%20Development/deploy/staging/JOINT_PILOT_SIGNOFF_EXECUTION.md)

Example Phase 2 local flow:

```bash
node apps/api/src/iot/mock-server.mjs
IOT_BASE_URL=http://127.0.0.1:4010 \
IOT_EXPECTED_CONTRACT_VERSION=2026-04-17.1 \
IOT_EXPECTED_ENVIRONMENT=staging \
node apps/api/src/scripts/sync-iot-taps.mjs

IOT_BASE_URL=http://127.0.0.1:4010 \
IOT_EXPECTED_CONTRACT_VERSION=2026-04-17.1 \
IOT_EXPECTED_ENVIRONMENT=staging \
node apps/api/src/scripts/sync-iot-heartbeats.mjs

IOT_BASE_URL=http://127.0.0.1:4010 \
IOT_EXPECTED_CONTRACT_VERSION=2026-04-17.1 \
IOT_EXPECTED_ENVIRONMENT=staging \
node apps/api/src/scripts/sync-iot-incidents.mjs

IOT_BASE_URL=http://127.0.0.1:4010 \
IOT_EXPECTED_CONTRACT_VERSION=2026-04-17.1 \
IOT_EXPECTED_ENVIRONMENT=staging \
IOT_SYNC_TENANT_ID=tenant-demo \
IOT_SYNC_EVENT_ID=event-demo \
node apps/api/src/scripts/sync-iot-device-ops.mjs

IOT_BASE_URL=http://127.0.0.1:4010 \
IOT_EXPECTED_CONTRACT_VERSION=2026-04-17.1 \
IOT_EXPECTED_ENVIRONMENT=staging \
node apps/api/src/scripts/run-iot-contract-certification.mjs

IOT_BASE_URL=http://127.0.0.1:4010 \
IOT_EXPECTED_CONTRACT_VERSION=2026-04-17.1 \
IOT_EXPECTED_ENVIRONMENT=staging \
IOT_SYNC_TENANT_ID=tenant-demo \
IOT_SYNC_EVENT_ID=event-demo \
IOT_TRIGGER_MODE=manual \
IOT_INITIATED_BY=local-operator \
node apps/api/src/scripts/run-iot-integration-orchestrator.mjs

IOT_BASE_URL=http://127.0.0.1:4010 \
IOT_EXPECTED_CONTRACT_VERSION=2026-04-17.1 \
IOT_EXPECTED_ENVIRONMENT=staging \
IOT_SYNC_TENANT_ID=tenant-demo \
IOT_SYNC_EVENT_ID=event-demo \
IOT_CERT_STALE_AFTER_SECONDS=900 \
IOT_STREAM_STALE_TAPS_SECONDS=900 \
IOT_STREAM_STALE_HEARTBEATS_SECONDS=300 \
IOT_STREAM_STALE_INCIDENTS_SECONDS=900 \
IOT_REPEATED_FAILURE_THRESHOLD=3 \
IOT_REPEATED_MISMATCH_THRESHOLD=3 \
node apps/api/src/scripts/run-iot-certification-health.mjs

IOT_BASE_URL=http://127.0.0.1:4010 \
IOT_PRODUCTION_BASE_URL=http://127.0.0.1:4011 \
IOT_EXPECTED_CONTRACT_VERSION=2026-04-17.1 \
IOT_PRODUCTION_EXPECTED_CONTRACT_VERSION=2026-04-17.1 \
IOT_SYNC_TENANT_ID=tenant-demo \
IOT_SYNC_EVENT_ID=event-demo \
node apps/api/src/scripts/run-iot-parity-check.mjs

IOT_SYNC_TENANT_ID=tenant-demo \
IOT_SYNC_EVENT_ID=event-demo \
node apps/api/src/scripts/cleanup-iot-operational-data.mjs
```
