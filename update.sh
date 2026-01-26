#!/bin/bash
# Smart update script for Conduit relay and dashboard
# Run on any server - figures out what needs updating
set -e

REPO="ssmirr/conduit"
DASHBOARD_REPO="paradixe/conduit-relay"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}Conduit Update${NC}"
echo ""

# Detect what's installed
HAS_RELAY=false
HAS_DASHBOARD=false
[ -f /usr/local/bin/conduit ] && HAS_RELAY=true
[ -d /opt/conduit-dashboard ] && HAS_DASHBOARD=true

if [ "$HAS_RELAY" = false ] && [ "$HAS_DASHBOARD" = false ]; then
  echo "Nothing installed. Run setup.sh first."
  exit 1
fi

# Check relay update
if [ "$HAS_RELAY" = true ]; then
  CURRENT=$(/usr/local/bin/conduit --version 2>/dev/null | awk '{print $3}' || echo "unknown")
  LATEST=$(curl -s "https://api.github.com/repos/$REPO/releases/latest" | grep -oP '"tag_name": "\K[^"]+' || echo "")

  echo -e "Relay: ${GREEN}$CURRENT${NC} (latest: $LATEST)"

  if [ -n "$LATEST" ] && [ "$CURRENT" != "$LATEST" ]; then
    echo -e "${YELLOW}Updating relay...${NC}"
    curl -sL "https://github.com/$REPO/releases/download/$LATEST/conduit-linux-amd64" -o /usr/local/bin/conduit.new
    if [ -s /usr/local/bin/conduit.new ]; then
      chmod +x /usr/local/bin/conduit.new
      systemctl stop conduit 2>/dev/null || true
      mv /usr/local/bin/conduit.new /usr/local/bin/conduit
      systemctl start conduit 2>/dev/null || true
      echo -e "${GREEN}Relay updated to $LATEST${NC}"
    else
      rm -f /usr/local/bin/conduit.new
      echo -e "${RED}Download failed${NC}"
    fi
  else
    echo "  Already up to date"
  fi
fi

# Check dashboard update
if [ "$HAS_DASHBOARD" = true ]; then
  echo ""
  LOCAL_HASH=$(cd /opt/conduit-dashboard && git rev-parse --short HEAD 2>/dev/null || echo "unknown")
  REMOTE_HASH=$(curl -s "https://api.github.com/repos/$DASHBOARD_REPO/commits/main" | grep -oP '"sha": "\K[^"]+' | head -1 | cut -c1-7 || echo "")

  echo -e "Dashboard: ${GREEN}$LOCAL_HASH${NC} (latest: $REMOTE_HASH)"

  if [ -n "$REMOTE_HASH" ] && [ "$LOCAL_HASH" != "$REMOTE_HASH" ]; then
    echo -e "${YELLOW}Updating dashboard...${NC}"
    rm -rf /tmp/conduit-update
    git clone --depth 1 -q "https://github.com/$DASHBOARD_REPO.git" /tmp/conduit-update

    # Preserve config
    cp /opt/conduit-dashboard/.env /tmp/conduit-update/dashboard/.env 2>/dev/null || true
    cp /opt/conduit-dashboard/servers.json /tmp/conduit-update/dashboard/servers.json 2>/dev/null || true
    cp /opt/conduit-dashboard/stats.db /tmp/conduit-update/dashboard/stats.db 2>/dev/null || true

    # Replace dashboard
    rm -rf /opt/conduit-dashboard.bak
    mv /opt/conduit-dashboard /opt/conduit-dashboard.bak
    mv /tmp/conduit-update/dashboard /opt/conduit-dashboard
    cd /opt/conduit-dashboard && npm install --silent 2>/dev/null

    systemctl restart conduit-dashboard 2>/dev/null || true
    rm -rf /tmp/conduit-update /opt/conduit-dashboard.bak
    echo -e "${GREEN}Dashboard updated to $REMOTE_HASH${NC}"
  else
    echo "  Already up to date"
  fi
fi

echo ""
echo -e "${GREEN}Done${NC}"
