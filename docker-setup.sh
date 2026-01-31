#!/bin/bash
# Conduit Docker Setup
# Run: curl -sL https://raw.githubusercontent.com/paradixe/conduit-relay/main/docker-setup.sh | sudo bash
#
# Handles:
# - Fresh install
# - Migration from native (systemd) to Docker
# - Detection of existing Docker containers
set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${CYAN}${BOLD}"
echo "╔═══════════════════════════════════════════════╗"
echo "║     Conduit Docker Setup                      ║"
echo "╚═══════════════════════════════════════════════╝"
echo -e "${NC}"

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Please run as root (sudo)${NC}"
  exit 1
fi

# ════════════════════════════════════════════════════════════════
# Detection: What's already installed?
# ════════════════════════════════════════════════════════════════

HAS_NATIVE=false
HAS_DOCKER=false
EXISTING_CONTAINER=""
NATIVE_KEY_PATH="/var/lib/conduit/conduit_key.json"

# Check for native installation
if [ -f /usr/local/bin/conduit ] || [ -f /etc/systemd/system/conduit.service ]; then
  HAS_NATIVE=true
fi

# Check for existing Docker containers (both naming conventions)
if command -v docker &>/dev/null; then
  EXISTING_CONTAINER=$(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -E '^conduit(-relay)?$' | head -1 || true)
  [ -n "$EXISTING_CONTAINER" ] && HAS_DOCKER=true
fi

# ════════════════════════════════════════════════════════════════
# Handle existing installations
# ════════════════════════════════════════════════════════════════

if $HAS_DOCKER; then
  echo -e "${YELLOW}Existing Docker container detected: ${EXISTING_CONTAINER}${NC}"
  echo ""
  echo "Options:"
  echo "  1. Exit and keep existing setup"
  echo "  2. Remove existing and start fresh"
  echo ""
  read -r -p "Choice [1]: " DOCKER_CHOICE < /dev/tty

  if [ "$DOCKER_CHOICE" = "2" ]; then
    echo "Stopping and removing existing container..."
    docker stop "$EXISTING_CONTAINER" 2>/dev/null || true
    docker rm "$EXISTING_CONTAINER" 2>/dev/null || true
    echo -e "${GREEN}Removed $EXISTING_CONTAINER${NC}"
  else
    echo "Keeping existing setup. Exiting."
    exit 0
  fi
fi

if $HAS_NATIVE; then
  echo -e "${YELLOW}Native (systemd) installation detected${NC}"
  echo ""
  echo "This will migrate your relay to Docker."

  if [ -f "$NATIVE_KEY_PATH" ]; then
    echo -e "  ${GREEN}✓${NC} Relay key found - will be preserved (keeps your reputation)"
  else
    echo -e "  ${YELLOW}!${NC} No relay key found at $NATIVE_KEY_PATH"
  fi

  echo ""
  read -r -p "Migrate to Docker? [y/N]: " MIGRATE_CHOICE < /dev/tty

  if [[ ! "$MIGRATE_CHOICE" =~ ^[Yy]$ ]]; then
    echo "Migration cancelled."
    exit 0
  fi

  echo ""
  echo "Migrating..."

  # Stop native services
  echo "  Stopping native services..."
  systemctl stop conduit 2>/dev/null || true
  systemctl stop conduit-dashboard 2>/dev/null || true
  systemctl disable conduit 2>/dev/null || true
  systemctl disable conduit-dashboard 2>/dev/null || true

  # We'll copy the key after Docker volume is created
  MIGRATE_KEY=true

  echo -e "  ${GREEN}Native services stopped${NC}"
  echo ""
fi

# ════════════════════════════════════════════════════════════════
# Install Docker if needed
# ════════════════════════════════════════════════════════════════

echo -e "${YELLOW}[1/5] Checking Docker...${NC}"
if ! command -v docker &>/dev/null; then
  echo "  Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
  echo -e "  ${GREEN}Docker installed${NC}"
else
  echo "  Docker already installed"
fi

# Check Docker Compose
if ! docker compose version &>/dev/null; then
  echo -e "${RED}Docker Compose plugin required. Install with: apt install docker-compose-plugin${NC}"
  exit 1
fi

# ════════════════════════════════════════════════════════════════
# Setup files
# ════════════════════════════════════════════════════════════════

echo -e "${YELLOW}[2/5] Setting up files...${NC}"
CONDUIT_DIR="${CONDUIT_DIR:-/opt/conduit}"
mkdir -p "$CONDUIT_DIR"
cd "$CONDUIT_DIR"

# Download compose files
curl -sLO https://raw.githubusercontent.com/paradixe/conduit-relay/main/docker-compose.yml
echo "  Downloaded docker-compose.yml"

# ════════════════════════════════════════════════════════════════
# Generate credentials
# ════════════════════════════════════════════════════════════════

echo -e "${YELLOW}[3/5] Generating credentials...${NC}"
PASSWORD=$(openssl rand -base64 12 | tr -d '/+=')
SESSION_SECRET=$(openssl rand -hex 32)
JOIN_TOKEN=$(openssl rand -hex 16)

# Generate SSH key if needed
if [ ! -f ~/.ssh/id_ed25519 ]; then
  mkdir -p ~/.ssh && chmod 700 ~/.ssh
  ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N "" -q
  echo "  Generated new SSH key"
else
  echo "  Using existing SSH key"
fi

# Get public IP
PUBLIC_IP=$(curl -4s --connect-timeout 5 ifconfig.me 2>/dev/null || curl -4s --connect-timeout 5 icanhazip.com 2>/dev/null || hostname -I | awk '{print $1}')

# ════════════════════════════════════════════════════════════════
# HTTPS Setup
# ════════════════════════════════════════════════════════════════

echo ""
echo -e "${YELLOW}[4/5] HTTPS Setup - Valid Domain${NC}"
echo -e "  If you have a domain pointing to this server, we can set up a valid HTTPS for your domain."
echo -e "  ${CYAN}Press Enter to skip, or type your domain:${NC}"
read -r DOMAIN < /dev/tty

DASHBOARD_URL="http://$PUBLIC_IP:3000"
COMPOSE_PROFILES=""
CURL_FLAGS="-sL"
ENABLE_HTTPS="false"

if [ -n "$DOMAIN" ]; then
  echo "  Setting up HTTPS for $DOMAIN..."

  # Create Caddyfile for automatic HTTPS
  cat > "$CONDUIT_DIR/Caddyfile" << CADDYEOF
$DOMAIN {
    reverse_proxy dashboard:3000
}
CADDYEOF
  echo "  Created Caddyfile"

  DASHBOARD_URL="https://$DOMAIN"
  COMPOSE_PROFILES="--profile https"
  CURL_FLAGS="-sL"
  ENABLE_HTTPS="false"

  echo -e "  ${GREEN}HTTPS will be configured automatically${NC}"
else
  echo "  Skipped domain setup"
  echo ""
  echo -e "${YELLOW}Self-Signed SSL Certificate${NC}"
  echo -e "  Although you don't have a valid domain, you can use a self-signed"
  echo -e "  certificate for better security for administration tasks."
  echo ""
  read -r -p "Enable self-signed SSL? [y/N]: " USE_SELFSIGNED < /dev/tty
  
  if [[ "$USE_SELFSIGNED" =~ ^[Yy]$ ]]; then
    echo "  Self-signed SSL will be enabled"
    DASHBOARD_URL="https://$PUBLIC_IP:3000"
    CURL_FLAGS="-skL"
    ENABLE_HTTPS="true"
  else
    echo "  Using HTTP (no encryption)"
  fi
fi

# Create .env file
cat > "$CONDUIT_DIR/.env" << EOF
# Conduit Docker Configuration
DASHBOARD_PASSWORD=$PASSWORD
SESSION_SECRET=$SESSION_SECRET
JOIN_TOKEN=$JOIN_TOKEN
ENABLE_HTTPS=$ENABLE_HTTPS

# Domain for HTTPS (leave empty for HTTP-only)
DOMAIN=$DOMAIN

# Relay settings
MAX_CLIENTS=200
BANDWIDTH=-1

# SSH key for monitoring remote relays
SSH_KEY_PATH=$HOME/.ssh/id_ed25519
EOF
echo "  Created .env file"

# ════════════════════════════════════════════════════════════════
# Start containers
# ════════════════════════════════════════════════════════════════

echo -e "${YELLOW}[5/5] Starting containers...${NC}"
docker compose pull
docker compose $COMPOSE_PROFILES up -d

# Wait for containers to start
sleep 3

# ════════════════════════════════════════════════════════════════
# Migrate relay key if needed
# ════════════════════════════════════════════════════════════════

if [ "${MIGRATE_KEY:-false}" = true ] && [ -f "$NATIVE_KEY_PATH" ]; then
  echo ""
  echo -e "${YELLOW}Migrating relay key...${NC}"

  # Copy key into the Docker volume (ssmirr image uses /home/conduit/data)
  docker cp "$NATIVE_KEY_PATH" conduit-relay:/home/conduit/data/conduit_key.json 2>/dev/null || \
  docker cp "$NATIVE_KEY_PATH" conduit:/home/conduit/data/conduit_key.json 2>/dev/null || true

  # Restart relay to pick up the key
  docker restart conduit-relay 2>/dev/null || docker restart conduit 2>/dev/null || true

  echo -e "  ${GREEN}Relay key migrated - your reputation is preserved!${NC}"
fi

# ════════════════════════════════════════════════════════════════
# Verify HTTPS
# ════════════════════════════════════════════════════════════════

if [ -n "$DOMAIN" ]; then
  echo ""
  echo "  Waiting for HTTPS certificate..."
  sleep 5
  if curl -sI "https://$DOMAIN" 2>/dev/null | grep -q "200\|301\|302"; then
    echo -e "  ${GREEN}HTTPS is working!${NC}"
  else
    echo -e "  ${YELLOW}Note: HTTPS may take a moment to provision. If it doesn't work, ensure:${NC}"
    echo -e "  ${YELLOW}  - Domain DNS points to this server ($PUBLIC_IP)${NC}"
    echo -e "  ${YELLOW}  - Ports 80 and 443 are open${NC}"
    DASHBOARD_URL="http://$PUBLIC_IP:3000"
  fi
fi

# Build join URL based on what's accessible
if [ -n "$DOMAIN" ]; then
  JOIN_URL="https://$DOMAIN/join/$JOIN_TOKEN"
elif [ "$ENABLE_HTTPS" = true ]; then
  JOIN_URL="https://$PUBLIC_IP:3000/join/$JOIN_TOKEN"
else
  JOIN_URL="http://$PUBLIC_IP:3000/join/$JOIN_TOKEN"
fi

# ════════════════════════════════════════════════════════════════
# Done!
# ════════════════════════════════════════════════════════════════

echo ""
echo -e "${GREEN}${BOLD}"
echo "════════════════════════════════════════════════════════════"
if [ "${MIGRATE_KEY:-false}" = true ]; then
echo "                Migration Complete!"
else
echo "                    Setup Complete!"
fi
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
echo -e "  ${CYAN}curl $CURL_FLAGS \"$JOIN_URL\" | sudo bash${NC}"
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${CYAN}Useful commands:${NC}"
echo "    cd $CONDUIT_DIR"
echo "    docker compose logs -f                                         # View logs"
echo "    docker compose pull && docker compose $COMPOSE_PROFILES up -d                   # Update"
echo "    docker compose down                                            # Stop"
echo ""
