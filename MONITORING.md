# Uptime Monitoring Setup

## Better Uptime (free tier)

### 1. Sign up
Go to https://betteruptime.com and create a free account.

### 2. Create a monitor

In the dashboard click **New monitor** and fill in:

| Field | Value |
|---|---|
| Monitor type | **HTTP** |
| URL | `https://codex-api-production-064f.up.railway.app/health` |
| Name | `Codex API — /health` |
| Check interval | **3 minutes** |
| HTTP method | GET |

### 3. Set alert conditions

Under **Alert when** choose:
- **Down for more than 5 minutes** before alerting (reduces noise for transient Railway restarts)

### 4. Set alert contacts

Add alert email: **karnati.kishore@gmail.com**

Free tier delivers email alerts only. Upgrade to add SMS/phone/Slack.

### 5. Expected response validation

Under **Advanced** → **Response validation**:

| Setting | Value |
|---|---|
| Expected status code | `200` |
| Body contains (string match) | `"status":"ok"` |

The endpoint returns JSON like:
```json
{
  "status": "ok",
  "version": "0.1.0",
  "timestamp": "2026-05-01T12:00:00.000Z",
  "uptime_seconds": 3600,
  "environment": "production",
  "checks": {
    "database": true,
    "email_worker": true,
    "storage": true
  }
}
```

When any check fails the API returns `"status":"degraded"` — this will trigger the body-match alert.

### 6. Verify

After saving, Better Uptime runs the first check within a minute. The monitor card turns green when the API responds correctly. You will receive a confirmation email.

---

## Admin status dashboard

The internal status dashboard at `https://codex-api-production-064f.up.railway.app/admin/status.html` polls the same `/health` endpoint every 30 seconds and shows component-level breakdowns. Use it for quick manual checks; use Better Uptime for automated alerting.
