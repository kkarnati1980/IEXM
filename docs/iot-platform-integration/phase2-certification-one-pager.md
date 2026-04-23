# Phase 2 Certification One-Pager

Status: Ready to share  
Contract version: `2026-04-17.1`

## Goal
Complete real-environment Phase 2 certification with the IoT team and close Phase 2 only when the live staging integration passes end to end.

## What The IoT Team Must Provide
- staging base URL and credential
- production parity-read base URL and credential
- final endpoint inventory
- machine-readable API contract
- real payload samples for happy paths and edge cases
- error code catalog with retryability rules
- seeded staging devices, assignments, incidents, and replay scenarios
- staging contract version and build version
- production contract version and build version
- named owners for API, staging, incidents, release, and go-live
- promotion and rollback process
- written confirmation that the implementation matches the frozen spec

## What The Platform Team Must Prepare
- platform env config for staging and production parity reads
- approved release manifest
- aligned event, stall, and device records
- organizer/admin access
- alert destinations
- orchestrator, parity, and readiness endpoints/scripts
- issue log and signoff tracking

## Joint Execution Sequence
1. Confirm access and seed data.
2. Confirm release manifest values.
3. Run contract certification.
4. Run tap sync.
5. Run heartbeat sync.
6. Run incident sync.
7. Run device ops sync.
8. Run full orchestrator.
9. Run parity check.
10. Review alerts, health, fleet, and go-live readiness.
11. Assign owners for any blockers.
12. Rerun until blockers are cleared or Phase 2 is explicitly blocked.

## Required Platform Checks
- `GET /organizer/events/:eventId/iot-health`
- `GET /organizer/events/:eventId/iot-alerts`
- `GET /organizer/events/:eventId/device-fleet`
- `GET /organizer/events/:eventId/iot-runs`
- `GET /organizer/events/:eventId/iot-go-live-readiness`
- `POST /organizer/events/:eventId/iot-runs/trigger`
- `POST /organizer/events/:eventId/iot-parity/trigger`

## Blockers
Do not close Phase 2 if any of these are true:
- contract certification fails
- parity check fails
- release manifest is missing or unapproved
- go-live readiness returns blockers
- open critical IoT alerts remain
- required edge-case scenarios are untested

## Ownership Split
IoT team owns:
- API correctness
- payloads, errors, ordering, replay semantics
- device/runtime truth
- staging seed data
- IoT-side fixes

Platform team owns:
- ingestion correctness
- organizer/admin visibility
- alert routing
- parity enforcement
- go-live readiness evaluation
- platform-side fixes

Shared ownership:
- certification execution
- issue triage
- release approval
- pilot go-live signoff

## Success Condition
Phase 2 is complete only when:
- real staging integration passes
- parity passes against approved manifest
- no open critical blockers remain
- organizer go-live readiness has no blockers
- both teams explicitly sign off

## Full References
- [iot-team-handoff-checklist.md](/Users/kishore/Codex%20Development/docs/iot-platform-integration/iot-team-handoff-checklist.md)
- [joint-certification-execution-plan.md](/Users/kishore/Codex%20Development/docs/iot-platform-integration/joint-certification-execution-plan.md)
- [certification-checklist.md](/Users/kishore/Codex%20Development/docs/iot-platform-integration/certification-checklist.md)
