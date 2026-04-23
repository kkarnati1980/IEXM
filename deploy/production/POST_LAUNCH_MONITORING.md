# Post-Launch Monitoring

Use this checklist during the first 72 hours after production launch.

## First 1 Hour

- Watch `/ready` continuously.
- Watch API error rate, latency, and container restarts.
- Confirm platform-admin login through OIDC/SSO.
- Confirm organizer, sponsor, vendor, and device flows still authenticate correctly.
- Confirm no active break-glass session remains from launch testing.

## First 24 Hours

- Review `/admin/security/alerts` every hour.
- Review `/admin/security/pentest/findings` for any newly accepted or reopened item.
- Review IoT health, device heartbeat, assignment mismatch, and critical alert queues every hour during event opening.
- Confirm exports, audit log viewer, DSR, retention, and downstream deletion paths remain operational.
- Confirm sponsor snapshots and organizer exports are available only to expected roles and scopes.

## First 72 Hours

- Run a formal 24-hour launch review.
- Run a formal 72-hour launch review before declaring steady state.
- Confirm production backup encryption and retention evidence.
- Confirm no unexpected user lifecycle, IAM scope, break-glass, or export activity occurred.
- Prepare the external penetration testing handoff if it has not already been completed.

## Escalation Rules

- Critical security alert: stop non-essential launch activity and notify the security owner.
- High/critical pen-test finding: triage, remediate, verify, or record accepted risk before continuing expansion.
- Active break-glass without current incident: revoke and investigate.
- Failed `/ready`: start rollback or incident response immediately.

