import { createRouter } from "./router.mjs";
import { createSeedState } from "./store.mjs";
import { nextId } from "./store.mjs";
import { registerRoutes } from "./routes.mjs";
import { HttpError } from "./http-error.mjs";
import { enforcePolicy, enforceRoleScope } from "./policy.mjs";
import { enforceAccessControlMatrix } from "./access-control.mjs";
import { maskResponse } from "./masking.mjs";
import { createRepositories } from "./repositories.mjs";
import { createPostgresDatabase } from "./db/postgres.mjs";
import { createOidcVerifier } from "./auth/oidc.mjs";
import { buildDevicePrincipal, buildUserPrincipal } from "./auth/principals.mjs";
import { hashDeviceCredentialToken } from "./device-credentials.mjs";
import { createIotOperationsRuntime } from "./iot/runtime.mjs";

export async function createApp(options = {}) {
  const router = createRouter();
  registerRoutes(router);
  const state = options.state ?? createSeedState();
  const securityMode = resolveSecurityMode(options);
  const sessionSecret = resolveSessionSecret(options, state, securityMode);
  state.sessionSecret = sessionSecret;
  const backend = options.backend ?? process.env.REPOSITORY_BACKEND ?? "memory";
  const databaseSsl = options.databaseSsl ?? process.env.DATABASE_SSL === "true";
  const databaseSslRejectUnauthorized = resolveDatabaseSslRejectUnauthorized(options, securityMode);
  const db =
    backend === "postgres"
      ? await createPostgresDatabase({
          connectionString: options.databaseUrl ?? process.env.DATABASE_URL,
          ssl: databaseSsl,
          sslRejectUnauthorized: databaseSslRejectUnauthorized
        })
      : null;
  const repos = createRepositories({ backend, state, db });
  const allowSeedTokens = resolveAllowSeedTokens(options, securityMode);
  const securityHeadersEnabled = resolveSecurityHeadersEnabled(options, securityMode);
  const defaultResponseHeaders = buildDefaultResponseHeaders({
    enabled: securityHeadersEnabled,
    securityMode
  });
  const rateLimiter = createRateLimiter({
    enabled: resolveRateLimitingEnabled(options, securityMode),
    windowMs: resolveRateLimitWindowMs(options),
    authMax: resolveRateLimitBucketMax(options, "auth", 20),
    publicMax: resolveRateLimitBucketMax(options, "public", 20),
    sensitiveMax: resolveRateLimitBucketMax(options, "sensitive", 30),
    adminMax: resolveRateLimitBucketMax(options, "admin", 15)
  });
  const databaseRuntimeRole =
    options.databaseRuntimeRole ??
    process.env.DATABASE_RUNTIME_ROLE ??
    (backend === "postgres" ? "app_runtime" : null);
  const oidc = createOidcVerifier({
    enabled: options.oidc?.enabled ?? process.env.OIDC_ENABLED === "true",
    issuer: options.oidc?.issuer ?? process.env.OIDC_ISSUER,
    audience: options.oidc?.audience ?? process.env.OIDC_AUDIENCE,
    clientId: options.oidc?.clientId ?? process.env.OIDC_CLIENT_ID,
    scopes: options.oidc?.scopes ?? process.env.OIDC_SCOPES,
    discoveryUrl: options.oidc?.discoveryUrl ?? process.env.OIDC_DISCOVERY_URL,
    jwksUri: options.oidc?.jwksUri ?? process.env.OIDC_JWKS_URI,
    allowEmailFallback:
      resolveOidcAllowEmailFallback(options, securityMode)
  });
  state.iotOperations =
    options.iotOperations ??
    createIotOperationsRuntime({
      repos,
      ...(options.iot ?? {})
    });

  return {
    state,
    repos,
    db,
    oidc,
    securityMode,
    allowSeedTokens,
    securityHeadersEnabled,
    databaseRuntimeRole,
    databaseSsl,
    databaseSslRejectUnauthorized,
    backend,
    env: options.env ?? process.env,
    router,
    async inject(request) {
      return dispatch({
        request,
        state,
        repos,
        router,
        db,
        oidc,
        securityMode,
        databaseRuntimeRole,
        databaseSsl,
        databaseSslRejectUnauthorized,
        backend,
        env: options.env ?? process.env,
        securityHeadersEnabled,
        allowSeedTokens,
        defaultResponseHeaders,
        rateLimiter
      });
    },
    async close() {
      if (db) {
        await db.close();
      }
    }
  };
}

async function dispatch({
  request,
  state,
  repos,
  router,
  db,
  oidc,
  securityMode,
  databaseRuntimeRole,
  databaseSsl,
  databaseSslRejectUnauthorized,
  backend,
  env,
  securityHeadersEnabled,
  allowSeedTokens,
  defaultResponseHeaders,
  rateLimiter
}) {
  const method = request.method.toUpperCase();
  const headers = normalizeHeaders(request.headers ?? {});
  const url = new URL(request.path, "http://localhost");
  const match = router.match(method, url.pathname);
  if (!match) {
    return jsonResponse(404, { error: "Route not found" });
  }

  const { route, params } = match;
  const body = request.body ?? {};
      const ctx = {
    route,
    router,
    state,
    method,
    headers,
    params,
    query: Object.fromEntries(url.searchParams.entries()),
    body,
    principal: null,
    tenantId: null,
    requestId: null,
    resources: {},
    baseRepos: repos,
    repos,
    db,
    oidc,
    securityMode,
    allowSeedTokens,
    backend,
    env,
    defaultResponseHeaders,
    securityHeadersEnabled,
    rateLimiter,
    databaseRuntimeRole,
    databaseSsl,
    databaseSslRejectUnauthorized,
    audit: null,
    breakGlass: null,
    rateLimit: null
  };

  try {
    requestIdMiddleware(ctx);
    transportSecurityCheckMiddleware(ctx);
    rateLimitMiddleware(ctx);
    await authMiddleware(ctx);
    tenantResolutionMiddleware(ctx);
    refreshScopedRepos(ctx);
    await resourceResolutionMiddleware(ctx);
    refreshScopedRepos(ctx);
    await breakGlassResolutionMiddleware(ctx);
    accessControlMatrixMiddleware(ctx);
    roleScopeMiddleware(ctx);
    policyEngineMiddleware(ctx);
    validationMiddleware(ctx);

    const payload = await route.handler(ctx);
    ctx.response = payload;
    responseMaskingMiddleware(ctx);
    await auditMiddleware(ctx);
    metricsMiddleware(ctx);

    return jsonResponse(route.statusCode ?? 200, ctx.response, ctx.defaultResponseHeaders);
  } catch (error) {
    const normalized = normalizeError(error);
    await attemptAuditFailure(ctx, normalized);
    return jsonResponse(normalized.statusCode, {
      error: normalized.message,
      details: normalized.details,
      request_id: ctx.requestId
    }, ctx.defaultResponseHeaders);
  }
}

function requestIdMiddleware(ctx) {
  ctx.requestId = ctx.headers["x-request-id"] ?? `req-${Math.random().toString(16).slice(2)}`;
}

function transportSecurityCheckMiddleware(ctx) {
  const transport = ctx.headers["x-forwarded-proto"];
  if (transport && transport !== "https") {
    throw new HttpError(400, "Insecure transport");
  }
}

function rateLimitMiddleware(ctx) {
  if (!ctx.rateLimiter) {
    return;
  }
  const result = ctx.rateLimiter.check(ctx.route, buildRateLimitSubject(ctx));
  if (!result) {
    return;
  }
  ctx.rateLimit = result;
  if (result.limited) {
    throw new HttpError(429, "Rate limit exceeded", {
      route_id: ctx.route.id,
      retry_after_seconds: result.retryAfterSeconds
    });
  }
}

async function authMiddleware(ctx) {
  if (!ctx.route.authRequired && !ctx.route.allowedRoles) {
    return;
  }
  const authorization = ctx.headers.authorization;
  if (!authorization) {
    if (ctx.route.authRequired === false) {
      return;
    }
    throw new HttpError(401, "Missing Authorization header");
  }

  const [scheme, token] = authorization.split(" ");
  if (!scheme || !token) {
    throw new HttpError(401, "Invalid Authorization header");
  }

  if (scheme !== "Bearer") {
    throw new HttpError(401, "Unsupported authorization scheme");
  }

  const seedPrincipal = await authenticateSeedPrincipal(ctx, token);
  if (seedPrincipal) {
    ctx.principal = seedPrincipal;
    return;
  }

  const devicePrincipal = await authenticateDevicePrincipal(ctx, token);
  if (devicePrincipal) {
    ctx.principal = devicePrincipal;
    return;
  }

  const oidcPrincipal = await authenticateOidcPrincipal(ctx, token);
  if (oidcPrincipal) {
    ctx.principal = oidcPrincipal;
    return;
  }

  throw new HttpError(401, "Invalid bearer token");
}

function tenantResolutionMiddleware(ctx) {
  if (ctx.principal?.tenant_id) {
    ctx.tenantId = ctx.principal.tenant_id;
    return;
  }
  const tenantId = ctx.headers["x-tenant-id"];
  if (tenantId) {
    ctx.tenantId = tenantId;
    return;
  }
  if (ctx.route.authRequired === false) {
    return;
  }
  throw new HttpError(400, "Unable to resolve tenant");
}

async function resourceResolutionMiddleware(ctx) {
  if (typeof ctx.route.resolveResources !== "function") {
    return;
  }
  ctx.resources = await ctx.route.resolveResources({
    state: ctx.state,
    repos: ctx.repos,
    params: ctx.params,
    query: ctx.query,
    body: ctx.body,
    headers: ctx.headers,
    principal: ctx.principal
  });
  if (!ctx.tenantId && ctx.resources.tenantHint) {
    ctx.tenantId = ctx.resources.tenantHint;
  }
  if (!ctx.tenantId && ctx.resources.event?.tenant_id) {
    ctx.tenantId = ctx.resources.event.tenant_id;
  }
}

function refreshScopedRepos(ctx) {
  if (typeof ctx.baseRepos.scope !== "function") {
    return;
  }
  const scope = {};
  if (ctx.tenantId) {
    scope.tenantId = ctx.tenantId;
  }
  if (ctx.principal?.actor_id) {
    scope.actorId = ctx.principal.actor_id;
  }
  if (ctx.principal?.role) {
    scope.actorRole = ctx.principal.role;
  }
  if (ctx.databaseRuntimeRole) {
    scope.databaseRole = ctx.databaseRuntimeRole;
  }
  ctx.repos = Object.keys(scope).length ? ctx.baseRepos.scope(scope) : ctx.baseRepos;
}

async function breakGlassResolutionMiddleware(ctx) {
  const breakGlassId = ctx.headers["x-break-glass-id"];
  if (!breakGlassId) {
    return;
  }
  if (!ctx.principal || ctx.principal.role !== "platform_admin") {
    throw new HttpError(403, "Break-glass header is only valid for platform admins");
  }
  const request = await ctx.repos.breakGlassAccess.findById(ctx.tenantId, breakGlassId);
  if (request.status !== "active") {
    throw new HttpError(403, "Break-glass session is not active");
  }
  if (Date.now() > Date.parse(request.expires_at)) {
    request.status = "expired";
    await ctx.repos.breakGlassAccess.update(request);
    throw new HttpError(403, "Break-glass session has expired");
  }
  ctx.breakGlass = request;
}

function roleScopeMiddleware(ctx) {
  enforceRoleScope(ctx);
}

function accessControlMatrixMiddleware(ctx) {
  enforceAccessControlMatrix(ctx);
}

function policyEngineMiddleware(ctx) {
  enforcePolicy(ctx);
}

function validationMiddleware(ctx) {
  if (typeof ctx.route.validate === "function") {
    ctx.body = ctx.route.validate(ctx.body);
  }
}

function responseMaskingMiddleware(ctx) {
  ctx.response = maskResponse(ctx.response, ctx);
}

async function auditMiddleware(ctx) {
  if (!ctx.route.auditEventType) {
    return;
  }
  await createAuditRecord(ctx, ctx.route.auditEventType, {});
}

function metricsMiddleware(ctx) {
  ctx.repos.metrics.incrementRouteHit(ctx.route.id);
}

function inferAuditTarget(ctx) {
  return (
    ctx.resources.user?.id ??
    ctx.resources.accessScope?.id ??
    ctx.resources.walletPass?.id ??
    ctx.resources.shortLink?.id ??
    ctx.resources.interaction?.id ??
    ctx.resources.event?.id ??
    ctx.resources.exportRequest?.id ??
    ctx.resources.device?.id ??
    ctx.resources.breakGlassRequest?.id ??
    ctx.route.id
  );
}

function normalizeHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
}

function normalizeError(error) {
  if (error instanceof HttpError) {
    return error;
  }
  return new HttpError(500, "Internal server error");
}

async function authenticateDevicePrincipal(ctx, token) {
  const credential = await ctx.baseRepos.deviceCredentials?.findActiveByTokenHash?.(
    hashDeviceCredentialToken(token)
  );
  if (!credential) {
    return null;
  }

  const device = await ctx.baseRepos.devices.findById(
    credential.tenant_id ?? credential.resolved_tenant_id,
    credential.device_id ?? credential.resolved_device_id
  );

  let assignment = null;
  try {
    assignment = await ctx.baseRepos.deviceAssignments.findActiveByDeviceId(device.tenant_id, device.id);
  } catch (error) {
    if (!(error instanceof HttpError) || error.statusCode !== 404) {
      throw error;
    }
  }

  credential.last_used_at = new Date().toISOString();
  await ctx.baseRepos.scope?.({ tenantId: device.tenant_id })?.deviceCredentials.update?.(credential);

  return buildDevicePrincipal(device, assignment, credential);
}

async function authenticateSeedPrincipal(ctx, token) {
  const seedPrincipal = ctx.allowSeedTokens ? ctx.state.authTokens[token] : null;
  if (!seedPrincipal) {
    return null;
  }

  if (seedPrincipal.type !== "user") {
    return seedPrincipal;
  }

  const user = await ctx.baseRepos.users.findById(
    seedPrincipal.tenant_id,
    seedPrincipal.user_id ?? seedPrincipal.actor_id
  );
  const authenticatedUser = await refreshAuthenticatedUser(ctx, user, "seed");
  return loadScopedUserPrincipal(ctx, authenticatedUser, "seed");
}

async function authenticateOidcPrincipal(ctx, token) {
  if (!ctx.oidc?.enabled) {
    return null;
  }

  const claims = await ctx.oidc.verifyAccessToken(token);
  let user = await ctx.baseRepos.users.findByExternalSubject(claims.iss, claims.sub);

  if (!user && ctx.oidc.allowEmailFallback && claims.email) {
    user = await ctx.baseRepos.users.findByEmail(claims.email);
  }

  if (!user) {
    throw new HttpError(403, "OIDC identity is not linked to a platform user");
  }

  const authenticatedUser = await refreshAuthenticatedUser(ctx, user, "oidc");
  return loadScopedUserPrincipal(ctx, authenticatedUser, "oidc", claims);
}

async function refreshAuthenticatedUser(ctx, user, authSource) {
  const userStatus = resolveUserLifecycleStatus(user);
  if (userStatus !== "active") {
    ctx.tenantId = user.tenant_id;
    ctx.principal = {
      ...buildUserPrincipal({ ...user, status: userStatus }, []),
      auth_source: authSource
    };
    throw buildUserLifecycleAuthError(user, userStatus);
  }

  const scopedRepos = ctx.baseRepos.scope?.({ tenantId: user.tenant_id }) ?? ctx.baseRepos;
  return scopedRepos.users.update({
    ...user,
    status: userStatus,
    last_login_at: new Date().toISOString()
  });
}

async function loadScopedUserPrincipal(ctx, user, authSource, claims = null) {
  const scopedRepos = ctx.baseRepos.scope?.({
    tenantId: user.tenant_id,
    actorId: user.id,
    actorRole: user.role
  }) ?? ctx.baseRepos;
  const scopes = await scopedRepos.userAccessScopes.listByUser(user.tenant_id, user.id);
  const principal = buildUserPrincipal(user, scopes);
  principal.auth_source = authSource;
  if (claims) {
    principal.oidc = {
      issuer: claims.iss,
      subject: claims.sub,
      email: claims.email ?? null
    };
  }
  return principal;
}

function resolveUserLifecycleStatus(user) {
  if (user.deleted_at && user.status !== "deleted") {
    return "deleted";
  }
  return user.status ?? "active";
}

function buildUserLifecycleAuthError(user, status) {
  const messageByStatus = {
    pending_invite: "User account is pending activation",
    disabled: "User account is disabled",
    suspended: "User account is suspended",
    deleted: "User account is deleted"
  };
  return new HttpError(403, messageByStatus[status] ?? "User account is not active", {
    auth_reason: `user_status_${status}`,
    user_id: user.id,
    user_status: status
  });
}

function resolveSecurityMode(options) {
  const configured =
    options.securityMode ??
    process.env.APP_SECURITY_MODE ??
    (process.env.NODE_ENV === "production" ? "secure" : "local_demo");

  if (!["local_demo", "secure"].includes(configured)) {
    throw new Error(`Unsupported APP_SECURITY_MODE: ${configured}`);
  }

  return configured;
}

function resolveAllowSeedTokens(options, securityMode) {
  const configured = options.auth?.allowSeedTokens ?? parseBooleanEnv(process.env.AUTH_ALLOW_SEED_TOKENS);
  if (configured != null) {
    return configured;
  }
  return securityMode === "local_demo";
}

function resolveOidcAllowEmailFallback(options, securityMode) {
  const configured =
    options.oidc?.allowEmailFallback ?? parseBooleanEnv(process.env.OIDC_ALLOW_EMAIL_FALLBACK);
  if (configured != null) {
    return configured;
  }
  return securityMode === "local_demo" ? false : false;
}

function resolveSessionSecret(options, state, securityMode) {
  const configured = options.sessionSecret ?? process.env.SESSION_SECRET;
  if (configured) {
    return configured;
  }
  if (securityMode === "secure") {
    throw new Error("SESSION_SECRET is required when APP_SECURITY_MODE=secure");
  }
  return state.sessionSecret;
}

function resolveDatabaseSslRejectUnauthorized(options, securityMode) {
  const configured =
    options.databaseSslRejectUnauthorized ??
    parseBooleanEnv(process.env.DATABASE_SSL_REJECT_UNAUTHORIZED);
  if (configured != null) {
    return configured;
  }
  return securityMode === "secure";
}

function resolveSecurityHeadersEnabled(options, securityMode) {
  const configured =
    options.securityHeadersEnabled ?? parseBooleanEnv(process.env.SECURITY_HEADERS_ENABLED);
  if (configured != null) {
    return configured;
  }
  return securityMode === "secure";
}

function resolveRateLimitingEnabled(options, securityMode) {
  const configured =
    options.rateLimiting?.enabled ?? parseBooleanEnv(process.env.RATE_LIMITING_ENABLED);
  if (configured != null) {
    return configured;
  }
  return securityMode === "secure";
}

function resolveRateLimitWindowMs(options) {
  return resolvePositiveInteger(
    options.rateLimiting?.windowMs ?? process.env.RATE_LIMIT_WINDOW_MS,
    60_000
  );
}

function resolveRateLimitBucketMax(options, bucket, fallback) {
  const optionKey = `${bucket}Max`;
  const envKey = `RATE_LIMIT_${bucket.toUpperCase()}_MAX`;
  return resolvePositiveInteger(options.rateLimiting?.[optionKey] ?? process.env[envKey], fallback);
}

function parseBooleanEnv(value) {
  if (value == null || value === "") {
    return null;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`Expected boolean environment value, received: ${value}`);
}

function resolvePositiveInteger(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`Expected positive numeric value, received: ${value}`);
  }
  return Math.floor(numeric);
}

function buildDefaultResponseHeaders({ enabled, securityMode }) {
  if (!enabled) {
    return {};
  }
  const headers = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "cross-origin-resource-policy": "same-origin",
    "cross-origin-opener-policy": "same-origin",
    "x-permitted-cross-domain-policies": "none"
  };
  if (securityMode === "secure") {
    headers["strict-transport-security"] = "max-age=31536000; includeSubDomains";
  }
  return headers;
}

function buildRateLimitSubject(ctx) {
  return (
    ctx.headers.authorization ??
    ctx.headers["x-forwarded-for"] ??
    ctx.headers["x-real-ip"] ??
    ctx.headers["x-tenant-id"] ??
    "anonymous"
  );
}

function createRateLimiter(config) {
  if (!config.enabled) {
    return null;
  }

  const buckets = new Map();

  return {
    check(route, subject) {
      const bucket = resolveRateLimitBucket(route, config);
      if (!bucket) {
        return null;
      }

      const now = Date.now();
      const key = `${bucket.name}:${subject}`;
      const existing = buckets.get(key);
      if (!existing || existing.resetAt <= now) {
        const next = {
          count: 1,
          resetAt: now + config.windowMs
        };
        buckets.set(key, next);
        return {
          limited: false,
          remaining: Math.max(bucket.max - next.count, 0),
          retryAfterSeconds: Math.ceil((next.resetAt - now) / 1000)
        };
      }

      existing.count += 1;
      if (existing.count > bucket.max) {
        return {
          limited: true,
          remaining: 0,
          retryAfterSeconds: Math.ceil((existing.resetAt - now) / 1000)
        };
      }

      return {
        limited: false,
        remaining: Math.max(bucket.max - existing.count, 0),
        retryAfterSeconds: Math.ceil((existing.resetAt - now) / 1000)
      };
    }
  };
}

function resolveRateLimitBucket(route, config) {
  if (!route?.id) {
    return null;
  }

  if (route.id === "auth-me") {
    return { name: "auth", max: config.authMax };
  }

  if (["consent-capture", "consent-revoke", "attendee-session-view", "attendee-dsr-create"].includes(route.id)) {
    return { name: "public", max: config.publicMax };
  }

  if (
    [
      "exports-request",
      "exports-approve",
      "exports-reject",
      "exports-download",
      "device-credentials-provision",
      "device-credentials-revoke",
      "interaction-crm-sync"
    ].includes(route.id)
  ) {
    return { name: "sensitive", max: config.sensitiveMax };
  }

  if (
    route.id.startsWith("break-glass") ||
    [
      "organizer-pilot-signoff-export",
      "organizer-iot-runs-trigger",
      "organizer-iot-parity-trigger",
      "admin-iot-runs-trigger",
      "admin-iot-cleanup-trigger"
    ].includes(route.id)
  ) {
    return { name: "admin", max: config.adminMax };
  }

  return null;
}

async function attemptAuditFailure(ctx, error) {
  if (!ctx.route?.auditEventType) {
    return;
  }
  const suffix = error.statusCode >= 500 ? ".failed" : ".denied";
  const metadata = {
    status_code: error.statusCode,
    error_message: error.message
  };
  if (error.details?.auth_reason) {
    metadata.auth_reason = error.details.auth_reason;
  }
  if (error.details?.user_status) {
    metadata.user_status = error.details.user_status;
  }
  if (error.details?.user_id) {
    metadata.user_id = error.details.user_id;
  }
  if (error.details?.route_id) {
    metadata.route_id = error.details.route_id;
  }
  if (error.details?.permission) {
    metadata.permission = error.details.permission;
  }
  if (error.details?.role) {
    metadata.role = error.details.role;
  }
  await createAuditRecord(ctx, `${ctx.route.auditEventType}${suffix}`, metadata);
}

async function createAuditRecord(ctx, eventType, extraMetadata) {
  const actorType = ctx.principal?.type === "device" ? "device" : ctx.principal ? "user" : "system";
  const actorId = ctx.principal?.actor_id ?? "anonymous";
  await ctx.repos.auditLogs.create({
    id: nextId("audit"),
    tenant_id: ctx.tenantId ?? "unknown",
    actor_type: actorType,
    actor_id: actorId,
    event_type: eventType,
    target_type: ctx.route.id,
    target_id: inferAuditTarget(ctx),
    break_glass_access_id: ctx.breakGlass?.id ?? null,
    metadata: {
      request_id: ctx.requestId,
      method: ctx.method,
      path: ctx.route.path,
      ...extraMetadata
    },
    created_at: new Date().toISOString()
  });
}

function jsonResponse(statusCode, body, defaultHeaders = {}) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...defaultHeaders
    },
    body: body && typeof body === "object" ? structuredClone(body) : body
  };
}
