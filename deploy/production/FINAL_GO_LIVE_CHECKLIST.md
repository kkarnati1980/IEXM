# Final Go-Live Checklist

Use this checklist immediately before production launch. Do not proceed if any item is blocked.

## 1. Confirm Production Is Healthy

- Open `/ready` and confirm it returns HTTP 200.
- Open `GET /admin/deployment/readiness` and confirm there are zero failed controls.
- Confirm the production environment uses secure mode, OIDC/SSO, Postgres, database TLS verification, rate limiting, security headers, and exact CORS origins.

## 2. Confirm Security Is Ready

- Open `GET /admin/security/readiness` and review warnings or manual gates.
- Open `GET /admin/security/alerts` and investigate high/critical alerts.
- Open `GET /admin/security/pentest/findings` and confirm there are zero blocking high/critical findings.
- Confirm no break-glass session is active unless there is an approved emergency exception.

## 3. Confirm Event Readiness

- Confirm the organizer pilot signoff pack is ready.
- Confirm the joint staging dry run is completed successfully.
- Confirm organizer, platform, and IoT dry-run approvals are recorded.
- Confirm official event reports and exports are frozen where required.

## 4. Record Final Approvals

Record final approval in the platform-admin console for:

- Platform admin.
- Organizer owner.
- Security owner.
- Business owner.

## 5. Export Launch Evidence

- Download the final go-live package from the platform-admin console.
- Save the package with the release ticket, deployment evidence, and pen-test handoff.
- Confirm the exported package says `ready: true`.

## 6. Launch Decision

Proceed only when:

- The final go-live package is ready.
- No blocker remains.
- The on-call owner is available.
- Rollback steps and communication paths are confirmed.

