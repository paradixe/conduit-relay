#!/bin/bash
# Conduit Relay + Dashboard Uninstaller
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}Conduit Uninstaller${NC}"
echo ""

if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Please run as root (sudo)${NC}"
  exit 1
fi

echo "This will remove:"
echo "  - Conduit relay service and binary"
echo "  - Conduit dashboard service and files"
echo ""
read -r -p "Continue? [y/N]: " CONFIRM < /dev/tty
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

echo ""

# Stop and remove relay
if systemctl is-active --quiet conduit 2>/dev/null; then
  echo "Stopping conduit relay..."
  systemctl stop conduit
fi
if [ -f /etc/systemd/system/conduit.service ]; then
  echo "Removing conduit service..."
  systemctl disable conduit 2>/dev/null || true
  rm -f /etc/systemd/system/conduit.service
fi
if [ -f /usr/local/bin/conduit ]; then
  echo "Removing conduit binary..."
  rm -f /usr/local/bin/conduit
fi
if [ -d /var/lib/conduit ]; then
  echo "Removing conduit data..."
  rm -rf /var/lib/conduit
fi

# Stop and remove dashboard
if systemctl is-active --quiet conduit-dashboard 2>/dev/null; then
  echo "Stopping dashboard..."
  systemctl stop conduit-dashboard
fi
if [ -f /etc/systemd/system/conduit-dashboard.service ]; then
  echo "Removing dashboard service..."
  systemctl disable conduit-dashboard 2>/dev/null || true
  rm -f /etc/systemd/system/conduit-dashboard.service
fi
if [ -d /opt/conduit-dashboard ]; then
  echo "Removing dashboard files..."
  rm -rf /opt/conduit-dashboard
fi

# Reload systemd
systemctl daemon-reload

echo ""
echo -e "${GREEN}Uninstall complete.${NC}"
