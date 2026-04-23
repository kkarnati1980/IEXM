# Access Control Matrix

The source of truth for route-level access control is `apps/api/src/access-control.mjs`.
Every registered API route must have an entry in `ACCESS_CONTROL_MATRIX`; tests fail if a
route is missing, stale, or has roles that drift from its route definition.

## Roles

- `platform_admin`: tenant-wide platform administration, IAM, emergency access, and platform operations.
- `organizer_admin`: event-scoped live operations, incident handling, compliance, DSR, exports, and pilot signoff.
- `vendor_manager`: stall-scoped lead inbox, notes, classification, CRM sync, and vendor export requests.
- `sponsor_user`: sponsor-organization-scoped aggregate dashboard and sponsor export requests.
- `ops_user`: authenticated platform operations identity reserved for future operational slices.
- `device_principal`: assigned-device ingestion, config, heartbeat, and sync only.

## Enforcement Layers

- Route matrix guard: `enforceAccessControlMatrix` blocks any protected route missing explicit matrix coverage.
- Role gate: matrix roles and route `allowedRoles` must match for protected routes.
- Scope gate: `enforceRoleScope` applies event, stall, sponsor organization, device assignment, and break-glass boundaries.
- Policy gate: `enforcePolicy` applies export policy, consent, CRM eligibility, DSR, and break-glass approval rules.
- Audit gate: sensitive success and denial paths continue to generate audit records.

## Admin Review Endpoint

Platform admins can inspect the runtime matrix through:

- `GET /admin/access-control-matrix`

This endpoint is intended for staging checks, security review, and penetration-test handoff.
