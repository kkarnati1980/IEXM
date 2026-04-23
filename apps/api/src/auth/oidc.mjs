import { createPublicKey, verify as verifySignature } from "node:crypto";

import { HttpError } from "../http-error.mjs";

const DEFAULT_ALLOWED_ALGORITHMS = new Set(["RS256", "RS384", "RS512", "ES256", "ES384", "ES512"]);

function base64urlDecodeJson(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function isJwt(token) {
  return typeof token === "string" && token.split(".").length === 3;
}

function normalizeAudience(aud) {
  if (Array.isArray(aud)) {
    return aud;
  }
  if (typeof aud === "string" && aud.length) {
    return [aud];
  }
  return [];
}

function algorithmForVerify(alg) {
  if (alg.startsWith("RS")) {
    return `RSA-SHA${alg.slice(2)}`;
  }
  if (alg.startsWith("ES")) {
    return `sha${alg.slice(2)}`;
  }
  throw new HttpError(401, `Unsupported OIDC signing algorithm: ${alg}`);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json"
    }
  });
  if (!response.ok) {
    throw new HttpError(502, `OIDC metadata fetch failed for ${url}`);
  }
  return response.json();
}

async function fetchForm(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(body).toString()
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new HttpError(502, `OIDC token exchange failed for ${url}`, {
      provider_error: payload.error ?? null,
      provider_error_description: payload.error_description ?? null
    });
  }
  return payload;
}

export function createOidcVerifier(config = {}) {
  const enabled = config.enabled === true;
  if (!enabled) {
    return null;
  }

  const issuer = config.issuer;
  const audience = config.audience;
  const clientId = config.clientId ?? audience;
  const scopes = config.scopes ?? "openid profile email";
  if (!issuer || !audience) {
    throw new Error("OIDC issuer and audience are required when OIDC is enabled");
  }

  const discoveryUrl = config.discoveryUrl ?? `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const allowedAlgorithms = new Set(config.allowedAlgorithms ?? DEFAULT_ALLOWED_ALGORITHMS);
  const cacheTtlMs = config.cacheTtlMs ?? 5 * 60 * 1000;

  let discoveryCache = null;
  let jwksCache = null;
  let cacheExpiresAt = 0;

  async function loadDiscovery() {
    const now = Date.now();
    if (discoveryCache && now < cacheExpiresAt) {
      return discoveryCache;
    }
    discoveryCache = await fetchJson(discoveryUrl);
    cacheExpiresAt = now + cacheTtlMs;
    return discoveryCache;
  }

  async function loadJwks() {
    const now = Date.now();
    if (jwksCache && now < cacheExpiresAt) {
      return jwksCache;
    }
    const discovery = await loadDiscovery();
    const jwksUri = config.jwksUri ?? discovery.jwks_uri;
    if (!jwksUri) {
      throw new HttpError(502, "OIDC JWKS URI missing from discovery metadata");
    }
    jwksCache = await fetchJson(jwksUri);
    cacheExpiresAt = now + cacheTtlMs;
    return jwksCache;
  }

  async function loadBrowserEndpoints() {
    const discovery = await loadDiscovery();
    return {
      authorization_endpoint: discovery.authorization_endpoint ?? null,
      token_endpoint: discovery.token_endpoint ?? null,
      end_session_endpoint: discovery.end_session_endpoint ?? null
    };
  }

  async function resolveKey(header) {
    const jwks = await loadJwks();
    const key = jwks.keys?.find((candidate) => candidate.kid === header.kid);
    if (!key) {
      throw new HttpError(401, "OIDC key identifier not found");
    }
    return createPublicKey({ key, format: "jwk" });
  }

  async function verifyAccessToken(token) {
    if (!isJwt(token)) {
      throw new HttpError(401, "OIDC bearer token must be a JWT");
    }

    const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
    const header = base64urlDecodeJson(encodedHeader);
    if (!allowedAlgorithms.has(header.alg)) {
      throw new HttpError(401, `OIDC algorithm ${header.alg} is not allowed`);
    }

    const payload = base64urlDecodeJson(encodedPayload);
    const key = await resolveKey(header);
    const signedContent = Buffer.from(`${encodedHeader}.${encodedPayload}`);
    const signature = Buffer.from(encodedSignature, "base64url");
    const verified = verifySignature(algorithmForVerify(header.alg), signedContent, key, signature);

    if (!verified) {
      throw new HttpError(401, "OIDC token signature verification failed");
    }

    const now = Math.floor(Date.now() / 1000);
    if (payload.iss !== issuer) {
      throw new HttpError(401, "OIDC issuer mismatch");
    }
    if (!normalizeAudience(payload.aud).includes(audience)) {
      throw new HttpError(401, "OIDC audience mismatch");
    }
    if (payload.exp && now >= payload.exp) {
      throw new HttpError(401, "OIDC token expired");
    }
    if (payload.nbf && now < payload.nbf) {
      throw new HttpError(401, "OIDC token not active yet");
    }
    if (!payload.sub) {
      throw new HttpError(401, "OIDC token missing subject");
    }

    return payload;
  }

  return {
    enabled,
    issuer,
    audience,
    clientId,
    scopes,
    allowEmailFallback: config.allowEmailFallback === true,
    async verifyAccessToken(token) {
      return verifyAccessToken(token);
    },
    async getBrowserConfiguration() {
      const endpoints = await loadBrowserEndpoints();
      return {
        issuer,
        audience,
        client_id: clientId,
        scopes,
        ...endpoints
      };
    },
    async exchangeAuthorizationCode({ code, codeVerifier, redirectUri }) {
      const { token_endpoint: tokenEndpoint } = await loadBrowserEndpoints();
      if (!tokenEndpoint) {
        throw new HttpError(502, "OIDC token endpoint missing from discovery metadata");
      }

      return fetchForm(tokenEndpoint, {
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
        client_id: clientId
      });
    }
  };
}
