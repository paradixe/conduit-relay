#!/bin/bash
set -e

INSTALL_DIR="/usr/local/bin"
DATA_DIR="/var/lib/conduit"
SERVICE_FILE="/etc/systemd/system/conduit.service"

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  BINARY="conduit-linux-amd64" ;;
  aarch64) BINARY="conduit-linux-arm64" ;;
  armv7l)  BINARY="conduit-linux-arm64" ;;
  *)       echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac
BINARY_URL="https://github.com/ssmirr/conduit/releases/latest/download/$BINARY"

# Install dependencies
echo "Installing dependencies..."
apt-get update -qq && apt-get install -y -qq geoip-bin >/dev/null 2>&1 || true

# Download binary
echo "Downloading $BINARY..."
if ! curl -fsSL "$BINARY_URL" -o "$INSTALL_DIR/conduit"; then
  echo "Failed to download from $BINARY_URL"
  exit 1
fi
if [ ! -s "$INSTALL_DIR/conduit" ]; then
  echo "Downloaded file is empty"
  exit 1
fi
chmod +x "$INSTALL_DIR/conduit"

# Verify binary works
if ! "$INSTALL_DIR/conduit" --version >/dev/null 2>&1; then
  echo "Binary verification failed"
  echo "  - Architecture: $ARCH"
  echo "  - Try running: $INSTALL_DIR/conduit --version"
  rm -f "$INSTALL_DIR/conduit"
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
