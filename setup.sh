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

# Binary sources
PRIMARY_URL="https://raw.githubusercontent.com/paradixe/conduit-relay/main/bin/conduit-linux-amd64"
FALLBACK_REPO="ssmirr/conduit"

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

#
# Step 1: Install Conduit Relay (skip if DASHBOARD_ONLY=1)
#
if [ "$DASHBOARD_ONLY" = "1" ]; then
  echo -e "${YELLOW}[1/6] Skipping Conduit Relay (dashboard only mode)${NC}"
else
  echo -e "${YELLOW}[1/6] Installing Conduit Relay...${NC}"

  # Install dependencies
  apt-get update -qq && apt-get install -y -qq geoip-bin curl git >/dev/null 2>&1 || true

  # Download binary
  if curl -sL "$PRIMARY_URL" -o "$INSTALL_DIR/conduit" && [ -s "$INSTALL_DIR/conduit" ]; then
    echo "  Downloaded conduit binary"
  else
    echo "  Primary failed, trying fallback..."
    LATEST=$(curl -s "https://api.github.com/repos/$FALLBACK_REPO/releases/latest" | grep -oP '"tag_name": "\K[^"]+')
    if [ -z "$LATEST" ]; then
      echo -e "${RED}Failed to download conduit${NC}"
      exit 1
    fi
    curl -sL "https://github.com/$FALLBACK_REPO/releases/download/$LATEST/conduit-linux-amd64" -o "$INSTALL_DIR/conduit"
  fi
  chmod +x "$INSTALL_DIR/conduit"

  # Verify
  if ! "$INSTALL_DIR/conduit" --version >/dev/null 2>&1; then
    echo -e "${RED}Binary verification failed${NC}"
    exit 1
  fi
  echo -e "  Version: $($INSTALL_DIR/conduit --version)"

  # Create data dir and service
  mkdir -p "$DATA_DIR"
  cat > /etc/systemd/system/conduit.service << EOF
[Unit]
Description=Conduit Relay
After=network.target

[Service]
Type=simple
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
# Step 4: Setup SSH Key
#
echo -e "${YELLOW}[4/6] Setting up SSH key...${NC}"
if [ ! -f ~/.ssh/id_ed25519 ]; then
  mkdir -p ~/.ssh && chmod 700 ~/.ssh
  ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N "" -q
  echo "  Generated new SSH key"
else
  echo "  Using existing SSH key"
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
  LOCAL_HOSTNAME=$(hostname | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g' | cut -c1-20)
  [ -z "$LOCAL_HOSTNAME" ] && LOCAL_HOSTNAME="dashboard"
  curl -sX POST "http://localhost:$PORT/api/register" \
    -H "Content-Type: application/json" \
    -H "X-Join-Token: $JOIN_TOKEN" \
    -d "{\"name\":\"$LOCAL_HOSTNAME\",\"host\":\"localhost\",\"user\":\"root\"}" >/dev/null 2>&1 || true
fi

#
# Step 6: Domain + SSL Setup (Optional)
#
echo ""
echo -e "${YELLOW}[6/6] Domain Setup (optional)${NC}"
echo -e "  If you have a domain pointing to this server, we can set up HTTPS."
echo -e "  ${CYAN}Press Enter to skip, or type your domain:${NC}"
read -r DOMAIN

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
echo -e "  ${CYAN}curl -sL \"$DASHBOARD_URL/join/$JOIN_TOKEN\" | bash${NC}"
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
echo ""
if [ "$DASHBOARD_ONLY" = "1" ]; then
  echo -e "  ${CYAN}Note: Dashboard-only mode. No relay installed on this server.${NC}"
  echo ""
fi
