# Pilot Compliance Closeout Runbook

## Objective
Use the organizer compliance surfaces to complete post-event privacy operations, confirm downstream deletion status, and produce the audit-ready compliance package for pilot closeout.

## Preconditions
- The event is the correct target event and organizer access is working.
- DSR requests for the event have been reviewed and triaged.
- Pilot CRM and webhook downstream integrations are reachable for deletion dispatch.
- [PILOT_DOWNSTREAM_INTEGRATIONS_RUNBOOK.md](/Users/kishore/Codex%20Development/deploy/staging/PILOT_DOWNSTREAM_INTEGRATIONS_RUNBOOK.md) is available to the operator on call.

## Operator Flow
1. Review compliance overview.
   Use `GET /organizer/events/:eventId/compliance` and confirm DSR, downstream deletion, and CRM sync counts match operator expectations.
2. Review operational compliance reporting.
   Use `GET /organizer/events/:eventId/compliance/report` and capture:
   - open DSR totals
   - pending or failed downstream deletions
   - CRM sync status mix
   - latest retention run state
   - recent compliance audit entries
3. Clear DSR blockers.
   Complete any remaining DSR requests and confirm all delete workflows have the correct downstream targets queued.
4. Dispatch pending downstream deletions.
   Use `POST /organizer/events/:eventId/downstream-deletions/:recordId/dispatch` until pending records are resolved or escalated.
5. Run retention preview.
   Use `POST /organizer/events/:eventId/compliance/retention` with `mode=preview` and review the interaction/profile/export/CRM scrub counts.
6. Apply retention when approved.
   Close the event first, then run `POST /organizer/events/:eventId/compliance/retention` with `mode=apply`.
7. Request the compliance audit export.
   Use `POST /organizer/events/:eventId/compliance/audit-export`, approve it if required, then download the generated export from `/exports/:exportId/download`.

## Required Evidence
- Screenshot or capture of `GET /organizer/events/:eventId/compliance/report`
- Export id and download timestamp for the compliance audit export
- Count of unresolved downstream deletions, if any
- Retention preview or apply run id

## Hard Stop Conditions
- Any delete DSR remains incomplete without a documented exception
- Any downstream deletion remains failed without an active escalation owner
- Retention apply would run before legal/ops approval
- Compliance audit export cannot be generated or downloaded

## Signoff
- Organizer operations owner confirms event closeout status
- Compliance/privacy owner confirms retention and DSR posture
- Integration owner confirms downstream deletion state
