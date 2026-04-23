# Staging Setup

1. Copy [api.env.example](/Users/kishore/Codex%20Development/deploy/staging/api.env.example) to `api.env` and fill in the real OIDC settings.
2. Start the stack:

```bash
docker compose -f deploy/staging/docker-compose.yml up -d --build
```

3. Run migrations and seed once against the staging database:

```bash
docker compose -f deploy/staging/docker-compose.yml exec api node apps/api/src/scripts/migrate.mjs
docker compose -f deploy/staging/docker-compose.yml exec api node apps/api/src/scripts/seed-demo.mjs
```

4. Smoke-test the API:

```bash
curl http://localhost:3000/health
curl -i http://localhost:3000/ready
```

Recommended staging checks:
- confirm `/health` returns `backend: "postgres"`
- confirm `/ready` returns HTTP 200 after real environment values are configured
- run `npm run api:validate-production-config -- deploy/staging/api.env` before the staging dry run
- confirm OIDC login works against `/auth/me`
- confirm device credentials are provisioned before field-device testing
- confirm backups are being written on schedule from the host or CI runner
- confirm `IOT_RELEASE_MANIFEST_PATH` points to an approved manifest copied from [release-manifest.example.json](/Users/kishore/Codex%20Development/deploy/release-manifest.example.json)
- confirm staging and production alert webhook destinations are configured
- confirm `GET /organizer/events/:eventId/iot-go-live-readiness` returns no blockers before pilot go-live
- confirm `GET /organizer/events/:eventId/pilot-signoff-pack` returns ready before issuing the pilot signoff export
- confirm `GET /organizer/events/:eventId/pilot-go-live-execution` is used to record the real staging dry run and the three joint approvals

Pilot-readiness references:
- Runbook: [PILOT_GO_LIVE_RUNBOOK.md](/Users/kishore/Codex%20Development/deploy/staging/PILOT_GO_LIVE_RUNBOOK.md)
- Checklist: [PILOT_GO_LIVE_CHECKLIST.md](/Users/kishore/Codex%20Development/deploy/staging/PILOT_GO_LIVE_CHECKLIST.md)
- Rehearsal runbook: [PILOT_REHEARSAL_RUNBOOK.md](/Users/kishore/Codex%20Development/deploy/staging/PILOT_REHEARSAL_RUNBOOK.md)
- Compliance closeout runbook: [PILOT_COMPLIANCE_CLOSEOUT_RUNBOOK.md](/Users/kishore/Codex%20Development/deploy/staging/PILOT_COMPLIANCE_CLOSEOUT_RUNBOOK.md)
- Downstream integrations runbook: [PILOT_DOWNSTREAM_INTEGRATIONS_RUNBOOK.md](/Users/kishore/Codex%20Development/deploy/staging/PILOT_DOWNSTREAM_INTEGRATIONS_RUNBOOK.md)
- Signoff pack guide: [PILOT_SIGNOFF_PACK.md](/Users/kishore/Codex%20Development/deploy/staging/PILOT_SIGNOFF_PACK.md)
- Joint execution guide: [JOINT_PILOT_SIGNOFF_EXECUTION.md](/Users/kishore/Codex%20Development/deploy/staging/JOINT_PILOT_SIGNOFF_EXECUTION.md)
