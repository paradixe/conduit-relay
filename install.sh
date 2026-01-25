#!/bin/bash
set -e

REPO="ssmirr/conduit"
INSTALL_DIR="/usr/local/bin"
DATA_DIR="/var/lib/conduit"
SERVICE_FILE="/etc/systemd/system/conduit.service"

# Install geoip-bin for dashboard geo stats
echo "Installing dependencies..."
apt-get update -qq && apt-get install -y -qq geoip-bin >/dev/null 2>&1 || true

# Get latest release
echo "Fetching latest release..."
LATEST=$(curl -s "https://api.github.com/repos/$REPO/releases/latest" | grep -oP '"tag_name": "\K[^"]+')
if [ -z "$LATEST" ]; then
  echo "Failed to get latest release"
  exit 1
fi
echo "Latest: $LATEST"

# Download binary
echo "Downloading..."
curl -sL "https://github.com/$REPO/releases/download/$LATEST/conduit-linux-amd64" -o "$INSTALL_DIR/conduit"
chmod +x "$INSTALL_DIR/conduit"

# Max clients (override with: curl ... | MAX_CLIENTS=500 bash)
MAX_CLIENTS=${MAX_CLIENTS:-200}

# Create data directory
mkdir -p "$DATA_DIR"

# Create systemd service
cat > "$SERVICE_FILE" << EOF
[Unit]
Description=Conduit Relay
After=network.target

[Service]
Type=simple
ExecStart=$INSTALL_DIR/conduit start --max-clients $MAX_CLIENTS --bandwidth 5 --data-dir $DATA_DIR -v
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Enable and start
systemctl daemon-reload
systemctl enable conduit
systemctl start conduit

echo ""
echo "Done. Check status: systemctl status conduit"
echo "View logs: journalctl -u conduit -f"
