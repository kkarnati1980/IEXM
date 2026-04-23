# Pilot Go-Live Runbook

## Objective
Use the platform endpoints and scripts to prove that the IoT integration is release-ready before the live pilot.

## Preconditions
- [api.env.example](/Users/kishore/Codex%20Development/deploy/staging/api.env.example) is populated for staging
- [release-manifest.example.json](/Users/kishore/Codex%20Development/deploy/release-manifest.example.json) has been copied to a real manifest path and approved
- staging and production IoT endpoints are reachable from the platform environment

## Operator Flow
1. Run the integration orchestrator.
   Use `POST /organizer/events/:eventId/iot-runs/trigger` or `node apps/api/src/scripts/run-iot-integration-orchestrator.mjs`
2. Run the parity check.
   Use `POST /organizer/events/:eventId/iot-parity/trigger` or `node apps/api/src/scripts/run-iot-parity-check.mjs`
3. Review health and alerts.
   Confirm `GET /organizer/events/:eventId/iot-health` and `GET /organizer/events/:eventId/iot-alerts`
4. Review go-live readiness.
   Confirm `GET /organizer/events/:eventId/iot-go-live-readiness`
5. If blocked, resolve issues and rerun the integration orchestration and parity checks.

## Hard Stop Conditions
- go-live readiness returns `ready: false`
- any open critical alert remains
- parity status is `failed`
- health status is `critical`, `failed`, or stale
- latest orchestrator run is `failed`

## Escalation
- staging alert destination: staging owner + platform integration owner
- production/parity alert destination: production owner + joint go-live commander
- every escalation must reference:
  - `release_id`
  - `event_id`
  - `latest_run.id`
  - blocking alert code or parity issue code
