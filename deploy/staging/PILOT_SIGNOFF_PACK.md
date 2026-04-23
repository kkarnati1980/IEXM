# Pilot Signoff Pack

Use the pilot signoff pack as the last organizer-facing release gate before approving the pilot event for go-live.

## Required gates

- IoT go-live readiness must be clear:
  - `GET /organizer/events/:eventId/iot-go-live-readiness`
- Pilot rehearsal evidence must be complete:
  - `GET /organizer/events/:eventId/pilot-rehearsal-report`
- Compliance closeout readiness must be clear:
  - `GET /organizer/events/:eventId/compliance/closeout-readiness`
- Official report package must be frozen and generated:
  - `GET /organizer/events/:eventId/report-freeze`

## Organizer workflow

1. Open `GET /organizer/events/:eventId/pilot-signoff-pack`.
2. Confirm the signoff pack shows `ready: true`.
3. Review blockers, warnings, and the section summaries for IoT, rehearsal, and compliance.
4. Request the pilot signoff export:
   - `POST /organizer/events/:eventId/pilot-signoff-export`
5. Approve the export through the standard export queue if approval is required.
6. Download and archive the generated signoff artifact:
   - `GET /exports/:exportId/download`

## Expected artifact

The exported `pilot_signoff` package should contain:

- overall signoff status
- grouped section status for IoT go-live, rehearsal, and compliance closeout
- current blockers and warnings
- report-freeze summary
- runbook links used during the signoff review

## Do not sign off if

- any IoT go-live blocker remains
- rehearsal evidence is incomplete
- compliance closeout is still blocked
- the official report package is not yet frozen/generated
- the latest signoff export cannot be generated or downloaded
