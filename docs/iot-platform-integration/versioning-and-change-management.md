# Versioning And Change Management

Status: Frozen  
Contract version: `2026-04-17.1`

## Versioning Model
- Base path major version: `/iot/v1`
- Contract version header/body value: `2026-04-17.1`
- IoT build version: free-form build identifier such as `iot-2026.04.17.3`

## Allowed Change Types
### Additive non-breaking
- new optional response fields
- new optional metadata keys
- internal bug fixes with identical external behavior

Requirements:
- update the changelog
- update the payload pack if examples change
- deploy to staging first
- wait 5 business days before production cutover unless both teams waive in writing

### Breaking
- renamed fields
- removed fields
- changed semantics
- changed enum meaning
- changed idempotency behavior
- changed ordering guarantees
- changed error codes

Requirements:
- new contract version
- new review and signoff
- staging certification rerun
- explicit production cutover plan

## Release Process
1. IoT team proposes a change in writing.
2. Both teams classify it as additive or breaking.
3. The contract pack is updated first.
4. Staging receives the change before production.
5. Platform team reruns certification.
6. Both teams approve production promotion.

## Required Release Manifest
Every staging and production deployment must publish:
- contract version
- build version
- deployment timestamp
- environment
- change summary
- rollback identifier

## Staging Parity Rule
- staging and production must expose the same contract version before pilot go-live
- if staging and production differ, staging certification is invalid

## Risk Controls
### Interpretation drift between teams
- the ICD and API contract are the only authoritative documents
- no Slack clarification is binding unless merged into the contract pack

### Undocumented edge-case behavior
- every edge case must have a payload example or explicit written rule
- no “best effort” behavior is accepted for duplicates, replay, cursoring, assignment, or version checks

### Version mismatch between staging and production
- the platform team must validate `/iot/v1/meta/contract` in both environments before release
- production promotion is blocked if versions differ from the approved manifest

### Ownership confusion during incidents
- every change request and release manifest must identify the primary owner on both teams
- every incident must reference the responsible endpoint owner and release id

