# Pilot Rehearsal Runbook

## Objective
Exercise the highest-risk organizer workflows before pilot go-live and verify that the platform recorded evidence for each rehearsal scenario.

## Required Rehearsal Scenarios
1. Trigger an incident response flow.
   - escalate or resolve an incident from organizer operations
   - save runbook/workaround tracking on the incident
2. Exercise controlled export handling.
   - request and approve at least one export
3. Exercise break-glass approval.
   - request break-glass access
   - complete the approval chain
4. Exercise privacy workflows.
   - complete one access DSR
   - complete one delete DSR
   - dispatch at least one downstream deletion
5. Exercise report-freeze and compliance reporting.
   - freeze the official report
   - request and approve the compliance audit export

## Evidence Review
- Open `GET /organizer/events/:eventId/pilot-rehearsal-report`
- Confirm the rehearsal checklist is fully passed
- Confirm there are no unresolved rehearsal incidents remaining
- Confirm the latest compliance audit export is generated

## Hard Stop Conditions
- rehearsal report returns `ready: false`
- any rehearsal-critical workflow was not exercised
- unresolved rehearsal incidents remain open
- compliance audit export was not generated

## Operator Follow-up
- If blocked, resolve the missing checklist items and refresh the rehearsal report
- When ready, move to the pilot go-live review using [PILOT_GO_LIVE_RUNBOOK.md](/Users/kishore/Codex%20Development/deploy/staging/PILOT_GO_LIVE_RUNBOOK.md)
