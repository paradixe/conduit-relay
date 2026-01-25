#!/bin/bash
# Conduit stats - live stats + geo breakdown
# Usage: ./conduit-stats.sh [--geo] [--live]

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

show_stats() {
  clear
  echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}${CYAN}║         CONDUIT RELAY STATS              ║${NC}"
  echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════╝${NC}"
  echo ""

  # Get conduit status
  if systemctl is-active conduit &>/dev/null; then
    STATUS="${GREEN}● running${NC}"
  else
    STATUS="${RED}○ stopped${NC}"
  fi

  # Get latest stats from journal
  LATEST=$(journalctl -u conduit -n 50 --no-pager 2>/dev/null | grep STATS | tail -1)

  if [ -n "$LATEST" ]; then
    CLIENTS=$(echo "$LATEST" | grep -oP 'Connected:\s*\K\d+' || echo "0")
    CONNECTING=$(echo "$LATEST" | grep -oP 'Connecting:\s*\K\d+' || echo "0")
    UPLOAD=$(echo "$LATEST" | grep -oP 'Up:\s*\K[^\|]+' | tr -d ' ' || echo "-")
    DOWNLOAD=$(echo "$LATEST" | grep -oP 'Down:\s*\K[^\|]+' | tr -d ' ' || echo "-")
    UPTIME=$(echo "$LATEST" | grep -oP 'Uptime:\s*\K\S+' || echo "-")
  else
    CLIENTS="-"; CONNECTING="-"; UPLOAD="-"; DOWNLOAD="-"; UPTIME="-"
  fi

  # Get config from systemd
  CONFIG=$(grep ExecStart /etc/systemd/system/conduit.service 2>/dev/null)
  MAX_CLIENTS=$(echo "$CONFIG" | grep -oP '\-m\s*\K\d+' || echo "?")
  BANDWIDTH=$(echo "$CONFIG" | grep -oP '\-b\s*\K-?\d+' || echo "?")
  [ "$BANDWIDTH" = "-1" ] && BANDWIDTH="∞"

  echo -e "  Status:     $STATUS"
  echo -e "  Config:     ${YELLOW}-m $MAX_CLIENTS${NC}  ${YELLOW}-b $BANDWIDTH${NC}"
  echo ""
  echo -e "  ${BOLD}Clients${NC}     ${GREEN}$CLIENTS${NC} connected, $CONNECTING connecting"
  echo -e "  ${BOLD}Upload${NC}      $UPLOAD"
  echo -e "  ${BOLD}Download${NC}    $DOWNLOAD"
  echo -e "  ${BOLD}Uptime${NC}      $UPTIME"
  echo ""
}

show_geo() {
  echo -e "${BOLD}${CYAN}─── Client Locations (sampling 30s) ───${NC}"
  echo ""

  # Check geoip
  if ! command -v geoiplookup &>/dev/null; then
    echo "Installing geoip-bin..."
    apt-get update -qq && apt-get install -y -qq geoip-bin >/dev/null 2>&1
  fi

  # Capture
  STATS=$(timeout 30 tcpdump -ni any 'inbound and (tcp or udp)' -c 300 2>/dev/null | \
    awk '{print $5}' | cut -d. -f1-4 | grep -E '^[0-9]+\.' | sort -u | \
    xargs -I{} sh -c 'geoiplookup {} 2>/dev/null | grep -v "not found"' | \
    awk -F': ' '{print $2}' | sort | uniq -c | sort -rn)

  if [ -z "$STATS" ]; then
    echo "  No connections captured"
    return
  fi

  TOTAL=$(echo "$STATS" | awk '{sum+=$1} END {print sum}')
  echo -e "  Unique IPs: ${YELLOW}$TOTAL${NC}"
  echo ""

  MAX=$(echo "$STATS" | head -1 | awk '{print $1}')
  echo "$STATS" | head -10 | while read count country; do
    CODE=$(echo "$country" | cut -d',' -f1)
    NAME=$(echo "$country" | cut -d',' -f2- | sed 's/^ *//' | cut -c1-18)
    BAR_W=$((count * 25 / MAX))
    BAR=$(printf '%*s' "$BAR_W" | tr ' ' '█')
    if [ "$CODE" = "IR" ]; then
      printf "  ${GREEN}%3d  %-2s %-18s %s${NC}\n" "$count" "$CODE" "$NAME" "$BAR"
    else
      printf "  %3d  %-2s %-18s %s\n" "$count" "$CODE" "$NAME" "$BAR"
    fi
  done
  echo ""
}

usage() {
  echo "Usage: $0 [options]"
  echo ""
  echo "Options:"
  echo "  --live    Refresh stats every 5s"
  echo "  --geo     Include geo breakdown (takes 30s to sample)"
  echo "  --help    Show this help"
  echo ""
  echo "Examples:"
  echo "  $0              # Show current stats"
  echo "  $0 --live       # Live updating stats"
  echo "  $0 --geo        # Stats + geo breakdown"
  echo "  $0 --live --geo # Live stats with periodic geo"
}

# Parse args
LIVE=false
GEO=false
for arg in "$@"; do
  case $arg in
    --live) LIVE=true ;;
    --geo) GEO=true ;;
    --help|-h) usage; exit 0 ;;
  esac
done

# Main
if $LIVE; then
  GEO_COUNTER=0
  while true; do
    show_stats
    if $GEO && [ $((GEO_COUNTER % 12)) -eq 0 ]; then
      show_geo
    fi
    GEO_COUNTER=$((GEO_COUNTER + 1))
    echo -e "${CYAN}Refreshing in 5s... (Ctrl+C to exit)${NC}"
    sleep 5
  done
else
  show_stats
  $GEO && show_geo
fi
