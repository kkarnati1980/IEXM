#!/bin/bash
# ═══════════════════════════════════════════════════════════
# Codex Platform — NFC Tap Handler
# Raspberry Pi 5 + ACR122U USB NFC Reader + tablet over WiFi
#
# PREREQUISITES:
#   sudo apt install libnfc-bin
#   node kiosk-server.js   # push server on port 8080
#
# DEVICE TOKEN:
#   Provision via admin panel → Devices → <device> → Credentials
#   or via API: POST /devices/:deviceId/credentials/provision
#   Copy the returned bearer_token into DEVICE_TOKEN below.
#
# HEARTBEAT CONTRACT (POST /device/heartbeat):
#   Required: device_id, event_id, stall_id,
#             local_queue_depth, battery_level
#
# INSTALL:
#   cp codex-tap.sh /home/kiot/codex-tap.sh
#   chmod +x /home/kiot/codex-tap.sh
#   nano /home/kiot/codex-tap.sh   # edit CONFIG section
#   sudo systemctl start codex-nfc
# ═══════════════════════════════════════════════════════════

# ── CONFIG — edit these values for each Pi ─────────────────
API_BASE="https://codex-api-production-064f.up.railway.app"
DEVICE_TOKEN="dvc_KNeSfluQ0uDdFTtxctHsoYDrHEeOfvFK"  # from /credentials/provision
DEVICE_ID="device-ie-01"            # must match device in Codex DB
EVENT_ID="event-indiaexpo"             # active event ID
STALL_ID="stall-ie-a1"                 # assigned stall ID
DISPLAY_NUM=":0"                       # HDMI display (usually :0)
LOG_FILE="/var/log/codex-nfc.log"
QUEUE_FILE="/var/log/codex-queue.csv"
DEBOUNCE_SECONDS=3                     # ignore same card within N sec
HEARTBEAT_INTERVAL=300                 # seconds between heartbeats (5 min)
TOKEN_REFRESH_INTERVAL=3000            # seconds before re-check token (50 min)
KIOSK_SERVER_PORT=8080                 # port kiosk-server.js listens on
# ───────────────────────────────────────────────────────────

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}[$(date '+%H:%M:%S')] [codex]${NC} $1" | tee -a "$LOG_FILE"; }
warn() { echo -e "${YELLOW}[$(date '+%H:%M:%S')] [warn]${NC} $1"  | tee -a "$LOG_FILE"; }
err()  { echo -e "${RED}[$(date '+%H:%M:%S')] [error]${NC} $1"   | tee -a "$LOG_FILE"; }
info() { echo -e "${BLUE}[$(date '+%H:%M:%S')] [info]${NC} $1"   | tee -a "$LOG_FILE"; }

# ── Read NFC UID from ACR122U ──────────────────────────────
read_nfc_uid() {
  local RAW
  RAW=$(nfc-list -v 2>/dev/null | \
    grep "UID (NFCID1):" | \
    sed 's/.*UID (NFCID1): //' | \
    tr -d ' ' | \
    head -1)
  echo "$RAW"
}

# ── POST tap to Codex API ──────────────────────────────────
post_nfc_tap() {
  local NFC_UID="$1"
  local TAP_ID="tap-$(date +%s%N | md5sum | head -c 12)"
  local OCCURRED_AT
  OCCURRED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  curl -s --max-time 15 \
    -X POST "$API_BASE/interactions/nfc-tap" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $DEVICE_TOKEN" \
    -d "{
      \"nfc_uid\": \"$NFC_UID\",
      \"device_id\": \"$DEVICE_ID\",
      \"event_id\": \"$EVENT_ID\",
      \"stall_id\": \"$STALL_ID\",
      \"local_event_id\": \"$TAP_ID\",
      \"occurred_at\": \"$OCCURRED_AT\"
    }" 2>/dev/null
}

# ── Push consent URL to tablet via kiosk server ───────────
open_consent_screen() {
  local CONSENT_URL="$1"

  local PUSH_RESPONSE
  PUSH_RESPONSE=$(curl -s --max-time 5 \
    -X POST "http://localhost:${KIOSK_SERVER_PORT}/push" \
    -H "Content-Type: application/json" \
    -d "{\"consent_url\": \"$CONSENT_URL\"}" \
    2>/dev/null)

  local PUSHED
  PUSHED=$(echo "$PUSH_RESPONSE" | \
    python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('pushed',0))" \
    2>/dev/null)

  if [ "${PUSHED:-0}" -gt 0 ]; then
    log "Pushed consent URL to $PUSHED tablet(s)"
  else
    warn "No tablets connected — consent URL logged below"
    warn "$CONSENT_URL"
    info "Tablet URL: http://$(hostname -I | cut -d' ' -f1):${KIOSK_SERVER_PORT}"
  fi
}

# ── Queue failed tap for offline retry ────────────────────
queue_tap() {
  local NFC_UID="$1"
  local OCCURRED_AT
  OCCURRED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "$NFC_UID,$OCCURRED_AT" >> "$QUEUE_FILE"
  warn "Queued for retry: $NFC_UID"
}

# ── Retry queued taps ─────────────────────────────────────
retry_queue() {
  [ ! -s "$QUEUE_FILE" ] && return

  local COUNT
  COUNT=$(wc -l < "$QUEUE_FILE")
  info "Retrying $COUNT queued taps…"

  local TEMP_FILE
  TEMP_FILE=$(mktemp)

  while IFS=',' read -r UID_VAL TS; do
    local TAP_ID="retry-$(date +%s%N | md5sum | head -c 8)"
    local RESPONSE
    RESPONSE=$(curl -s --max-time 10 \
      -X POST "$API_BASE/interactions/nfc-tap" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $DEVICE_TOKEN" \
      -d "{
        \"nfc_uid\": \"$UID_VAL\",
        \"device_id\": \"$DEVICE_ID\",
        \"event_id\": \"$EVENT_ID\",
        \"stall_id\": \"$STALL_ID\",
        \"local_event_id\": \"$TAP_ID\",
        \"occurred_at\": \"$TS\"
      }" 2>/dev/null)

    if echo "$RESPONSE" | grep -q '"interaction_id"'; then
      log "Retry OK: $UID_VAL"
    else
      echo "$UID_VAL,$TS" >> "$TEMP_FILE"
    fi
  done < "$QUEUE_FILE"

  mv "$TEMP_FILE" "$QUEUE_FILE"
}

# ── Send heartbeat ─────────────────────────────────────────
send_heartbeat() {
  local QUEUE_DEPTH=0
  [ -s "$QUEUE_FILE" ] && QUEUE_DEPTH=$(wc -l < "$QUEUE_FILE")

  curl -s --max-time 10 \
    -X POST "$API_BASE/device/heartbeat" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $DEVICE_TOKEN" \
    -d "{
      \"device_id\": \"$DEVICE_ID\",
      \"event_id\": \"$EVENT_ID\",
      \"stall_id\": \"$STALL_ID\",
      \"local_queue_depth\": $QUEUE_DEPTH,
      \"battery_level\": 100,
      \"reader_status\": \"connected\",
      \"connectivity_status\": \"online\"
    }" > /dev/null 2>&1

  info "Heartbeat sent (queue_depth=$QUEUE_DEPTH)"
}

# ── MAIN LOOP ──────────────────────────────────────────────
main() {
  log "═══════════════════════════════════════════"
  log "  Codex NFC Tap Handler"
  log "  Device:  $DEVICE_ID"
  log "  Stall:   $STALL_ID"
  log "  Event:   $EVENT_ID"
  log "  API:     $API_BASE"
  log "═══════════════════════════════════════════"

  if [ "$DEVICE_TOKEN" = "your-bearer-token-here" ]; then
    err "DEVICE_TOKEN not set — edit CONFIG section in this script"
    err "Provision a token via: POST /devices/$DEVICE_ID/credentials/provision"
    exit 1
  fi

  if ! command -v nfc-list > /dev/null 2>&1; then
    warn "libnfc not found — install: sudo apt install libnfc-bin"
  elif ! nfc-list > /dev/null 2>&1; then
    warn "NFC reader not detected. Check ACR122U USB connection."
  else
    log "NFC reader detected ✓"
  fi

  send_heartbeat

  local LAST_UID=""
  local LAST_TAP_TIME=0
  local LOOP_COUNT=0
  local LAST_HEARTBEAT_AT
  LAST_HEARTBEAT_AT=$(date +%s)

  log "Waiting for NFC card taps…"

  while true; do
    LOOP_COUNT=$((LOOP_COUNT + 1))
    local CURRENT_TIME
    CURRENT_TIME=$(date +%s)

    # Heartbeat on interval
    if [ $((CURRENT_TIME - LAST_HEARTBEAT_AT)) -ge "$HEARTBEAT_INTERVAL" ]; then
      send_heartbeat
      retry_queue
      LAST_HEARTBEAT_AT=$CURRENT_TIME
    fi

    # Read NFC UID
    local NFC_UID
    NFC_UID=$(read_nfc_uid)

    if [ -n "$NFC_UID" ]; then
      local TIME_SINCE_LAST=$((CURRENT_TIME - LAST_TAP_TIME))

      # Debounce: skip same card tapped within DEBOUNCE_SECONDS
      if [ "$NFC_UID" != "$LAST_UID" ] || [ "$TIME_SINCE_LAST" -gt "$DEBOUNCE_SECONDS" ]; then
        log "Tap: NFC_UID=$NFC_UID"
        LAST_UID="$NFC_UID"
        LAST_TAP_TIME=$CURRENT_TIME

        RESPONSE=""
        RESPONSE=$(post_nfc_tap "$NFC_UID")

        INTERACTION_ID=""; CONSENT_URL=""; IS_NEW=""
        INTERACTION_ID=$(echo "$RESPONSE" | python3 -c "import sys,json,re; d=json.loads(sys.stdin.read()); print(d.get('interaction_id',''))" 2>/dev/null)
        CONSENT_URL=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('consent_url',''))" 2>/dev/null)
        IS_NEW=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(str(d.get('is_new_attendee',False)).lower())" 2>/dev/null)

        if echo "$RESPONSE" | grep -q "result"; then
          log "  interaction_id=$INTERACTION_ID  new=$IS_NEW"
          if [ -n "$CONSENT_URL" ]; then
            open_consent_screen "$CONSENT_URL"
          fi
        else
          err "API error — queuing tap: $RESPONSE"
          queue_tap "$NFC_UID"
        fi
      fi
    fi

    sleep 0.5
  done
}

main "$@"
