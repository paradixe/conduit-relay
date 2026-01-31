#!/bin/bash
# Conduit Relay + Dashboard Setup
# One command to install everything and get a join command for other servers
set -e

# Config
INSTALL_DIR="/usr/local/bin"
DATA_DIR="/var/lib/conduit"
DASHBOARD_DIR="/opt/conduit-dashboard"
PORT=${PORT:-3000}

# Relay config (override with: curl ... | MAX_CLIENTS=500 BANDWIDTH=100 bash)
MAX_CLIENTS=${MAX_CLIENTS:-200}
BANDWIDTH=${BANDWIDTH:--1}

# Skip relay install (for running dashboard on laptop only)
# Usage: curl ... | DASHBOARD_ONLY=1 bash
DASHBOARD_ONLY=${DASHBOARD_ONLY:-0}

# Binary source (ssmirr builds)
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  BINARY="conduit-linux-amd64" ;;
  aarch64) BINARY="conduit-linux-arm64" ;;
  armv7l)  BINARY="conduit-linux-arm64" ;;
  *)       echo -e "${RED}Unsupported architecture: $ARCH${NC}"; exit 1 ;;
esac
BINARY_URL="https://github.com/ssmirr/conduit/releases/latest/download/$BINARY"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${CYAN}${BOLD}"
echo "╔═══════════════════════════════════════════════╗"
echo "║     Conduit Relay + Dashboard Setup           ║"
echo "╚═══════════════════════════════════════════════╝"
echo -e "${NC}"

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Please run as root (sudo)${NC}"
  exit 1
fi

# Ask about relay installation (skip if DASHBOARD_ONLY already set)
if [ "$DASHBOARD_ONLY" != "1" ]; then
  echo -e "${CYAN}Install Conduit Relay on this device? (routes traffic for users)${NC}"
  echo -e "  ${BOLD}Y${NC} = Yes, this is a VPS I want to use as a relay"
  echo -e "  ${BOLD}N${NC} = No, just the dashboard (e.g., running on laptop)"
  echo ""
  read -r -p "Install relay? [Y/n]: " INSTALL_RELAY < /dev/tty
  if [[ "$INSTALL_RELAY" =~ ^[Nn]$ ]]; then
    DASHBOARD_ONLY=1
  fi
  echo ""
fi

#
# Step 1: Install Conduit Relay (skip if DASHBOARD_ONLY=1)
#
if [ "$DASHBOARD_ONLY" = "1" ]; then
  echo -e "${YELLOW}[1/6] Skipping Conduit Relay (dashboard only mode)${NC}"
else
  echo -e "${YELLOW}[1/6] Installing Conduit Relay...${NC}"

  # Install dependencies (including sudo for minimal systems)
  apt-get update -qq && apt-get install -y -qq sudo geoip-bin curl git >/dev/null 2>&1 || true

  # Stop existing service if running (binary may be locked)
  systemctl stop conduit 2>/dev/null || true

  # Download binary to temp file first
  echo "  Downloading $BINARY..."
  TEMP_BIN=$(mktemp)
  if ! curl -fsSL "$BINARY_URL" -o "$TEMP_BIN"; then
    echo -e "${RED}Failed to download conduit from $BINARY_URL${NC}"
    rm -f "$TEMP_BIN"
    exit 1
  fi
  if [ ! -s "$TEMP_BIN" ]; then
    echo -e "${RED}Downloaded file is empty${NC}"
    rm -f "$TEMP_BIN"
    exit 1
  fi
  mv "$TEMP_BIN" "$INSTALL_DIR/conduit"
  chmod +x "$INSTALL_DIR/conduit"

  # Verify binary runs
  if ! "$INSTALL_DIR/conduit" --version >/dev/null 2>&1; then
    echo -e "${RED}Binary verification failed${NC}"
    echo -e "${RED}  - Check architecture: $(uname -m)${NC}"
    echo -e "${RED}  - Try running: $INSTALL_DIR/conduit --version${NC}"
    rm -f "$INSTALL_DIR/conduit"
    exit 1
  fi
  echo -e "  Version: $($INSTALL_DIR/conduit --version)"

  # Create conduit user and data dir
  if ! getent passwd conduit >/dev/null 2>&1; then
    useradd -r -s /usr/sbin/nologin -d "$DATA_DIR" -M conduit
  fi
  mkdir -p "$DATA_DIR"
  chown conduit:conduit "$DATA_DIR"

  # Service runs as non-root
  cat > /etc/systemd/system/conduit.service << EOF
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

  systemctl daemon-reload
  systemctl enable conduit >/dev/null 2>&1
  systemctl restart conduit
  echo -e "  ${GREEN}Relay started${NC} (-m $MAX_CLIENTS -b $BANDWIDTH)"
fi

#
# Step 2: Install Node.js
#
echo -e "${YELLOW}[2/6] Installing Node.js...${NC}"
if command -v node &>/dev/null && node -v | grep -qE "^v(1[89]|2[0-9])"; then
  echo "  Node.js already installed: $(node -v)"
else
  curl -fsSL https://deb.nodesource.com/setup_20.x 2>/dev/null | bash - >/dev/null 2>&1
  apt-get install -y nodejs >/dev/null 2>&1
  echo "  Installed Node.js $(node -v)"
fi

#
# Step 3: Install Dashboard
#
echo -e "${YELLOW}[3/6] Installing Dashboard...${NC}"
rm -rf "$DASHBOARD_DIR" /tmp/conduit-repo
git clone --depth 1 -q https://github.com/paradixe/conduit-relay.git /tmp/conduit-repo
mv /tmp/conduit-repo/dashboard "$DASHBOARD_DIR"
rm -rf /tmp/conduit-repo
cd "$DASHBOARD_DIR"
npm install --silent 2>/dev/null
echo "  Dashboard installed to $DASHBOARD_DIR"

#
# Step 4: Setup SSH Key + Server
#
echo -e "${YELLOW}[4/6] Setting up SSH...${NC}"

# Ensure SSH server is installed and running (needed for localhost monitoring)
if ! command -v sshd &>/dev/null; then
  echo "  Installing OpenSSH server..."
  apt-get update -qq >/dev/null 2>&1
  apt-get install -y -qq openssh-server >/dev/null 2>&1 || {
    echo -e "  ${YELLOW}Warning: Failed to install openssh-server. SSH monitoring may not work.${NC}"
  }
fi
if ! systemctl is-active --quiet ssh 2>/dev/null && ! systemctl is-active --quiet sshd 2>/dev/null; then
  echo "  Starting SSH server..."
  systemctl enable ssh 2>/dev/null || systemctl enable sshd 2>/dev/null || true
  systemctl start ssh 2>/dev/null || systemctl start sshd 2>/dev/null || true
fi

# Generate SSH key if needed
if [ ! -f ~/.ssh/id_ed25519 ]; then
  mkdir -p ~/.ssh && chmod 700 ~/.ssh
  ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N "" -q
  echo "  Generated new SSH key"
else
  echo "  Using existing SSH key"
fi

# Add SSH key to authorized_keys for localhost monitoring
if ! grep -qF "$(cat ~/.ssh/id_ed25519.pub)" ~/.ssh/authorized_keys 2>/dev/null; then
  cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys
  chmod 600 ~/.ssh/authorized_keys
  echo "  Added key to authorized_keys"
fi

# Verify SSH is accessible on localhost
if ! ssh -o BatchMode=yes -o ConnectTimeout=3 -o StrictHostKeyChecking=no localhost true 2>/dev/null; then
  echo -e "  ${YELLOW}Warning: SSH to localhost failed. Dashboard may not monitor this server.${NC}"
fi

#
# Step 5: Configure and Start Dashboard
#
echo -e "${YELLOW}[5/6] Configuring Dashboard...${NC}"

# Generate secure credentials
PASSWORD=$(openssl rand -base64 12 | tr -d '/+=')
JOIN_TOKEN=$(openssl rand -hex 16)
SESSION_SECRET=$(openssl rand -hex 32)

cat > "$DASHBOARD_DIR/.env" << EOF
PORT=$PORT
DASHBOARD_PASSWORD=$PASSWORD
SESSION_SECRET=$SESSION_SECRET
SSH_KEY_PATH=$HOME/.ssh/id_ed25519
JOIN_TOKEN=$JOIN_TOKEN
EOF

# Create systemd service for dashboard
cat > /etc/systemd/system/conduit-dashboard.service << EOF
[Unit]
Description=Conduit Dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=$DASHBOARD_DIR
ExecStart=/usr/bin/node $DASHBOARD_DIR/server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=HOME=/root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable conduit-dashboard >/dev/null 2>&1
systemctl restart conduit-dashboard
echo "  Dashboard service started"

# Get public IP
PUBLIC_IP=$(curl -4 -s --connect-timeout 5 ifconfig.me 2>/dev/null || curl -4 -s --connect-timeout 5 icanhazip.com 2>/dev/null || hostname -I | awk '{print $1}')

# Wait for dashboard to be ready
sleep 2

# Auto-register this server (localhost) - skip if dashboard only
if [ "$DASHBOARD_ONLY" != "1" ]; then
  # Create conduitmon and add dashboard SSH key so we register with non-root user
  MON_USER="conduitmon"
  if ! id "$MON_USER" >/dev/null 2>&1; then
    useradd -m -s /bin/bash "$MON_USER"
  fi
  install -d -m 700 -o "$MON_USER" -g "$MON_USER" "/home/$MON_USER/.ssh"
  touch "/home/$MON_USER/.ssh/authorized_keys"
  chown "$MON_USER:$MON_USER" "/home/$MON_USER/.ssh/authorized_keys"
  chmod 600 "/home/$MON_USER/.ssh/authorized_keys"
  if ! grep -qF "$(cat ~/.ssh/id_ed25519.pub)" "/home/$MON_USER/.ssh/authorized_keys" 2>/dev/null; then
    cat ~/.ssh/id_ed25519.pub >> "/home/$MON_USER/.ssh/authorized_keys"
    sort -u "/home/$MON_USER/.ssh/authorized_keys" -o "/home/$MON_USER/.ssh/authorized_keys"
    chown "$MON_USER:$MON_USER" "/home/$MON_USER/.ssh/authorized_keys"
  fi
  # Sudoers for conduitmon (limited commands, cross-distro paths)
  mkdir -p /etc/sudoers.d
  cat > /etc/sudoers.d/conduit-dashboard << 'SUDOEOF'
Defaults:conduitmon !requiretty
conduitmon ALL=(root) NOPASSWD: \
  /usr/bin/systemctl * conduit, /bin/systemctl * conduit, \
  /usr/bin/journalctl -u conduit *, /bin/journalctl -u conduit *, \
  /usr/bin/grep ExecStart /etc/systemd/system/conduit.service, /bin/grep ExecStart /etc/systemd/system/conduit.service, \
  /usr/bin/timeout * /usr/bin/tcpdump *, /usr/bin/tcpdump *, /usr/sbin/tcpdump *
SUDOEOF
  chmod 440 /etc/sudoers.d/conduit-dashboard

  LOCAL_HOSTNAME=$(hostname | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g' | cut -c1-20)
  [ -z "$LOCAL_HOSTNAME" ] && LOCAL_HOSTNAME="dashboard"
  curl -sX POST "http://127.0.0.1:$PORT/api/register" \
    -H "Content-Type: application/json" \
    -H "X-Join-Token: $JOIN_TOKEN" \
    -d "{\"name\":\"$LOCAL_HOSTNAME\",\"host\":\"127.0.0.1\",\"user\":\"$MON_USER\"}" >/dev/null 2>&1 || true
fi

#
# Step 6: Domain + SSL Setup (Optional)
#
echo ""
echo -e "${YELLOW}[6/6] Domain Setup (optional)${NC}"
echo -e "  If you have a domain pointing to this server, we can set up HTTPS."
echo -e "  ${CYAN}Press Enter to skip, or type your domain:${NC}"
read -r DOMAIN < /dev/tty

DASHBOARD_URL="http://$PUBLIC_IP:$PORT"

if [ -n "$DOMAIN" ]; then
  echo "  Setting up $DOMAIN..."

  # Install nginx and certbot
  apt-get install -y -qq nginx certbot python3-certbot-nginx >/dev/null 2>&1

  # Create nginx config
  cat > /etc/nginx/sites-available/conduit-dashboard << NGINXEOF
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
}
NGINXEOF

  # Enable site
  ln -sf /etc/nginx/sites-available/conduit-dashboard /etc/nginx/sites-enabled/
  rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
  nginx -t >/dev/null 2>&1 && systemctl reload nginx

  # Get SSL certificate
  echo "  Getting SSL certificate..."
  if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect >/dev/null 2>&1; then
    DASHBOARD_URL="https://$DOMAIN"
    echo -e "  ${GREEN}SSL configured successfully${NC}"
  else
    DASHBOARD_URL="http://$DOMAIN"
    echo -e "  ${YELLOW}SSL failed (domain may not point here yet). Using HTTP.${NC}"
  fi
else
  echo "  Skipped - using http://$PUBLIC_IP:$PORT"
fi

echo ""
echo -e "${GREEN}${BOLD}"
echo "════════════════════════════════════════════════════════════"
echo "                    Setup Complete!"
echo "════════════════════════════════════════════════════════════"
echo -e "${NC}"
echo -e "  ${CYAN}Dashboard:${NC}  $DASHBOARD_URL"
echo -e "  ${CYAN}Password:${NC}   $PASSWORD"
echo ""
echo -e "  ${YELLOW}Save this password! It won't be shown again.${NC}"
echo ""
echo -e "${GREEN}${BOLD}════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  To add other servers, run this on each:${NC}"
echo ""
echo -e "  ${CYAN}curl $CURL_FLAGS \"$DASHBOARD_URL/join/$JOIN_TOKEN\" | sudo bash${NC}"
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
echo ""
if [ "$DASHBOARD_ONLY" = "1" ]; then
  echo -e "  ${CYAN}Note: Dashboard-only mode. No relay installed on this server.${NC}"
  echo ""
fi
