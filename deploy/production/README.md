# Production Deployment Readiness

This folder contains the production deployment baseline. It intentionally does not include a database container because production should use a managed Postgres instance with encrypted storage, backups, TLS, and restricted network access.

## Step-By-Step

1. Copy `deploy/production/api.env.example` to `deploy/production/api.env`.
2. Replace every placeholder with real values from your identity provider, managed database, alert routing, and secret manager.
3. Validate the environment file before starting the service:

```bash
npm run api:validate-production-config -- deploy/production/api.env
```

4. Run database migrations from a trusted deployment runner:

```bash
DATABASE_URL=postgres://... DATABASE_SSL=true DATABASE_SSL_REJECT_UNAUTHORIZED=true npm run api:migrate
```

5. Start the service:

```bash
docker compose -f deploy/production/docker-compose.yml up -d --build
```

This starts both the API and the scheduled outbound notification worker.

6. Confirm the deployment probe is healthy:

```bash
curl -i https://your-api-host.example.com/ready
```

7. Sign in as a platform admin and inspect:

- `GET /admin/deployment/readiness`
- `GET /admin/security/readiness`
- `GET /admin/security/alerts`
- `GET /admin/security/pentest-pack`
- `GET /admin/security/pentest/attack-surface`
- `GET /admin/security/pentest/findings`
- `GET /admin/events/:eventId/final-go-live`

## Required Production Controls

- Use `APP_SECURITY_MODE=secure`.
- Use `OIDC_ENABLED=true`; do not use local/demo bearer tokens.
- Use `AUTH_ALLOW_SEED_TOKENS=false`.
- Use managed Postgres with `DATABASE_SSL=true` and `DATABASE_SSL_REJECT_UNAUTHORIZED=true`.
- Keep `DATABASE_RUNTIME_ROLE=app_runtime`.
- Keep `SECURITY_HEADERS_ENABLED=true` and `RATE_LIMITING_ENABLED=true`.
- Use exact HTTPS origins in `CORS_ALLOW_ORIGINS`; never use `*`.
- Use KMS/Vault/Secret Manager for `SESSION_SECRET` and database credentials.
- Configure real notification provider endpoints and secrets for every enabled outbound channel.
- Configure authenticated provider webhooks for enabled channels using shared-secret or HMAC validation.
- Keep `NOTIFICATION_WORKER_ENABLED=true` with explicit tenant scope and bounded interval/batch settings.
- Set bounded notification retry governance values: `NOTIFICATION_MAX_ATTEMPTS`, `NOTIFICATION_RETRY_DELAY_MINUTES`, and `NOTIFICATION_DEAD_LETTER_ALERT_THRESHOLD`.
- Confirm encrypted backups and export artifact encryption before production data is used.

## Production Go/No-Go

Go-live should not proceed until:

- `/ready` returns HTTP 200.
- `/admin/deployment/readiness` has zero failed controls.
- `/admin/security/readiness` has no unresolved high-risk warnings.
- `/admin/security/alerts` has no unexplained critical/high alerts.
- `/admin/security/pentest/findings` has zero blocking high/critical findings unless formally accepted by the accountable owner.
- The pilot signoff/go-live pack is ready.
- `GET /admin/events/:eventId/final-go-live` returns `ready: true`.
- External penetration testing is scheduled after final production testing.

## Operator Checklists

- Final go-live checklist: `deploy/production/FINAL_GO_LIVE_CHECKLIST.md`
- Post-launch monitoring checklist: `deploy/production/POST_LAUNCH_MONITORING.md`
