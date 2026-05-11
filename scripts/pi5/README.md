# Codex Platform — Raspberry Pi 5 Setup Guide

## Hardware Required Per Stall

| Item | Recommended Model | Notes |
|------|-------------------|-------|
| Computer | Raspberry Pi 5 (4 GB or 8 GB) | 8 GB if running Chromium simultaneously |
| NFC Reader | ACR122U USB | Plug-and-play with libnfc on Pi OS |
| Display | Any HDMI monitor or 7" Pi touchscreen | Consent screen shown here |
| Power | Official Pi 5 27W USB-C adapter | Required — Pi 5 draws more than Pi 4 |
| Storage | 32 GB+ MicroSD (Class 10 or A1) | Endurance card recommended |
| NFC Stickers | NTAG213 or NTAG215 pack | For attendee wristbands/badges |

---

## How It Works

```
ACR122U reader        codex-tap.sh          Codex API
───────────────  →  ──────────────────  →  ─────────────────────────
Card tap              POST /interactions     Attendee looked up or
(raw UID: 04AB..)     /nfc-tap               created by SHA-256 hash
                                             of lowercased UID
                      ← consent_url         Tap event + attendee
                                             session logged
                      Chromium opens         kiosk.html shows
                      kiosk.html?            Accept / Decline
                      consent_token=...      buttons on HDMI display
```

---

## Quick Setup (5 minutes)

```bash
# On the Pi, clone repo or copy scripts/pi5/ to /home/pi/
git clone https://github.com/kkarnati1980/IEXM.git /tmp/codex
bash /tmp/codex/scripts/pi5/setup.sh
```

Then edit the config section in `/home/pi/codex-tap.sh`:

```bash
nano /home/pi/codex-tap.sh
```

Fill in:

```bash
DEVICE_TOKEN="eyJ..."      # bearer token from /credentials/provision
DEVICE_ID="device-kiosk-01"
EVENT_ID="event-indiaexpo"
STALL_ID="stall-ie-a1"
```

Start the service:

```bash
sudo systemctl start codex-nfc
sudo journalctl -u codex-nfc -f
```

---

## Provisioning a Device Token

Device tokens are provisioned once per device by an organizer or platform admin.

**Via API:**
```bash
curl -X POST https://codex-api-production-064f.up.railway.app/devices/DEVICE_ID/credentials/provision \
  -H "Authorization: Bearer <organizer-token>" \
  -H "Content-Type: application/json" \
  -d '{"credential_label": "Pi 5 Stall A1"}'
```

Response:
```json
{
  "bearer_token": "cdvc_live_...",
  "credential": { "id": "...", "status": "active" }
}
```

Copy `bearer_token` → paste into `DEVICE_TOKEN` in `codex-tap.sh`.

**Token is shown once.** Store it securely.

---

## Heartbeat Contract

The tap script sends a heartbeat every 5 minutes:

```
POST /device/heartbeat
Authorization: Bearer <DEVICE_TOKEN>

{
  "device_id":         "device-kiosk-01",
  "event_id":          "event-indiaexpo",
  "stall_id":          "stall-ie-a1",
  "local_queue_depth": 0,         ← offline tap queue size
  "battery_level":     100,       ← always 100 for Pi (mains power)
  "reader_status":     "connected",
  "connectivity_status": "online"
}
```

---

## NFC Tap Request

```
POST /interactions/nfc-tap
Authorization: Bearer <DEVICE_TOKEN>

{
  "nfc_uid":        "04A3B2C1D4E5F6",   ← raw UID from ACR122U
  "device_id":      "device-kiosk-01",
  "event_id":       "event-indiaexpo",
  "stall_id":       "stall-ie-a1",
  "local_event_id": "tap-<unique-id>",   ← idempotency key
  "occurred_at":    "2026-05-11T10:00:00Z"
}
```

Response includes:
- `consent_url` — open in Chromium on HDMI
- `attendee_id` — resolved or newly created attendee
- `is_new_attendee` — `true` for first-time cards
- `interaction_id` — tap event ID

---

## Offline Queue

When the API is unreachable, taps are written to `/var/log/codex-queue.csv`.
On the next successful heartbeat, queued taps are retried automatically.

---

## Logs

```bash
# Live service log
sudo journalctl -u codex-nfc -f

# Tap log file
tail -f /var/log/codex-nfc.log

# Offline queue
cat /var/log/codex-queue.csv
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `nfc-list` shows nothing | Unplug/replug ACR122U, run `sudo systemctl restart pcscd` |
| `DEVICE_TOKEN not set` error | Edit `codex-tap.sh` CONFIG section |
| Chromium does not open | Check `DISPLAY=:0` is correct, run `echo $DISPLAY` on Pi desktop |
| `403 Forbidden` from API | Token revoked or device not assigned to event/stall |
| `400 Bad Request` from API | Check `device_id`, `event_id`, `stall_id` match DB records |
| Tap queued every time | Check internet: `curl -I https://codex-api-production-064f.up.railway.app/ready` |
