# IoT Interface Control Document

Status: Frozen  
Contract version: `2026-04-17.1`  
Phase: Phase 2, IoT Platform Integration and Certification Phase

## Purpose
This document defines the exact interface the IoT team must deliver and the platform team will consume for Phase 2. It exists to eliminate interpretation drift, undocumented edge behavior, and release-time surprises.

## Scope
The IoT team delivers:
- Android device runtime
- NFC reader and NFC card behavior
- device fleet platform
- normalized IoT APIs defined in [iot-api-contract.yaml](/Users/kishore/Codex%20Development/docs/iot-platform-integration/iot-api-contract.yaml)

The platform team delivers:
- consent, masking, audit, export, analytics, and organizer/vendor/sponsor platform logic
- integration adapters against the IoT APIs
- contract certification and operational acceptance

## Source Of Truth
- The IoT platform is the source of truth for device/runtime state, assignment state, heartbeat state, and device incidents.
- The platform backend is the source of truth for interactions, consent state, PII visibility, exports, metrics, and audit logs.

## Required API Surface
The IoT team must provide the following endpoints under `/iot/v1`:
- `GET /meta/contract`
- `POST /device-credentials/provision`
- `POST /device-credentials/{credentialId}/revoke`
- `GET /devices/{deviceId}/assignment`
- `GET /devices/{deviceId}/diagnostics`
- `GET /streams/taps`
- `GET /streams/heartbeats`
- `GET /streams/incidents`

## Global Rules
- All timestamps must be ISO-8601 UTC with millisecond precision.
- All identifiers are opaque strings and must be preserved exactly as transmitted.
- All responses must include:
  - `contract_version`
  - `environment`
  - `build_version`
- `environment` must be one of `staging` or `production`.
- The IoT team must not silently rename, remove, or reinterpret fields.
- Additive changes are not considered valid until added to the contract pack and versioned.

## Assignment Model
- Exactly one active assignment per device.
- Active assignment must include:
  - `tenant_id`
  - `event_id`
  - `stall_id`
  - `assignment_checksum`
  - `lease_expires_at`
- The `assignment_checksum` is the authoritative assignment fingerprint used by both teams.
- If the device is unassigned, the assignment endpoint must return `404 ASSIGNMENT_NOT_FOUND`.

## Tap Event Model
- Canonical tap classes:
  - `phone_ndef`
  - `card_uid`
  - `qr`
- `local_event_id` is device-generated and unique per device.
- Idempotency key is exactly `(device_id, local_event_id)`.
- IoT platform must preserve original `queue_sequence_number`.
- `delivery_mode` must be one of:
  - `online_single`
  - `offline_replay`
- Tap records are append-only once emitted to the stream.
- For the same `(device_id, local_event_id)`, all duplicated deliveries must be byte-for-byte semantically identical for the tap fields.

## Ordering Rules
- Stream pages must be returned in ascending `stream_cursor` order.
- Within a given device and replay window, items must preserve ascending `queue_sequence_number`.
- The IoT platform may resend already-delivered events after retry or recovery, but it may not reorder events inside the same replay batch.

## Heartbeat Rules
- Heartbeats must carry:
  - assignment identifiers
  - queue depth
  - battery level
  - connectivity state
  - reader state
  - app and firmware versions
- Heartbeats are append-only operational records, not mutable device snapshots.

## Incident Rules
- Incidents must include:
  - severity
  - code
  - message
  - status
  - assignment context if available
  - metadata for diagnosis
- Incident codes must come from the agreed error and incident catalog.

## Diagnostics Rules
- Diagnostics response must provide the current device view used by organizer operations:
  - assignment
  - queue depth
  - last heartbeat
  - connectivity status
  - reader status
  - app version
  - firmware version
  - most recent open incident summary

## Cursor Rules
- `after_cursor` is opaque and consumer-supplied.
- `next_cursor` must be omitted only when the page is terminal and no later records exist.
- `CURSOR_INVALID` and `CURSOR_EXPIRED` behaviors are defined in the error catalog and must be implemented exactly.

## Error Semantics
- Error envelope format is frozen in [error-catalog.md](/Users/kishore/Codex%20Development/docs/iot-platform-integration/error-catalog.md).
- Business rule violations must use cataloged error codes, not free-text-only messages.
- Assignment, version, cursor, and auth failures must be machine-classifiable from the response body.

## Non-Negotiable Edge Cases
The IoT team must implement and certify documented behavior for:
- duplicate local event replay
- delayed offline replay
- out-of-order attempt inside the same replay batch
- stale assignment checksum
- expired lease
- revoked device credential
- missed heartbeat
- reader disconnected
- partial batch retry
- invalid cursor
- staging/production contract mismatch

## Certification Rule
Phase 2 is not complete until the IoT staging environment passes every item in [certification-checklist.md](/Users/kishore/Codex%20Development/docs/iot-platform-integration/certification-checklist.md) using the payloads in [payload-pack](/Users/kishore/Codex%20Development/docs/iot-platform-integration/payload-pack).

