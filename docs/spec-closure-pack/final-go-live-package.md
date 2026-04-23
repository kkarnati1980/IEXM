# Final Go-Live Package

Sprint 10 adds the final platform-admin launch gate that ties production deployment readiness, security readiness, external pen-test status, organizer pilot signoff, joint go-live dry-run evidence, and final launch approvals into one exportable package.

## Platform Admin Endpoints

- `GET /admin/events/:eventId/final-go-live`: Builds the final launch package for the event.
- `POST /admin/events/:eventId/final-go-live/approvals`: Records the final launch decision for one required approver role.
- `POST /admin/events/:eventId/final-go-live/export`: Downloads the final launch package JSON for launch evidence.

## Required Approvals

The final package requires all four approval roles to be recorded as `approved`:

- `platform_admin`: Confirms platform, IAM, deployment, and security controls.
- `organizer_owner`: Confirms organizer operational readiness and event ownership.
- `security_owner`: Confirms security, pen-test, audit, and break-glass posture.
- `business_owner`: Confirms business go/no-go, customer, and launch timing approval.

## Blocking Gates

Go-live is blocked when any of these are not complete:

- Production deployment readiness has failed controls.
- Security readiness has failed controls.
- Active high/critical security blockers remain, such as active break-glass, failed readiness controls, or blocking pen-test findings.
- Open, triaged, or in-progress high/critical external pen-test findings remain.
- The organizer pilot signoff pack is not ready.
- The joint staging dry run and organizer/platform/IoT approvals are not complete.
- Any required final approval is missing or rejected.

Historical audit alerts are kept in the evidence pack for investigation, but they do not automatically block launch unless they are represented by an active readiness failure, active break-glass condition, or open high/critical finding.

## Operator Flow

1. Open the platform-admin console.
2. Confirm deployment readiness, security readiness, pen-test findings, and security alerts.
3. Confirm the organizer pilot signoff pack is ready.
4. Confirm the joint go-live dry run and cross-team approvals are ready.
5. Resolve active break-glass sessions and high/critical findings.
6. Record the four final approvals.
7. Download the final go-live package.
8. Keep the exported package with the release record and external pen-test handoff.

## Evidence Included

- Deployment readiness checklist.
- Security readiness checklist.
- Security alerts and investigation context.
- Pen-test finding summary and items.
- Organizer pilot signoff pack.
- Joint go-live execution dry-run evidence.
- Final launch approvals.
- Production runbook links.
- Post-launch monitoring checklist.

