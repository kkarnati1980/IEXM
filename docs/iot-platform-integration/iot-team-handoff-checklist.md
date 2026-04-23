# IoT Team Handoff Checklist

Status: Ready to send  
Contract version: `2026-04-17.1`

## Purpose
This checklist defines the exact package the IoT team must provide so the platform team can complete real-environment Phase 2 certification.

## 1. Environment Access
The IoT team must provide:
- staging base URL
- production base URL
- staging auth credential for platform integration
- production parity-read credential for `/meta/contract`
- IP allowlist requirements, if any
- TLS requirements, if any
- rate limits and timeout expectations

Required values to collect:
- `IOT_BASE_URL`
- `IOT_PRODUCTION_BASE_URL`
- auth scheme
- service account identifier
- credential rotation owner

## 2. Contract Metadata
The IoT team must confirm and provide:
- `contract_version` returned by staging
- `contract_version` returned by production
- `environment` returned by staging
- `environment` returned by production
- `build_version` returned by staging
- `build_version` returned by production
- release/deployment id, if used

Rules:
- staging must return `environment: staging`
- production must return `environment: production`
- no undocumented metadata fields may be required by the platform

## 3. Endpoint Inventory
The IoT team must confirm final availability of:
- `GET /meta/contract`
- tap stream endpoint
- heartbeat stream endpoint
- incident stream endpoint
- device assignment endpoint
- device diagnostics endpoint
- device credential provision endpoint
- device credential revoke endpoint

For each endpoint, provide:
- method
- full path
- auth requirement
- query parameters
- request body schema
- response schema
- error schema
- pagination behavior
- retry behavior
- ordering guarantees
- duplicate/idempotency behavior

## 4. Payload Pack
The IoT team must provide real payload samples for:
- normal tap
- duplicate tap replay
- delayed or offline replay tap
- healthy heartbeat
- degraded heartbeat
- incident open
- incident resolved
- assignment active
- diagnostics response
- credential provision success
- credential revoke success
- invalid cursor error
- device not found error
- assignment scope violation error
- auth failure error
- rate limit error
- downstream unavailable error

Each sample must include:
- exact field names
- enum values
- nullability behavior
- timestamp format
- cursor format
- device, event, and stall identifiers
- assignment checksum format
- error `code`
- error `retryable`
- error `details`

## 5. Staging Seed Data
The IoT team must preload staging with:
- at least 2 active pilot devices
- active assignments mapped to the platform event and stalls
- matching event ids
- matching stall ids
- assignment checksum values
- one degraded diagnostics scenario
- one open incident scenario
- one duplicate tap scenario
- one replay/offline tap scenario

Minimum seed sheet to collect:
- device id
- event id
- stall id
- assignment checksum
- expected scenario type
- expected contract/build version at seed time

## 6. Ownership And Escalation
The IoT team must provide named humans for:
- `IOT_API_OWNER`
- `IOT_DEVICE_RUNTIME_OWNER`
- `IOT_STAGING_OWNER`
- `IOT_INCIDENT_OWNER`
- `IOT_RELEASE_OWNER`
- `IOT_GO_LIVE_COMMANDER`

Also collect:
- escalation channel
- working hours
- first-response SLA
- turnaround expectations for certification blockers

## 7. Release Management Inputs
The IoT team must provide:
- staging build version approved for certification
- production build version approved for parity
- staging contract version approved for certification
- production contract version approved for parity
- production promotion process
- rollback process
- change log for any API-affecting release
- written confirmation that staging was deployed before production

## 8. Written Confirmation Required
The IoT team must explicitly confirm:
- their staging APIs match the frozen contract
- their error catalog matches the agreed error semantics
- their payload pack covers all required happy paths and edge cases
- their staging and production metadata can be used for parity checks
- their named owners are accountable during certification and pilot go-live

## Expected Deliverables From IoT Team
The IoT team handoff is complete only when all of these are received:
1. staging base URL and credentials
2. production base URL and parity-read credentials
3. endpoint inventory
4. machine-readable API contract or OpenAPI
5. real payload pack
6. error code catalog
7. seed data sheet
8. staging contract/build version
9. production contract/build version
10. ownership and escalation contacts
11. promotion and rollback process
12. written spec-conformance confirmation
