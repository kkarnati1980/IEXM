# Production Deployment Readiness

Sprint 8 adds explicit deployment checks so production configuration mistakes are visible before go-live.

## Runtime Probes

- `GET /health`: lightweight liveness and app metadata.
- `GET /ready`: deployment readiness probe for container health checks. It returns HTTP 200 only when blocking readiness checks pass.
- `GET /admin/deployment/readiness`: platform-admin detail view with every environment and runtime control.

## Configuration Validation

Run this before staging dry runs and production release:

```bash
npm run api:validate-production-config -- deploy/production/api.env
```

The validator checks:

- secure mode and Postgres backend
- database URL, TLS, and certificate verification
- seed-token disablement
- OIDC/SSO issuer, audience, and client configuration
- security headers, rate limiting, CORS allowlist, body limits, and timeout bounds
- notification provider mode, provider endpoint configuration, authenticated provider webhooks, outbound worker schedule, and bounded retry/dead-letter governance
- IoT release-manifest enforcement and critical alert routing
- export encryption and backup-encryption operational confirmations

## Production Baseline

Production deployment files live in:

- `deploy/production/api.env.example`
- `deploy/production/docker-compose.yml`
- `deploy/production/README.md`

The production compose file assumes a managed Postgres service rather than a local database container.
