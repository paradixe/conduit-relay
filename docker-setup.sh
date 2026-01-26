#!/bin/bash
# Conduit Docker Setup
# Run: curl -sL https://raw.githubusercontent.com/paradixe/conduit-relay/main/docker-setup.sh | bash
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
echo -e "${YELLOW}[1/4] Checking Docker...${NC}"
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
echo -e "${YELLOW}[2/4] Setting up files...${NC}"
CONDUIT_DIR="${CONDUIT_DIR:-/opt/conduit}"
mkdir -p "$CONDUIT_DIR"
cd "$CONDUIT_DIR"

# Download compose files
curl -sLO https://raw.githubusercontent.com/paradixe/conduit-relay/main/docker-compose.yml
echo "  Downloaded docker-compose.yml"

# Generate credentials
echo -e "${YELLOW}[3/4] Generating credentials...${NC}"
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

# Create .env file
cat > "$CONDUIT_DIR/.env" << EOF
# Conduit Docker Configuration
PORT=3000
DASHBOARD_PASSWORD=$PASSWORD
SESSION_SECRET=$SESSION_SECRET
JOIN_TOKEN=$JOIN_TOKEN

# Relay settings
MAX_CLIENTS=200
BANDWIDTH=-1

# SSH key for monitoring remote relays
SSH_KEY_PATH=$HOME/.ssh/id_ed25519
EOF
echo "  Created .env file"

# Start containers
echo -e "${YELLOW}[4/4] Starting containers...${NC}"
docker compose pull
docker compose up -d

# Wait for services
sleep 3

# Get public IP
PUBLIC_IP=$(curl -4s --connect-timeout 5 ifconfig.me 2>/dev/null || curl -4s --connect-timeout 5 icanhazip.com 2>/dev/null || hostname -I | awk '{print $1}')

echo ""
echo -e "${GREEN}${BOLD}"
echo "════════════════════════════════════════════════════════════"
echo "                    Setup Complete!"
echo "════════════════════════════════════════════════════════════"
echo -e "${NC}"
echo -e "  ${CYAN}Dashboard:${NC}  http://$PUBLIC_IP:3000"
echo -e "  ${CYAN}Password:${NC}   $PASSWORD"
echo ""
echo -e "  ${YELLOW}Save this password! It won't be shown again.${NC}"
echo ""
echo -e "${GREEN}${BOLD}════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  To add other servers, run this on each:${NC}"
echo ""
echo -e "  ${CYAN}curl -sL \"http://$PUBLIC_IP:3000/join/$JOIN_TOKEN\" | sudo bash${NC}"
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${CYAN}Useful commands:${NC}"
echo "    docker compose logs -f          # View logs"
echo "    docker compose pull && up -d    # Update"
echo "    docker compose down             # Stop"
echo ""
