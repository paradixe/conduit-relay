#!/bin/bash
# Conduit geo stats - shows where your clients are connecting from
# Usage: ./geo-stats.sh [seconds]
# Requires: geoip-bin (apt install geoip-bin)

DURATION=${1:-30}
SAMPLE_COUNT=${2:-500}

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Check deps
if ! command -v geoiplookup &>/dev/null; then
  echo "Installing geoip-bin..."
  apt-get update -qq && apt-get install -y -qq geoip-bin
fi

if ! command -v tcpdump &>/dev/null; then
  echo "Error: tcpdump not found"
  exit 1
fi

echo -e "${CYAN}Capturing traffic for ${DURATION}s (max ${SAMPLE_COUNT} packets)...${NC}"
echo ""

# Capture unique IPs and look up countries
STATS=$(timeout "$DURATION" tcpdump -ni any 'inbound and (tcp or udp)' -c "$SAMPLE_COUNT" 2>/dev/null | \
  awk '{print $5}' | \
  cut -d. -f1-4 | \
  grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | \
  sort -u | \
  xargs -I{} sh -c 'geoiplookup {} 2>/dev/null | grep -v "not found"' | \
  awk -F': ' '{print $2}' | \
  sort | uniq -c | sort -rn)

if [ -z "$STATS" ]; then
  echo "No connections captured. Is conduit running?"
  exit 0
fi

# Count totals
TOTAL_IPS=$(echo "$STATS" | awk '{sum+=$1} END {print sum}')
TOTAL_COUNTRIES=$(echo "$STATS" | wc -l)

echo -e "${GREEN}=== Client Locations ===${NC}"
echo -e "Unique IPs: ${YELLOW}$TOTAL_IPS${NC} from ${YELLOW}$TOTAL_COUNTRIES${NC} countries"
echo ""

# Show top countries with bar chart
MAX_COUNT=$(echo "$STATS" | head -1 | awk '{print $1}')
echo "$STATS" | head -15 | while read count country; do
  # Extract country code and name
  CODE=$(echo "$country" | cut -d',' -f1)
  NAME=$(echo "$country" | cut -d',' -f2- | sed 's/^ *//' | cut -c1-20)

  # Calculate bar width (max 30 chars)
  BAR_WIDTH=$((count * 30 / MAX_COUNT))
  BAR=$(printf '%*s' "$BAR_WIDTH" | tr ' ' '█')

  # Color Iran green
  if [ "$CODE" = "IR" ]; then
    printf "${GREEN}%4d  %-2s  %-20s %s${NC}\n" "$count" "$CODE" "$NAME" "$BAR"
  else
    printf "%4d  %-2s  %-20s %s\n" "$count" "$CODE" "$NAME" "$BAR"
  fi
done

echo ""
echo -e "${CYAN}Run again: ./geo-stats.sh [seconds] [max-packets]${NC}"
