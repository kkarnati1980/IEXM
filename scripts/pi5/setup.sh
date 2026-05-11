#!/bin/bash
# ═══════════════════════════════════════════════════════════
# Codex Platform — Raspberry Pi 5 One-Command Setup
#
# USAGE:
#   bash setup.sh
#
# WHAT THIS DOES:
#   1. Installs libnfc-bin, chromium-browser, curl, jq
#   2. Configures libnfc for ACR122U
#   3. Adds udev rule (no sudo needed for NFC reads)
#   4. Installs codex-tap.sh to /home/pi/
#   5. Creates systemd service codex-nfc (auto-start on boot)
#   6. Configures Chromium kiosk autostart
# ═══════════════════════════════════════════════════════════

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[setup]${NC} $1"; }
warn() { echo -e "${YELLOW}[setup]${NC} $1"; }

log "Codex Platform — Pi 5 Setup"
log "═══════════════════════════════"

# ── 1. Install packages ────────────────────────────────────
log "Installing packages…"
sudo apt-get update -qq
sudo apt-get install -y \
  libnfc-bin libnfc-dev \
  pcscd \
  chromium-browser \
  curl jq 2>/dev/null \
|| sudo apt-get install -y \
  libnfc-bin libnfc-dev \
  pcscd \
  chromium \
  curl jq

# ── 2. Configure libnfc for ACR122U ───────────────────────
log "Configuring ACR122U (libnfc)…"
sudo mkdir -p /etc/nfc
sudo tee /etc/nfc/libnfc.conf > /dev/null << 'NFCEOF'
allow_autoscan = true
allow_intrusive_scan = false
log_level = 1
device.name = "ACS ACR122U"
device.connstring = "usb"
NFCEOF

# ── 3. udev rule — no sudo for NFC reads ──────────────────
log "Adding udev rule for ACR122U…"
sudo tee /etc/udev/rules.d/99-acr122u.rules > /dev/null << 'UDEVEOF'
# ACR122U NFC Reader
SUBSYSTEM=="usb", ATTRS{idVendor}=="072f", ATTRS{idProduct}=="2200", GROUP="plugdev", MODE="0666"
# ACR1252U
SUBSYSTEM=="usb", ATTRS{idVendor}=="072f", ATTRS{idProduct}=="223b", GROUP="plugdev", MODE="0666"
UDEVEOF
sudo usermod -aG plugdev pi 2>/dev/null || true
sudo udevadm control --reload-rules 2>/dev/null || true

# ── 4. Install tap script ──────────────────────────────────
log "Installing codex-tap.sh…"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/codex-tap.sh" ]; then
  cp "$SCRIPT_DIR/codex-tap.sh" /home/pi/codex-tap.sh
else
  curl -fsSL \
    "https://raw.githubusercontent.com/kkarnati1980/IEXM/main/scripts/pi5/codex-tap.sh" \
    -o /home/pi/codex-tap.sh
fi
chmod +x /home/pi/codex-tap.sh

# ── 5. systemd service ─────────────────────────────────────
log "Creating systemd service codex-nfc…"
sudo tee /etc/systemd/system/codex-nfc.service > /dev/null << 'SVCEOF'
[Unit]
Description=Codex Platform NFC Tap Handler
After=network-online.target graphical.target
Wants=network-online.target

[Service]
Type=simple
User=pi
Environment=DISPLAY=:0
Environment=XAUTHORITY=/home/pi/.Xauthority
ExecStartPre=/bin/sleep 10
ExecStart=/home/pi/codex-tap.sh
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=codex-nfc

[Install]
WantedBy=graphical.target
SVCEOF

sudo systemctl daemon-reload
sudo systemctl enable codex-nfc

# ── 6. Chromium kiosk autostart ───────────────────────────
log "Configuring Chromium kiosk autostart…"
mkdir -p /home/pi/.config/autostart
tee /home/pi/.config/autostart/chromium-kiosk.desktop > /dev/null << 'DESKTOPEOF'
[Desktop Entry]
Type=Application
Name=Codex Kiosk
Exec=chromium-browser --kiosk --noerrdialogs --disable-infobars --no-first-run https://codex-api-production-064f.up.railway.app/kiosk.html
Hidden=false
X-GNOME-Autostart-enabled=true
DESKTOPEOF

# ── 7. Test NFC reader ─────────────────────────────────────
log "Testing NFC reader…"
if nfc-list 2>/dev/null | grep -qi "device\|NFC\|acr"; then
  log "NFC reader detected ✓"
else
  warn "NFC reader not detected (plug in ACR122U then run: nfc-list)"
fi

# ── Done ───────────────────────────────────────────────────
echo ""
log "═══════════════════════════════════════════"
log "  Setup complete!"
log "═══════════════════════════════════════════"
echo ""
echo "NEXT STEPS:"
echo ""
echo "1. Edit /home/pi/codex-tap.sh — fill in CONFIG:"
echo "   DEVICE_TOKEN=<bearer token from /credentials/provision>"
echo "   DEVICE_ID=<your device id>"
echo "   EVENT_ID=<active event id>"
echo "   STALL_ID=<assigned stall id>"
echo ""
echo "2. Test manually:"
echo "   /home/pi/codex-tap.sh"
echo ""
echo "3. Start service:"
echo "   sudo systemctl start codex-nfc"
echo ""
echo "4. Watch logs:"
echo "   sudo journalctl -u codex-nfc -f"
echo ""
