/**
 * Shared UI components for the Codex platform web shell.
 * All components are plain vanilla JS — no framework required.
 */

// ─── UserStatusBadge ─────────────────────────────────────────────────────────

/**
 * Returns an HTML string for a user status badge.
 * @param {string} status - "active" | "pending_invite" | "disabled"
 */
export function userStatusBadgeHtml(status) {
  const labels = {
    active: "Active",
    pending_invite: "Pending",
    disabled: "Disabled"
  };
  const label = labels[status] ?? status;
  return `<span class="status-pill ${status}">${label}</span>`;
}

// ─── OnboardingChecklist ──────────────────────────────────────────────────────

const CHECKLIST_ITEMS = [
  { key: "has_name", label: "Event name set" },
  { key: "has_venue", label: "Venue configured" },
  { key: "has_dates", label: "Dates confirmed" },
  { key: "has_branding", label: "Branding uploaded" },
  { key: "has_organizer", label: "Organizer admin assigned" },
  { key: "has_data_policy", label: "Data policy configured" },
  { key: "has_devices", label: "At least one device registered" }
];

/**
 * Returns an HTML string for the onboarding checklist.
 * @param {object} checks - Map of key → boolean
 */
export function onboardingChecklistHtml(checks) {
  const done = CHECKLIST_ITEMS.filter((item) => checks[item.key]).length;
  const total = CHECKLIST_ITEMS.length;
  const readyToPublish = done >= 5;
  const readyToGoLive = done === total;

  const items = CHECKLIST_ITEMS.map((item) => {
    const ok = checks[item.key];
    return `<div class="item" style="display:flex;gap:10px;align-items:center;">
      <span style="color:${ok ? "var(--good)" : "var(--bad)"}">${ok ? "✅" : "❌"}</span>
      <span class="${ok ? "" : "muted"}">${item.label}</span>
    </div>`;
  }).join("");

  let banners = "";
  if (readyToGoLive) {
    banners += `<div class="status ok">Ready to go live — all ${total} checks passed.</div>`;
  } else if (readyToPublish) {
    banners += `<div class="status ok">Ready to publish — ${done}/${total} checks passed.</div>`;
  } else {
    banners += `<div class="status error">${done}/${total} checks passed — complete remaining items before publishing.</div>`;
  }

  return `${banners}<div class="list">${items}</div>`;
}

// ─── MultiRoleContextPicker ───────────────────────────────────────────────────

const CONTEXT_KEY = "codex.active_event_context";

export function getActiveEventContext() {
  try {
    const raw = localStorage.getItem(CONTEXT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setActiveEventContext(context) {
  localStorage.setItem(CONTEXT_KEY, JSON.stringify(context));
}

export function clearActiveEventContext() {
  localStorage.removeItem(CONTEXT_KEY);
}

/**
 * Renders a context picker modal and resolves with the chosen context object
 * when the user selects an event.
 * @param {Array} events - [{id, name, status}]
 * @param {string[]} roles - current user roles
 */
export function showMultiRoleContextPicker(events, roles) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:9000;";

    const panel = document.createElement("div");
    panel.style.cssText = "background:var(--panel);border-radius:22px;border:1px solid var(--border);padding:24px;max-width:480px;width:90%;max-height:80vh;overflow-y:auto;";

    const eventOptions = events.map((ev) =>
      `<option value="${escHtml(ev.id)}">${escHtml(ev.name)} (${ev.status})</option>`
    ).join("");

    panel.innerHTML = `
      <div class="eyebrow">Context</div>
      <h2 style="margin:8px 0 16px;">Select active event</h2>
      <p class="muted">Choose an event context to work in. This will be remembered for this session.</p>
      <select id="ctx-event-select" style="margin-bottom:16px;">
        <option value="">— choose an event —</option>
        ${eventOptions}
      </select>
      <div style="display:flex;gap:10px;">
        <button id="ctx-confirm" class="primary" style="flex:1;">Confirm</button>
        <button id="ctx-cancel" class="secondary" style="flex:1;">Cancel</button>
      </div>
    `;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    panel.querySelector("#ctx-confirm").addEventListener("click", () => {
      const sel = panel.querySelector("#ctx-event-select");
      const eventId = sel.value;
      if (!eventId) return;
      const event = events.find((ev) => ev.id === eventId);
      if (!event) return;
      const ctx = { event_id: eventId, event_name: event.name, roles };
      setActiveEventContext(ctx);
      overlay.remove();
      resolve(ctx);
    });

    panel.querySelector("#ctx-cancel").addEventListener("click", () => {
      overlay.remove();
      resolve(null);
    });
  });
}

// ─── RoleAssignmentModal ──────────────────────────────────────────────────────

/**
 * Shows a role assignment modal.
 * @param {object} opts
 * @param {string} opts.apiBase
 * @param {string} opts.token - auth bearer token
 * @param {string} opts.userId - target user id
 * @param {Array} opts.events - [{id, name}] for scope selection
 * @param {function} opts.onAssigned - called with the assignment result
 */
export function showRoleAssignmentModal({ apiBase, token, userId, events, onAssigned }) {
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:9000;";

  const panel = document.createElement("div");
  panel.style.cssText = "background:var(--panel);border-radius:22px;border:1px solid var(--border);padding:24px;max-width:520px;width:90%;max-height:80vh;overflow-y:auto;";

  const ROLES = ["platform_admin", "organizer_admin", "vendor_manager", "sponsor_user", "ops_user"];
  const SCOPED_ROLES = ["organizer_admin", "vendor_manager", "sponsor_user", "ops_user"];
  const STALL_ROLES = ["vendor_manager"];
  const PACKAGE_ROLES = ["sponsor_user"];

  const eventOptions = events.map((ev) =>
    `<option value="${escHtml(ev.id)}">${escHtml(ev.name)}</option>`
  ).join("");

  panel.innerHTML = `
    <div class="eyebrow">IAM</div>
    <h2 style="margin:8px 0 16px;">Assign role</h2>
    <div id="ram-status" hidden class="status error" style="margin-bottom:12px;"></div>
    <div style="margin-bottom:12px;">
      <label class="muted" style="font-size:13px;display:block;margin-bottom:6px;">Role</label>
      <select id="ram-role">
        <option value="">— select role —</option>
        ${ROLES.map((r) => `<option value="${r}">${r}</option>`).join("")}
      </select>
    </div>
    <div id="ram-scope-fields" hidden>
      <div style="margin-bottom:12px;">
        <label class="muted" style="font-size:13px;display:block;margin-bottom:6px;">Event</label>
        <select id="ram-event">
          <option value="">— select event —</option>
          ${eventOptions}
        </select>
      </div>
      <div id="ram-stall-wrap" hidden style="margin-bottom:12px;">
        <label class="muted" style="font-size:13px;display:block;margin-bottom:6px;">Stall IDs (comma-separated)</label>
        <input type="text" id="ram-stalls" placeholder="stall-1, stall-2">
      </div>
      <div id="ram-package-wrap" hidden style="margin-bottom:12px;">
        <label class="muted" style="font-size:13px;display:block;margin-bottom:6px;">Sponsor package ID</label>
        <input type="text" id="ram-package" placeholder="pkg-123">
      </div>
    </div>
    <div style="display:flex;gap:10px;margin-top:16px;">
      <button id="ram-submit" class="primary" style="flex:1;">Assign</button>
      <button id="ram-cancel" class="secondary" style="flex:1;">Cancel</button>
    </div>
  `;

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const roleEl = panel.querySelector("#ram-role");
  const scopeFields = panel.querySelector("#ram-scope-fields");
  const stallWrap = panel.querySelector("#ram-stall-wrap");
  const packageWrap = panel.querySelector("#ram-package-wrap");
  const statusEl = panel.querySelector("#ram-status");

  roleEl.addEventListener("change", () => {
    const role = roleEl.value;
    const needsScope = SCOPED_ROLES.includes(role);
    scopeFields.hidden = !needsScope;
    stallWrap.hidden = !STALL_ROLES.includes(role);
    packageWrap.hidden = !PACKAGE_ROLES.includes(role);
  });

  panel.querySelector("#ram-cancel").addEventListener("click", () => overlay.remove());

  panel.querySelector("#ram-submit").addEventListener("click", async () => {
    const role = roleEl.value;
    if (!role) {
      showRamError(statusEl, "Please select a role.");
      return;
    }
    const body = { role };
    if (SCOPED_ROLES.includes(role)) {
      const eventId = panel.querySelector("#ram-event").value;
      if (!eventId) {
        showRamError(statusEl, "Please select an event for this role.");
        return;
      }
      body.event_id = eventId;
    }
    if (STALL_ROLES.includes(role)) {
      const stallInput = panel.querySelector("#ram-stalls").value.trim();
      if (!stallInput) {
        showRamError(statusEl, "Please enter at least one stall ID.");
        return;
      }
      body.stall_ids = stallInput.split(",").map((s) => s.trim()).filter(Boolean);
    }
    if (PACKAGE_ROLES.includes(role)) {
      const pkg = panel.querySelector("#ram-package").value.trim();
      if (!pkg) {
        showRamError(statusEl, "Please enter a sponsor package ID.");
        return;
      }
      body.sponsor_package_id = pkg;
    }

    try {
      const res = await fetch(`${apiBase}/users/${userId}/roles`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showRamError(statusEl, data.error ?? "Failed to assign role.");
        return;
      }
      overlay.remove();
      if (onAssigned) onAssigned(data);
    } catch (err) {
      showRamError(statusEl, "Network error — please try again.");
    }
  });
}

function showRamError(el, msg) {
  el.textContent = msg;
  el.className = "status error";
  el.hidden = false;
}

// ─── EventStatusActionButton ──────────────────────────────────────────────────

const EVENT_TRANSITIONS = {
  draft:     { label: "Publish",  action: "publish",  roles: ["platform_admin", "organizer_admin"] },
  published: { label: "Go Live",  action: "go-live",  roles: ["platform_admin", "organizer_admin"] },
  live:      { label: "Close",    action: "close",    roles: ["platform_admin", "organizer_admin"] },
  closed:    { label: "Archive",  action: "archive",  roles: ["platform_admin"] }
};

/**
 * Returns an HTML button string for the event status action, or empty string
 * if no transition is available for this role.
 * @param {string} status - current event status
 * @param {string[]} roles - user roles
 * @param {string} eventId
 */
export function eventStatusActionButtonHtml(status, roles, eventId) {
  const transition = EVENT_TRANSITIONS[status];
  if (!transition) return "";
  const allowed = transition.roles.some((r) => roles.includes(r));
  if (!allowed) return "";
  return `<button class="primary" data-event-action="${transition.action}" data-event-id="${escHtml(eventId)}">${transition.label}</button>`;
}

/**
 * Wires up event action button clicks within a container element.
 * @param {Element} container
 * @param {object} opts - { apiBase, token, onSuccess }
 */
export function wireEventActionButtons(container, { apiBase, token, onSuccess }) {
  container.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-event-action]");
    if (!btn) return;
    const action = btn.dataset.eventAction;
    const eventId = btn.dataset.eventId;
    try {
      const res = await fetch(`${apiBase}/events/${eventId}/${action}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error ?? "Action failed");
        return;
      }
      if (onSuccess) onSuccess(eventId, action);
    } catch {
      alert("Network error — please try again.");
    }
  });
}

// ─── BreakGlassSessionBanner ──────────────────────────────────────────────────

/**
 * Mounts a break-glass session banner at the top of the page.
 * Auto-dismisses when expired; calls revoke endpoint on button click.
 * @param {object} session - { id, tenant_id, expires_at }
 * @param {object} opts - { apiBase, token, onExpired, onRevoked }
 * @returns {function} cleanup function to remove the banner
 */
export function mountBreakGlassSessionBanner(session, { apiBase, token, onExpired, onRevoked }) {
  const banner = document.createElement("div");
  banner.id = "break-glass-banner";
  banner.style.cssText =
    "position:sticky;top:0;z-index:8000;padding:12px 20px;background:rgba(243,201,125,0.18);" +
    "border-bottom:1px solid var(--warn);display:flex;align-items:center;gap:16px;flex-wrap:wrap;";

  const label = document.createElement("span");
  label.style.cssText = "flex:1;color:var(--warn);font-weight:600;";
  const revokeBtn = document.createElement("button");
  revokeBtn.textContent = "Revoke access";
  revokeBtn.className = "warn";
  revokeBtn.style.padding = "8px 14px";

  banner.appendChild(label);
  banner.appendChild(revokeBtn);
  document.body.prepend(banner);

  const expiresMs = Date.parse(session.expires_at);
  let intervalHandle = null;

  function tick() {
    const remaining = expiresMs - Date.now();
    if (remaining <= 0) {
      label.textContent = "Break-glass session expired.";
      clearInterval(intervalHandle);
      banner.remove();
      if (onExpired) onExpired();
      return;
    }
    const mins = Math.floor(remaining / 60_000);
    const secs = Math.floor((remaining % 60_000) / 1_000);
    label.textContent = `Break-glass access active — expires in ${mins}m ${String(secs).padStart(2, "0")}s`;
  }

  tick();
  intervalHandle = setInterval(tick, 1_000);

  revokeBtn.addEventListener("click", async () => {
    try {
      const res = await fetch(`${apiBase}/break-glass/${session.id}/revoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error ?? "Failed to revoke break-glass session.");
        return;
      }
      clearInterval(intervalHandle);
      banner.remove();
      if (onRevoked) onRevoked();
    } catch {
      alert("Network error — please try again.");
    }
  });

  return () => {
    clearInterval(intervalHandle);
    banner.remove();
  };
}

// ─── Session helpers ──────────────────────────────────────────────────────────

const TOKEN_KEY = "codex.token";
const ACTIVE_EVENT_ID_KEY = "codex.active_event_id";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) ?? null;
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function getActiveEventId() {
  return localStorage.getItem(ACTIVE_EVENT_ID_KEY) ?? null;
}

export function setActiveEventId(id) {
  localStorage.setItem(ACTIVE_EVENT_ID_KEY, id);
}

export function clearActiveEventId() {
  localStorage.removeItem(ACTIVE_EVENT_ID_KEY);
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ACTIVE_EVENT_ID_KEY);
  localStorage.removeItem(CONTEXT_KEY);
}

/**
 * Decodes the JWT payload and returns true if the token exists and has not expired.
 */
export function isAuthenticated() {
  const token = getToken();
  if (!token) return false;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (!payload.exp) return true;
    return Date.now() / 1000 < payload.exp;
  } catch {
    return false;
  }
}

/**
 * Clears session data and redirects to the login page.
 * @param {string} [loginPath] - path to login page (default "/login.html")
 */
export function logoutUser(loginPath = "/login.html") {
  clearSession();
  location.href = loginPath;
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

export function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
