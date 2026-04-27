// CRM deletion adapter — dispatches contact/lead deletion to external CRM providers.
// Never throws — always returns a result object. Caller logs outcomes regardless of success.

async function refreshSalesforceToken(config) {
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.client_id ?? "",
      client_secret: config.client_secret ?? "",
      refresh_token: config.refresh_token ?? ""
    });
    const res = await fetch("https://login.salesforce.com/services/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.access_token ?? null;
  } catch {
    return null;
  }
}

async function deleteSalesforce(config, externalRecordId) {
  const instanceUrl = (config.instance_url ?? "").replace(/\/$/, "");
  if (!instanceUrl) return { success: false, reason: "SALESFORCE_AUTH_FAILED" };

  let token = config.access_token;

  const attempt = async (accessToken) => {
    const url = `${instanceUrl}/services/data/v57.0/sobjects/Contact/${externalRecordId}`;
    return fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` }
    });
  };

  try {
    let res = await attempt(token);

    if (res.status === 401) {
      const newToken = await refreshSalesforceToken(config);
      if (!newToken) return { success: false, reason: "SALESFORCE_AUTH_FAILED" };
      res = await attempt(newToken);
      if (res.status === 401) return { success: false, reason: "SALESFORCE_AUTH_FAILED" };
    }

    if (res.status === 204 || res.status === 404) return { success: true };
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("Retry-After") ?? "60", 10);
      return { success: false, reason: "RATE_LIMITED", retry_after: retryAfter };
    }
    return { success: false, reason: "PROVIDER_ERROR", status: res.status };
  } catch (err) {
    return { success: false, reason: "NETWORK_ERROR", error: err.message };
  }
}

async function deleteHubSpot(config, externalRecordId) {
  const token = config.private_app_token ?? config.access_token;
  if (!token) return { success: false, reason: "HUBSPOT_AUTH_FAILED" };

  const url = `https://api.hubapi.com/crm/v3/objects/contacts/${externalRecordId}`;
  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` }
    });
    if (res.status === 204 || res.status === 404) return { success: true };
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("Retry-After") ?? "60", 10);
      return { success: false, reason: "RATE_LIMITED", retry_after: retryAfter };
    }
    return { success: false, reason: "PROVIDER_ERROR", status: res.status };
  } catch (err) {
    return { success: false, reason: "NETWORK_ERROR", error: err.message };
  }
}

async function deleteZoho(config, externalRecordId) {
  const token = config.access_token;
  if (!token) return { success: false, reason: "ZOHO_AUTH_FAILED" };

  const url = `https://www.zohoapis.com/crm/v3/Contacts/${externalRecordId}`;
  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Zoho-oauthtoken ${token}` }
    });
    if (res.status === 404) return { success: true };
    if (res.status === 200) {
      const data = await res.json();
      const outcome = data?.data?.[0]?.code;
      if (outcome === "SUCCESS" || outcome === "RECORD_DELETED") return { success: true };
      return { success: false, reason: "PROVIDER_ERROR", status: res.status };
    }
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("Retry-After") ?? "60", 10);
      return { success: false, reason: "RATE_LIMITED", retry_after: retryAfter };
    }
    return { success: false, reason: "PROVIDER_ERROR", status: res.status };
  } catch (err) {
    return { success: false, reason: "NETWORK_ERROR", error: err.message };
  }
}

export async function dispatchCRMDeletion(repos, connectionId, externalRecordId, attendeeId) {
  const connection = await repos.crmConnections.findById(connectionId);
  if (!connection || connection.status === "disconnected" || connection.status === "revoked") {
    console.log(`[crm-deletion] Connection ${connectionId} not connected — skipping attendee ${attendeeId}`);
    return { success: false, reason: "CRM_NOT_CONNECTED" };
  }

  const config = connection.config ?? {};
  const provider = connection.provider;

  console.log(`[crm-deletion] Dispatching ${provider} deletion for record ${externalRecordId} (attendee ${attendeeId})`);

  if (provider === "salesforce") return deleteSalesforce(config, externalRecordId);
  if (provider === "hubspot") return deleteHubSpot(config, externalRecordId);
  if (provider === "zoho") return deleteZoho(config, externalRecordId);

  // Unknown provider — log and treat as skip
  console.log(`[crm-deletion] Unknown provider ${provider} — skipping`);
  return { success: false, reason: "UNKNOWN_PROVIDER" };
}
