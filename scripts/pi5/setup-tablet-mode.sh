#!/bin/bash
# ═══════════════════════════════════════════════════════════
# Codex Platform — Tablet Push Mode Setup
# Run once on the Pi 5 after basic NFC setup is complete.
# ═══════════════════════════════════════════════════════════

set -e

PI_IP=$(hostname -I | cut -d' ' -f1)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "[setup] Installing Codex kiosk push server..."

# Copy server script to home directory
cp "$SCRIPT_DIR/kiosk-server.js" /home/kiot/kiosk-server.js
chown kiot:kiot /home/kiot/kiosk-server.js

# Install and enable systemd service
sudo cp "$SCRIPT_DIR/codex-kiosk-server.service" \
  /etc/systemd/system/codex-kiosk-server.service
sudo systemctl daemon-reload
sudo systemctl enable codex-kiosk-server
sudo systemctl start codex-kiosk-server

echo ""
echo "[setup] Kiosk server started"
echo ""
echo "  On your tablet, open Chrome and navigate to:"
echo ""
echo "      http://$PI_IP:8080"
echo ""
echo "  The tablet shows 'Ready for tap'."
echo "  When an NFC card is tapped, the consent screen"
echo "  opens on the tablet automatically."
echo ""
echo "  Health check: http://$PI_IP:8080/health"
echo "  Logs:         sudo journalctl -u codex-kiosk -f"
echo ""
