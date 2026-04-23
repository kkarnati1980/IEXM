# Phase 2 Certification Checklist

Status: Frozen  
Contract version: `2026-04-17.1`

Phase 2 is complete only when every item below is marked pass in staging.

## Contract
- `/meta/contract` returns the approved contract version
- all required endpoints exist
- all required fields match the API contract
- all documented error codes match the catalog

## Assignment
- active assignment response returns correct `tenant_id`, `event_id`, `stall_id`, and `assignment_checksum`
- unassigned device returns `ASSIGNMENT_NOT_FOUND`
- stale or mismatched assignment behavior is consistent with the contract

## Taps
- online single `card_uid` tap is available in the tap stream
- offline replay `phone_ndef` tap preserves `queue_sequence_number`
- duplicate `(device_id, local_event_id)` remains deduplicable and semantically identical
- tap pages return ascending `stream_cursor` order

## Heartbeats
- healthy heartbeat is available in stream
- degraded heartbeat is available in stream
- queue depth, battery, connectivity, reader state, app version, and firmware version are present

## Incidents
- reader disconnect incident is available in stream
- incident severity and code match catalog
- resolved incident includes `resolved_at`

## Versioning And Environment
- staging environment reports `environment: staging`
- build version is present
- no undocumented staging-only behavior exists

## Operational
- diagnostics endpoint reflects current assignment and device health
- owner handles are mapped to real humans in the shared contact sheet
- staging credentials work from the platform environment

