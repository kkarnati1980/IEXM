# Joint Certification Execution Plan

Status: Ready to execute  
Contract version: `2026-04-17.1`

## Objective
This plan defines the joint scope of work for the platform team and IoT team to complete real-environment Phase 2 certification and close Phase 2 formally.

## Success Criteria
Phase 2 is complete only when:
- real IoT staging is integrated into the platform
- contract certification passes
- stream ingestion passes for taps, heartbeats, and incidents
- device ops reconciliation passes
- staging-to-production parity passes against the approved release manifest
- `GET /organizer/events/:eventId/iot-go-live-readiness` returns no blockers

## Team Responsibilities

### Platform Team
Owns:
- platform-side env configuration
- release manifest setup
- organizer/admin runtime access
- event and stall alignment in platform DB
- adapter/orchestrator/parity execution
- alert routing
- go-live readiness evaluation
- issue logging and signoff tracking

### IoT Team
Owns:
- API correctness
- payload correctness
- cursor/order/retry semantics
- device/runtime truth
- staging seed data
- staging and production metadata correctness
- IoT-side fixes during certification

### Shared Ownership
- contract validation
- seed data alignment
- failure scenario execution
- release approval
- pilot go-live signoff

## Workstreams

### Workstream 1: Access And Alignment
Platform team:
- configure staging base URL and credentials
- configure production parity-read base URL and credentials
- load release manifest
- confirm organizer/admin accounts are working

IoT team:
- provide staging access
- provide production parity-read access
- provide seed data sheet
- confirm owner matrix and escalation channel

Joint output:
- access verified
- seed ids aligned
- manifest values aligned

### Workstream 2: Contract Validation
Platform team:
- run contract certification against real staging
- compare returned metadata against manifest and ICD

IoT team:
- validate any response mismatch
- explain any undocumented field or behavior immediately

Joint output:
- contract certification pass
- issue log for any mismatch

### Workstream 3: Stream Certification
Platform team:
- run tap sync
- run heartbeat sync
- run incident sync
- validate organizer views

IoT team:
- monitor source payloads
- verify ordering and duplicate behavior
- verify seed data produced the expected scenarios

Joint output:
- ingestion verified end to end
- stream-level issues either fixed or logged with owner

### Workstream 4: Device Ops Certification
Platform team:
- run device ops sync
- validate assignment reconciliation
- validate diagnostics and incident visibility

IoT team:
- confirm assignment checksum truth
- confirm diagnostics and incident semantics

Joint output:
- organizer fleet/device view matches IoT truth

### Workstream 5: Failure-Path Certification
Run together:
- duplicate tap replay
- delayed/offline replay
- invalid cursor
- retryable downstream failure
- assignment mismatch
- degraded diagnostics
- open incident
- parity mismatch
- manifest mismatch
- alert delivery routing

Joint output:
- all required failure cases executed
- expected platform behavior confirmed

### Workstream 6: Pilot Readiness Gate
Platform team:
- run orchestrator
- run parity check
- review alerts
- review go-live readiness endpoint

IoT team:
- confirm approved release metadata
- confirm on-call readiness
- confirm rollback and escalation readiness

Joint output:
- final Phase 2 certification pass or blocker list

## Exact Execution Sequence
1. Confirm access and seed data.
2. Confirm release manifest values.
3. Run contract certification.
4. Run tap sync.
5. Run heartbeat sync.
6. Run incident sync.
7. Run device ops sync.
8. Run full orchestrator.
9. Run parity check.
10. Review alerts.
11. Review organizer device fleet.
12. Review organizer IoT health.
13. Review organizer go-live readiness.
14. Record pass/fail and owners for every open issue.

## Evidence To Capture
For each run, capture:
- timestamp
- environment
- contract version
- build version
- event id
- latest run id
- parity status
- go-live readiness result
- open critical alerts
- owner assigned for any failure

## Blocking Conditions
Do not close Phase 2 if any of these are true:
- contract certification fails
- parity check fails
- release manifest is missing or unapproved
- organizer go-live readiness has blockers
- any open critical alert remains
- a required edge case is untested

## Recommended Working Session Structure
Day 1:
- access, seed alignment, contract validation

Day 2:
- stream certification, device ops certification, organizer ops review

Day 3:
- failure-path certification, parity, go-live readiness, signoff decision

## Final Outputs
At the end of the joint certification sprint, produce:
- certification result summary
- open issues with owners
- approved release id
- signoff decision
- explicit statement:
  - `Phase 2 complete`
  - or `Phase 2 blocked` with reasons
