# Staging Access And Owners

Status: Frozen  
Contract version: `2026-04-17.1`

## Staging Access Package
The IoT team must provide the following staging access package before Phase 2 implementation begins:
- base URL: `https://iot-staging.example.com/iot/v1`
- environment identifier: `staging`
- service account identifier for platform integration
- bearer token or equivalent machine credential
- IP allowlist requirements, if any
- TLS certificate chain details, if non-public trust is required
- `/meta/contract` endpoint enabled
- seeded staging devices, assignments, and incidents matching the payload pack

## Minimum Staging Data Set
- 2 active devices on `event-demo`
- 1 device assigned to `stall-a1`
- 1 device assigned to `stall-a2`
- 1 online heartbeat example
- 1 degraded heartbeat example
- 1 duplicate tap replay scenario
- 1 reader disconnect incident

## Owner Matrix
Actual human names are not available in this repo, so the ownership contract is frozen as stable owner handles. Each handle must resolve to one named human before first joint staging cutover.

### Platform team owner handles
| Owner handle | Responsibility |
| --- | --- |
| `PLATFORM_INT_OWNER` | Primary owner for IoT API integration, certification, and contract decisions on platform side |
| `PLATFORM_BACKEND_OWNER` | Platform adapter implementation, ingestion correctness, and domain mapping |
| `PLATFORM_SRE_OWNER` | Staging environment, deploy health, and observability |
| `PLATFORM_PRODUCT_OWNER` | Requirement arbitration and signoff on behavioral changes |

### IoT team owner handles
| Owner handle | Responsibility |
| --- | --- |
| `IOT_API_OWNER` | Primary owner for the IoT API contract implementation |
| `IOT_DEVICE_RUNTIME_OWNER` | Android, reader, card, and runtime behavior owner |
| `IOT_STAGING_OWNER` | IoT staging environment and seed data owner |
| `IOT_INCIDENT_OWNER` | First responder for live device/runtime or IoT platform incidents |

## Incident Ownership Rules
- If `/streams/*` responses are malformed or incomplete: `IOT_API_OWNER`
- If assignment or device runtime state is wrong at source: `IOT_DEVICE_RUNTIME_OWNER`
- If platform ingestion, consent, masking, export, or audit behavior is wrong: `PLATFORM_BACKEND_OWNER`
- If deployment, connectivity, or environment routing is wrong: `PLATFORM_SRE_OWNER` and `IOT_STAGING_OWNER`

## Escalation Order
1. Primary endpoint owner
2. Team staging/ops owner
3. Team product/decision owner
4. Joint go-live commander during pilot rehearsal or live event

## First-Response SLA
- P0: 15 minutes
- P1: 30 minutes
- P2: 4 business hours
- P3: next business day

