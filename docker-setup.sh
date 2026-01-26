#!/bin/bash
# Conduit Docker Setup
# Run: curl -sL https://raw.githubusercontent.com/paradixe/conduit-relay/main/docker-setup.sh | sudo bash
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

# Check/install Docker
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

# Create conduit directory
echo -e "${YELLOW}[2/5] Setting up files...${NC}"
CONDUIT_DIR="${CONDUIT_DIR:-/opt/conduit}"
mkdir -p "$CONDUIT_DIR"
cd "$CONDUIT_DIR"

# Download compose files
curl -sLO https://raw.githubusercontent.com/paradixe/conduit-relay/main/docker-compose.yml
echo "  Downloaded docker-compose.yml"

# Generate credentials
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

# Ask about domain for HTTPS
echo ""
echo -e "${YELLOW}[4/5] HTTPS Setup${NC}"
echo -e "  If you have a domain pointing to this server, we can set up HTTPS."
echo -e "  ${CYAN}Press Enter to skip, or type your domain:${NC}"
read -r DOMAIN < /dev/tty

DASHBOARD_URL="http://$PUBLIC_IP:3000"
COMPOSE_PROFILES=""
DASHBOARD_PORT="3000"

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
  DASHBOARD_PORT=""  # Don't expose 3000 directly when using Caddy

  echo -e "  ${GREEN}HTTPS will be configured automatically${NC}"
else
  echo "  Skipping HTTPS (using HTTP on port 3000)"
fi

# Create .env file
cat > "$CONDUIT_DIR/.env" << EOF
# Conduit Docker Configuration
DASHBOARD_PASSWORD=$PASSWORD
SESSION_SECRET=$SESSION_SECRET
JOIN_TOKEN=$JOIN_TOKEN

# Domain for HTTPS (leave empty for HTTP-only)
DOMAIN=$DOMAIN

# Dashboard port (empty = don't expose directly, use Caddy)
DASHBOARD_PORT=$DASHBOARD_PORT

# Relay settings
MAX_CLIENTS=200
BANDWIDTH=-1

# SSH key for monitoring remote relays
SSH_KEY_PATH=$HOME/.ssh/id_ed25519
EOF
echo "  Created .env file"

# Start containers
echo -e "${YELLOW}[5/5] Starting containers...${NC}"
docker compose pull
docker compose $COMPOSE_PROFILES up -d

# Wait for services
sleep 3

# Verify HTTPS if domain was set
if [ -n "$DOMAIN" ]; then
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
else
  JOIN_URL="http://$PUBLIC_IP:3000/join/$JOIN_TOKEN"
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
echo -e "  ${CYAN}curl -sL \"$JOIN_URL\" | sudo bash${NC}"
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${CYAN}Useful commands:${NC}"
echo "    cd $CONDUIT_DIR"
echo "    docker compose logs -f              # View logs"
echo "    docker compose pull && docker compose $COMPOSE_PROFILES up -d  # Update"
echo "    docker compose down                 # Stop"
echo ""
