const TOKEN_PREFIX = "pwi.browserAuth.token";
const PENDING_PREFIX = "pwi.browserAuth.pending";

export async function loadBrowserAuthConfig(apiBase) {
  const response = await fetch(`${apiBase}/auth/browser-config`, {
    cache: "no-store"
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "Unable to load browser auth configuration");
  }
  return payload;
}

export async function completeBrowserAuthCallback({ apiBase }) {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const providerError = url.searchParams.get("error");
  const providerErrorDescription = url.searchParams.get("error_description");

  if (!code && !state && !providerError) {
    return null;
  }

  const pending = loadPendingRequestByState(state);
  if (!pending) {
    clearAuthCallbackParams(url);
    window.history.replaceState({}, "", url);
    throw new Error("OIDC login state was not found or has expired.");
  }

  if (providerError) {
    clearPendingRequest(state);
    window.history.replaceState({}, "", pending.returnUrl);
    throw new Error(providerErrorDescription || providerError);
  }

  const response = await fetch(`${apiBase}/auth/oidc/exchange`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      code,
      code_verifier: pending.codeVerifier,
      redirect_uri: pending.redirectUri
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    clearPendingRequest(state);
    window.history.replaceState({}, "", pending.returnUrl);
    throw new Error(payload.error || "OIDC code exchange failed");
  }
  if (!payload.access_token) {
    clearPendingRequest(state);
    window.history.replaceState({}, "", pending.returnUrl);
    throw new Error("OIDC provider did not return an access token");
  }

  storeTokenRecord(pending.apiBase, pending.slot, {
    access_token: payload.access_token,
    token_type: payload.token_type || "Bearer",
    expires_at: payload.expires_in ? Date.now() + (Number(payload.expires_in) * 1000) : null,
    scope: payload.scope || null,
    updated_at: new Date().toISOString()
  });
  clearPendingRequest(state);
  window.history.replaceState({}, "", pending.returnUrl);
  return {
    slot: pending.slot,
    updated_at: new Date().toISOString()
  };
}

export async function createBrowserAuthSlot({
  apiBase,
  slot = "primary",
  defaultToken = "",
  tokenInput = null,
  tokenGroup = null,
  browserGroup = null,
  statusEl = null,
  signInButton = null,
  signOutButton = null,
  config = null
} = {}) {
  const resolvedConfig = config ?? await loadBrowserAuthConfig(apiBase);
  const secureOidcMode =
    resolvedConfig.security_mode === "secure" &&
    resolvedConfig.browser_auth?.mode === "oidc_pkce";
  const state = {
    apiBase,
    slot,
    config: resolvedConfig,
    secureOidcMode,
    defaultToken,
    tokenInput,
    tokenGroup,
    browserGroup,
    statusEl,
    signInButton,
    signOutButton
  };

  if (tokenInput && !secureOidcMode) {
    tokenInput.value = tokenInput.value || defaultToken;
  }

  if (signInButton) {
    signInButton.addEventListener("click", async () => {
      try {
        await beginOidcLogin(state);
      } catch (error) {
        renderStatus(state, error.message, "error");
      }
    });
  }

  if (signOutButton) {
    signOutButton.addEventListener("click", () => {
      clearStoredToken(apiBase, slot);
      renderAuthMode(state);
      window.location.reload();
    });
  }

  renderAuthMode(state);

  return {
    slot,
    config: resolvedConfig,
    isSecureMode: secureOidcMode,
    requiresLogin: resolvedConfig.browser_auth?.requires_login === true,
    getBearerToken() {
      if (!secureOidcMode) {
        return tokenInput?.value?.trim() || "";
      }
      const tokenRecord = getValidTokenRecord(apiBase, slot);
      return tokenRecord?.access_token || "";
    },
    getTokenType() {
      if (!secureOidcMode) {
        return "Bearer";
      }
      const tokenRecord = getValidTokenRecord(apiBase, slot);
      return tokenRecord?.token_type || "Bearer";
    },
    render() {
      renderAuthMode(state);
    }
  };
}

async function beginOidcLogin(state) {
  if (!state.secureOidcMode) {
    return;
  }

  const oidc = state.config.browser_auth?.oidc;
  if (!oidc?.authorization_endpoint) {
    throw new Error("OIDC browser login is not configured");
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await createPkceChallenge(codeVerifier);
  const stateValue = randomString(24);
  const redirectUri = callbackSafeUrl(window.location.href);
  const authorizeUrl = new URL(oidc.authorization_endpoint);
  authorizeUrl.searchParams.set("client_id", oidc.client_id);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", oidc.scopes || "openid profile email");
  authorizeUrl.searchParams.set("state", stateValue);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  if (oidc.audience) {
    authorizeUrl.searchParams.set("audience", oidc.audience);
  }

  sessionStorage.setItem(
    pendingKey(stateValue),
    JSON.stringify({
      apiBase: state.apiBase,
      slot: state.slot,
      state: stateValue,
      codeVerifier,
      redirectUri,
      returnUrl: redirectUri,
      createdAt: new Date().toISOString()
    })
  );
  window.location.assign(authorizeUrl.toString());
}

function renderAuthMode(state) {
  if (!state.secureOidcMode) {
    toggle(state.tokenGroup, true);
    toggle(state.browserGroup, false);
    renderStatus(state, "Local demo token mode.", "ok");
    return;
  }

  toggle(state.tokenGroup, false);
  toggle(state.browserGroup, true);
  const tokenRecord = getValidTokenRecord(state.apiBase, state.slot);
  if (tokenRecord?.access_token) {
    renderStatus(
      state,
      tokenRecord.expires_at
        ? `OIDC session active until ${new Date(tokenRecord.expires_at).toLocaleString()}.`
        : "OIDC session active.",
      "ok"
    );
    toggle(state.signInButton, false);
    toggle(state.signOutButton, true);
    return;
  }

  renderStatus(state, "Sign in with SSO to continue.", "warn");
  toggle(state.signInButton, true);
  toggle(state.signOutButton, false);
}

function renderStatus(state, text, kind) {
  if (!state.statusEl) {
    return;
  }
  state.statusEl.textContent = text;
  state.statusEl.dataset.kind = kind;
}

function toggle(element, visible) {
  if (!element) {
    return;
  }
  element.hidden = !visible;
  if (visible) {
    element.style.removeProperty("display");
  } else {
    element.style.display = "none";
  }
}

function callbackSafeUrl(currentHref) {
  const url = new URL(currentHref);
  clearAuthCallbackParams(url);
  return url.toString();
}

function clearAuthCallbackParams(url) {
  url.searchParams.delete("code");
  url.searchParams.delete("state");
  url.searchParams.delete("error");
  url.searchParams.delete("error_description");
}

function tokenKey(apiBase, slot) {
  return `${TOKEN_PREFIX}.${apiBase}.${slot}`;
}

function pendingKey(stateValue) {
  return `${PENDING_PREFIX}.${stateValue}`;
}

function storeTokenRecord(apiBase, slot, record) {
  sessionStorage.setItem(tokenKey(apiBase, slot), JSON.stringify(record));
}

function clearStoredToken(apiBase, slot) {
  sessionStorage.removeItem(tokenKey(apiBase, slot));
}

function getValidTokenRecord(apiBase, slot) {
  const raw = sessionStorage.getItem(tokenKey(apiBase, slot));
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed.expires_at && Date.now() >= Number(parsed.expires_at)) {
      clearStoredToken(apiBase, slot);
      return null;
    }
    return parsed;
  } catch {
    clearStoredToken(apiBase, slot);
    return null;
  }
}

function loadPendingRequestByState(stateValue) {
  if (!stateValue) {
    return null;
  }
  const raw = sessionStorage.getItem(pendingKey(stateValue));
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    clearPendingRequest(stateValue);
    return null;
  }
}

function clearPendingRequest(stateValue) {
  if (!stateValue) {
    return;
  }
  sessionStorage.removeItem(pendingKey(stateValue));
}

function randomString(length) {
  const bytes = new Uint8Array(length);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function generateCodeVerifier() {
  return randomString(48);
}

async function createPkceChallenge(codeVerifier) {
  const bytes = new TextEncoder().encode(codeVerifier);
  const digest = await window.crypto.subtle.digest("SHA-256", bytes);
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes) {
  let value = "";
  for (const byte of bytes) {
    value += String.fromCharCode(byte);
  }
  return btoa(value)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
