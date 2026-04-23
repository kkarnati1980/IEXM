# Pilot Downstream Integrations Runbook

## Objective
Provide a single operator path for CRM and webhook deletion dispatch, retry handling, evidence capture, and escalation during post-event privacy workflows.

## Covered Integrations
- Pilot CRM deletion dispatch
- Webhook downstream deletion dispatch

## Standard Dispatch Flow
1. Open the event DSR queue in organizer operations.
2. Confirm the request is a delete workflow with the correct interaction or attendee subject.
3. Verify each downstream deletion record has the expected `target_system`.
4. Dispatch from organizer operations or call `POST /organizer/events/:eventId/downstream-deletions/:recordId/dispatch`.
5. Confirm the record status becomes `confirmed`.

## CRM Delete Dispatch
- Expected outcome:
  - downstream deletion record moves to `confirmed`
  - linked CRM sync record moves to `deleted`
  - CRM response payload is stored as deletion evidence
- If the CRM delete fails:
  - capture the downstream deletion record id
  - capture `last_error`
  - do not manually mark the CRM sync record deleted
  - escalate to the integration owner

## Webhook Delete Dispatch
- Expected outcome:
  - downstream deletion record moves to `confirmed`
  - `details.deletion_response.delivery_status` is `delivered`
- If the webhook dispatch fails:
  - capture the downstream deletion record id
  - capture `last_error`
  - confirm whether the receiving system has its own retry buffer
  - escalate if the failure remains after one controlled retry

## Retry Guidance
- Retry only when the failure is operational and transient.
- Do not retry blindly if the target system rejected the payload as invalid.
- Before retrying, confirm the subject interaction and external record id are still correct.

## Evidence To Capture
- Event id
- DSR request id
- Downstream deletion record id
- Target system
- Dispatch timestamp
- Response payload or error message
- Operator who performed the dispatch

## Escalation
- CRM failures:
  - platform integration owner
  - CRM integration owner
- Webhook failures:
  - platform integration owner
  - downstream receiving-system owner
- Include:
  - event id
  - request id
  - downstream deletion record id
  - target system
  - latest error
