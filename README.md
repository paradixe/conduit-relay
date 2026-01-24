# Conduit Relay

Volunteer relay for [Psiphon](https://psiphon.ca). Routes traffic for users in censored regions via WebRTC. Your VPS becomes an exit node.

**Requirements:** Linux VPS, root access
**Bandwidth:** 50-200 GB/day depending on demand
**Default:** 200 max clients (override: `curl ... | MAX_CLIENTS=500 bash`)

**New?** Check the [step-by-step setup guide](SETUP.md) (English + فارسی)

---

## Single Server

```bash
curl -sL https://raw.githubusercontent.com/paradixe/conduit-relay/main/install.sh | sudo bash
```

```bash
systemctl status conduit      # status
journalctl -u conduit -f      # logs
sudo ./update.sh              # update
sudo ./uninstall.sh           # remove
```

---

## Multi-Server (Fleet)

Manage multiple relays from your laptop. Requires SSH key auth.

```bash
./fleet.sh add node1 1.2.3.4
./fleet.sh add node2 5.6.7.8
./fleet.sh install all
./fleet.sh status
./fleet.sh update all
./fleet.sh stop all
./fleet.sh dashboard node1 mypassword   # deploy web UI
```

Dashboard auto-generates config from your fleet and prints the SSH key to distribute.

---

## فارسی

یه VPS بگیر، این رو بزن:

```bash
curl -sL https://raw.githubusercontent.com/paradixe/conduit-relay/main/install.sh | sudo bash
```

تمام. سرورت الان داره به مردم کمک میکنه فیلترشکن داشته باشن.
