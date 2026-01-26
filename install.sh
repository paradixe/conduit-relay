#!/bin/bash
set -e

INSTALL_DIR="/usr/local/bin"
DATA_DIR="/var/lib/conduit"
SERVICE_FILE="/etc/systemd/system/conduit.service"

# Binary sources (try in order)
PRIMARY_URL="https://raw.githubusercontent.com/paradixe/conduit-relay/main/bin/conduit-linux-amd64"
FALLBACK_REPO="ssmirr/conduit"

# Install geoip-bin for dashboard geo stats
echo "Installing dependencies..."
apt-get update -qq && apt-get install -y -qq geoip-bin >/dev/null 2>&1 || true

# Download binary (try primary, then fallback)
echo "Downloading conduit..."
if curl -sL "$PRIMARY_URL" -o "$INSTALL_DIR/conduit" && [ -s "$INSTALL_DIR/conduit" ]; then
  echo "Downloaded from primary source"
else
  echo "Primary failed, trying fallback..."
  LATEST=$(curl -s "https://api.github.com/repos/$FALLBACK_REPO/releases/latest" | grep -oP '"tag_name": "\K[^"]+')
  if [ -z "$LATEST" ]; then
    echo "Failed to get fallback release"
    exit 1
  fi
  curl -sL "https://github.com/$FALLBACK_REPO/releases/download/$LATEST/conduit-linux-amd64" -o "$INSTALL_DIR/conduit"
  echo "Downloaded from fallback ($LATEST)"
fi
chmod +x "$INSTALL_DIR/conduit"

# Verify binary works
if ! "$INSTALL_DIR/conduit" --version >/dev/null 2>&1; then
  echo "Binary verification failed"
  exit 1
fi
echo "Version: $($INSTALL_DIR/conduit --version)"

# Configuration (override with: curl ... | MAX_CLIENTS=500 BANDWIDTH=100 bash)
# -m: max concurrent clients (default 200, CLI default is 50)
# -b: bandwidth limit in Mbps (-1 = unlimited, CLI default is 40)
MAX_CLIENTS=${MAX_CLIENTS:-200}
BANDWIDTH=${BANDWIDTH:--1}

# Create conduit user and data directory
if ! getent passwd conduit >/dev/null 2>&1; then
  useradd -r -s /usr/sbin/nologin -d "$DATA_DIR" -M conduit
fi
mkdir -p "$DATA_DIR"
chown conduit:conduit "$DATA_DIR"

# Create systemd service (runs as non-root)
cat > "$SERVICE_FILE" << EOF
[Unit]
Description=Conduit Relay
After=network.target

[Service]
Type=simple
User=conduit
Group=conduit
ExecStart=$INSTALL_DIR/conduit start -m $MAX_CLIENTS -b $BANDWIDTH --data-dir $DATA_DIR -v
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
