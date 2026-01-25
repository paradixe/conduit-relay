#!/bin/bash
# Fleet management for Conduit relays
# Run from your local machine

set -e

SERVERS_FILE="${SERVERS_FILE:-$HOME/.conduit-servers}"
REPO="ssmirr/conduit"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

usage() {
  echo "Usage: $0 <command> [args]"
  echo ""
  echo "Commands:"
  echo "  add <name> <ip> [user]    Add a server (default user: root)"
  echo "  remove <name>             Remove a server"
  echo "  list                      List all servers"
  echo "  install [name|all]        Install conduit on server(s)"
  echo "  update [name|all]         Update conduit on server(s)"
  echo "  status [name|all]         Check status of server(s)"
  echo "  start [name|all]          Start conduit on server(s)"
  echo "  stop [name|all]           Stop conduit on server(s)"
  echo "  logs <name>               Tail logs from a server"
  echo "  dashboard <name> <pass>   Deploy dashboard to a server"
  echo ""
  echo "Servers stored in: $SERVERS_FILE"
}

get_server() {
  grep -m 1 "^$1:" "$SERVERS_FILE" 2>/dev/null
}

get_host() {
  echo "$1" | cut -d: -f2
}

get_user() {
  echo "$1" | cut -d: -f3
}

all_servers() {
  [ -f "$SERVERS_FILE" ] && cat "$SERVERS_FILE" | cut -d: -f1
}

run_on() {
  local name=$1
  local cmd=$2
  local server=$(get_server "$name")
  if [ -z "$server" ]; then
    echo -e "${RED}Server '$name' not found${NC}"
    return 1
  fi
  local host=$(get_host "$server")
  local user=$(get_user "$server")
  ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new "${user}@${host}" "$cmd"
}

cmd_add() {
  local name=$1 ip=$2 user=${3:-root}
  [ -z "$name" ] || [ -z "$ip" ] && { echo "Usage: $0 add <name> <ip> [user]"; exit 1; }

  if get_server "$name" >/dev/null; then
    echo -e "${YELLOW}Server '$name' already exists${NC}"
    exit 1
  fi

  echo "$name:$ip:$user" >> "$SERVERS_FILE"
  echo -e "${GREEN}Added $name ($user@$ip)${NC}"
}

cmd_remove() {
  local name=$1
  [ -z "$name" ] && { echo "Usage: $0 remove <name>"; exit 1; }

  if [ "$(uname)" = "Darwin" ]; then
    sed -i '' "/^$name:/d" "$SERVERS_FILE"
  else
    sed -i "/^$name:/d" "$SERVERS_FILE"
  fi
  echo -e "${GREEN}Removed $name${NC}"
}

cmd_list() {
  if [ ! -f "$SERVERS_FILE" ] || [ ! -s "$SERVERS_FILE" ]; then
    echo "No servers configured. Add with: $0 add <name> <ip>"
    exit 0
  fi
  echo "NAME          HOST              USER"
  echo "----          ----              ----"
  while IFS=: read -r name host user; do
    printf "%-12s  %-16s  %s\n" "$name" "$host" "$user"
  done < "$SERVERS_FILE"
}

cmd_install() {
  local target=${1:-all}
  local servers

  if [ "$target" = "all" ]; then
    servers=$(all_servers)
  else
    servers=$target
  fi

  # Configuration (override with env vars: MAX_CLIENTS=500 BANDWIDTH=100 ./fleet.sh install all)
  local max_clients=${MAX_CLIENTS:-200}
  local bandwidth=${BANDWIDTH:--1}

  for name in $servers; do
    echo -e "${YELLOW}[$name]${NC} Installing (m=$max_clients, b=$bandwidth)..."
    if run_on "$name" "curl -sL 'https://raw.githubusercontent.com/paradixe/conduit-relay/main/install.sh' | MAX_CLIENTS=$max_clients BANDWIDTH=$bandwidth bash" 2>&1; then
      echo -e "${GREEN}[$name]${NC} Done"
    else
      echo -e "${RED}[$name]${NC} Failed"
    fi
  done
}

cmd_update() {
  local target=${1:-all}
  local servers

  if [ "$target" = "all" ]; then
    servers=$(all_servers)
  else
    servers=$target
  fi

  LATEST=$(curl -s "https://api.github.com/repos/$REPO/releases/latest" | grep -oP '"tag_name": "\K[^"]+')
  echo "Latest release: $LATEST"
  echo ""

  for name in $servers; do
    echo -e "${YELLOW}[$name]${NC} Checking..."
    current=$(run_on "$name" '/usr/local/bin/conduit --version 2>/dev/null' | awk '{print $3}' || echo "none")
    if [ "$current" = "$LATEST" ]; then
      echo -e "${GREEN}[$name]${NC} Up to date ($current)"
    else
      echo -e "${YELLOW}[$name]${NC} Updating $current -> $LATEST"
      run_on "$name" "curl -sL 'https://github.com/$REPO/releases/download/$LATEST/conduit-linux-amd64' -o /usr/local/bin/conduit.new && chmod +x /usr/local/bin/conduit.new && systemctl stop conduit && mv /usr/local/bin/conduit.new /usr/local/bin/conduit && systemctl start conduit"
      echo -e "${GREEN}[$name]${NC} Updated"
    fi
  done
}

cmd_status() {
  local target=${1:-all}
  local servers

  if [ "$target" = "all" ]; then
    servers=$(all_servers)
  else
    servers=$target
  fi

  printf "%-12s  %-10s  %-8s  %-12s  %-12s\n" "NAME" "STATUS" "CLIENTS" "UPLOAD" "DOWNLOAD"
  printf "%-12s  %-10s  %-8s  %-12s  %-12s\n" "----" "------" "-------" "------" "--------"

  for name in $servers; do
    local output=$(run_on "$name" 'journalctl -u conduit -n 50 --no-pager 2>/dev/null | grep -E "STATS|Connected" | tail -5' 2>/dev/null || echo "")

    local status="offline"
    local clients="-"
    local upload="-"
    local download="-"

    if echo "$output" | grep -q "Connected to Psiphon"; then
      status="connected"
    fi

    local stats=$(echo "$output" | grep STATS | tail -1)
    if [ -n "$stats" ]; then
      clients=$(echo "$stats" | grep -oP 'Connected:\s*\K\d+' || echo "-")
      upload=$(echo "$stats" | grep -oP 'Up:\s*\K[^\|]+' | tr -d ' ' || echo "-")
      download=$(echo "$stats" | grep -oP 'Down:\s*\K[^\|]+' | tr -d ' ' || echo "-")
    fi

    local color=$RED
    [ "$status" = "connected" ] && color=$GREEN

    printf "%-12s  ${color}%-10s${NC}  %-8s  %-12s  %-12s\n" "$name" "$status" "$clients" "$upload" "$download"
  done
}

cmd_start() {
  local target=${1:-all}
  local servers
  [ "$target" = "all" ] && servers=$(all_servers) || servers=$target

  for name in $servers; do
    echo -e "${YELLOW}[$name]${NC} Starting..."
    run_on "$name" 'systemctl start conduit' && echo -e "${GREEN}[$name]${NC} Started"
  done
}

cmd_stop() {
  local target=${1:-all}
  local servers
  [ "$target" = "all" ] && servers=$(all_servers) || servers=$target

  for name in $servers; do
    echo -e "${YELLOW}[$name]${NC} Stopping..."
    run_on "$name" 'systemctl stop conduit' && echo -e "${GREEN}[$name]${NC} Stopped"
  done
}

cmd_logs() {
  local name=$1
  [ -z "$name" ] && { echo "Usage: $0 logs <name>"; exit 1; }
  run_on "$name" 'journalctl -u conduit -f'
}

cmd_dashboard() {
  local name=$1 password=$2
  [ -z "$name" ] || [ -z "$password" ] && { echo "Usage: $0 dashboard <server-name> <password>"; exit 1; }

  local server=$(get_server "$name")
  if [ -z "$server" ]; then
    echo -e "${RED}Server '$name' not found. Add it first: $0 add $name <ip>${NC}"
    exit 1
  fi

  local host=$(get_host "$server")
  local user=$(get_user "$server")

  echo -e "${YELLOW}Deploying dashboard to $name...${NC}"

  # Generate servers.json from fleet servers
  local servers_json="["
  local first=true
  while IFS=: read -r sname shost suser; do
    [ "$first" = true ] && first=false || servers_json+=","
    servers_json+="{\"name\":\"$sname\",\"host\":\"$shost\",\"user\":\"$suser\",\"bandwidthLimit\":10995116277760}"
  done < "$SERVERS_FILE"
  servers_json+="]"

  # Install on remote
  run_on "$name" "
    set -e
    apt-get update -qq && apt-get install -y -qq nodejs npm git >/dev/null 2>&1 || true

    rm -rf /opt/conduit-dashboard
    git clone -q https://github.com/paradixe/conduit-relay.git /tmp/conduit-relay
    mv /tmp/conduit-relay/dashboard /opt/conduit-dashboard
    rm -rf /tmp/conduit-relay
    cd /opt/conduit-dashboard

    echo '$servers_json' > servers.json
    echo 'PORT=3000' > .env
    echo 'DASHBOARD_PASSWORD=$password' >> .env
    echo 'SESSION_SECRET=$(openssl rand -hex 32)' >> .env

    npm install --silent

    cat > /etc/systemd/system/conduit-dashboard.service << 'SVCEOF'
[Unit]
Description=Conduit Dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/conduit-dashboard
ExecStart=/usr/bin/node /opt/conduit-dashboard/server.js
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SVCEOF

    systemctl daemon-reload
    systemctl enable conduit-dashboard
    systemctl restart conduit-dashboard
  "

  echo ""
  echo -e "${GREEN}Dashboard deployed!${NC}"
  echo -e "URL: http://$host:3000"
  echo -e "Password: $password"
  echo ""
  echo -e "${YELLOW}Note:${NC} Add this server's SSH key to all relay servers:"
  local pubkey=$(run_on "$name" 'cat ~/.ssh/id_ed25519.pub 2>/dev/null || cat ~/.ssh/id_rsa.pub 2>/dev/null || (ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N "" -q && cat ~/.ssh/id_ed25519.pub)')
  echo "$pubkey"
}

# Main
[ $# -eq 0 ] && { usage; exit 1; }

case $1 in
  add)       cmd_add "$2" "$3" "$4" ;;
  remove)    cmd_remove "$2" ;;
  list)      cmd_list ;;
  install)   cmd_install "$2" ;;
  update)    cmd_update "$2" ;;
  status)    cmd_status "$2" ;;
  start)     cmd_start "$2" ;;
  stop)      cmd_stop "$2" ;;
  logs)      cmd_logs "$2" ;;
  dashboard) cmd_dashboard "$2" "$3" ;;
  *)         usage; exit 1 ;;
esac
