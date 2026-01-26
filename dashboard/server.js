import express from 'express';
import session from 'express-session';
import { Client } from 'ssh2';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import initSqlJs from 'sql.js';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.DASHBOARD_PASSWORD || 'changeme';
const SSH_KEY_PATH = process.env.SSH_KEY_PATH || join(process.env.HOME, '.ssh/id_ed25519');
const DB_PATH = join(__dirname, 'stats.db');
const JOIN_TOKEN = process.env.JOIN_TOKEN || null;
const SERVERS_PATH = join(__dirname, 'servers.json');

// Load servers from config file or environment
function loadServers() {
  if (existsSync(SERVERS_PATH)) {
    try {
      const servers = JSON.parse(readFileSync(SERVERS_PATH, 'utf8'));
      if (Array.isArray(servers)) return servers;
    } catch (e) {
      console.error('Failed to parse servers.json:', e.message);
    }
  }
  if (process.env.SERVERS) {
    return process.env.SERVERS.split(',').map(s => {
      const [name, host, user, limitTB] = s.split(':');
      return { name, host, user, bandwidthLimit: parseFloat(limitTB || 10) * 1024 ** 4 };
    });
  }
  // Return empty array - wizard will handle setup
  console.log('No servers configured. Setup wizard will guide you.');
  return [];
}

// Save servers to config file
function saveServers() {
  writeFileSync(SERVERS_PATH, JSON.stringify(SERVERS, null, 2));
  console.log(`[CONFIG] Saved ${SERVERS.length} servers`);
}

let SERVERS = loadServers();

// Initialize SQLite database
let db;
async function initDb() {
  const SQL = await initSqlJs();
  if (existsSync(DB_PATH)) {
    db = new SQL.Database(readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }
  // Stats table stores cumulative values (offset + session)
  db.run(`
    CREATE TABLE IF NOT EXISTS stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      server TEXT NOT NULL,
      status TEXT,
      clients INTEGER DEFAULT 0,
      upload_bytes INTEGER DEFAULT 0,
      download_bytes INTEGER DEFAULT 0,
      uptime TEXT
    )
  `);
  // Offsets track cumulative totals across service restarts
  db.run(`
    CREATE TABLE IF NOT EXISTS offsets (
      server TEXT PRIMARY KEY,
      upload_offset INTEGER DEFAULT 0,
      download_offset INTEGER DEFAULT 0,
      last_upload INTEGER DEFAULT 0,
      last_download INTEGER DEFAULT 0
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_stats_timestamp ON stats(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_stats_server ON stats(server)`);
  // Geo stats table for country breakdown
  db.run(`
    CREATE TABLE IF NOT EXISTS geo_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      server TEXT NOT NULL,
      country_code TEXT NOT NULL,
      country_name TEXT NOT NULL,
      count INTEGER DEFAULT 0
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_geo_timestamp ON geo_stats(timestamp)`);
  saveDb();
}

function saveDb() {
  if (db) writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function parseBytes(str) {
  if (!str || str === 'N/A') return 0;
  const match = str.match(/^([\d.]+)\s*([KMGTPE]?B?)$/i);
  if (!match) return 0;
  const units = { B: 1, KB: 1024, MB: 1024**2, GB: 1024**3, TB: 1024**4 };
  return Math.round(parseFloat(match[1]) * (units[(match[2] || 'B').toUpperCase()] || 1));
}

// Cache
let statsCache = { data: null, timestamp: 0 };
const CACHE_TTL = 5000;

// SSH Connection Pool
const sshPool = new Map();
const SSH_KEEPALIVE_INTERVAL = 10000;
const SSH_KEEPALIVE_COUNT_MAX = 3;

function getPooledConnection(server) {
  return new Promise((resolve, reject) => {
    const existing = sshPool.get(server.name);
    if (existing && existing.connected) return resolve(existing.conn);

    const conn = new Client();
    let privateKey;
    try {
      privateKey = readFileSync(SSH_KEY_PATH);
    } catch (err) {
      return reject(new Error(`Cannot read SSH key: ${err.message}`));
    }

    conn.on('ready', () => {
      sshPool.set(server.name, { conn, connected: true });
      resolve(conn);
    });
    conn.on('error', (err) => { sshPool.delete(server.name); reject(err); });
    conn.on('close', () => sshPool.delete(server.name));
    conn.on('end', () => sshPool.delete(server.name));

    conn.connect({
      host: server.host,
      port: 22,
      username: server.user,
      privateKey,
      readyTimeout: 15000,
      keepaliveInterval: SSH_KEEPALIVE_INTERVAL,
      keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
      // Skip host key verification for auto-registered servers
      hostVerifier: () => true,
    });
  });
}

async function sshExec(server, command) {
  let conn;
  try {
    conn = await getPooledConnection(server);
  } catch (err) {
    throw new Error(`SSH connect failed: ${err.message}`);
  }
  return new Promise((resolve, reject) => {
    let output = '';
    conn.exec(command, (err, stream) => {
      if (err) { sshPool.delete(server.name); return reject(err); }
      stream.on('data', (data) => { output += data.toString(); });
      stream.stderr.on('data', (data) => { output += data.toString(); });
      stream.on('close', () => resolve(output));
    });
  });
}

function parseConduitStatus(output, serverName) {
  const result = { name: serverName, status: 'offline', clients: 0, upload: '0 B', download: '0 B', uptime: 'N/A', error: null, maxClients: null, bandwidth: null };
  if (!output) return result;

  if (output.includes('Active: active') || output.includes('running')) result.status = 'running';
  else if (output.includes('Active: inactive') || output.includes('dead')) result.status = 'stopped';

  const newFormat = [...output.matchAll(/\[STATS\]\s*Connecting:\s*(\d+)\s*\|\s*Connected:\s*(\d+)\s*\|\s*Up:\s*([^|]+)\|\s*Down:\s*([^|]+)\|\s*Uptime:\s*(\S+)/g)];
  const oldFormat = [...output.matchAll(/\[STATS\]\s*Clients:\s*(\d+)\s*\|\s*Up:\s*([^|]+)\|\s*Down:\s*([^|]+)\|\s*Uptime:\s*(\S+)/g)];

  if (newFormat.length > 0) {
    const m = newFormat[newFormat.length - 1];
    result.clients = parseInt(m[2], 10);
    result.upload = m[3].trim();
    result.download = m[4].trim();
    result.uptime = m[5].trim();
  } else if (oldFormat.length > 0) {
    const m = oldFormat[oldFormat.length - 1];
    result.clients = parseInt(m[1], 10);
    result.upload = m[2].trim();
    result.download = m[3].trim();
    result.uptime = m[4].trim();
  }

  // Parse conduit config flags from systemd service
  const mMatch = output.match(/-m\s+(\d+)/);
  const bMatch = output.match(/-b\s+(-?\d+)/);
  if (mMatch) result.maxClients = parseInt(mMatch[1], 10);
  if (bMatch) result.bandwidth = parseInt(bMatch[1], 10);

  if (output.includes('[OK] Connected to Psiphon network')) result.status = 'connected';
  return result;
}

// Get or create offset record for a server
function getOffset(server) {
  const stmt = db.prepare(`SELECT upload_offset, download_offset, last_upload, last_download FROM offsets WHERE server = ?`);
  stmt.bind([server]);
  let offset = { upload_offset: 0, download_offset: 0, last_upload: 0, last_download: 0 };
  if (stmt.step()) offset = stmt.getAsObject();
  stmt.free();
  return offset;
}

function saveStats(stats) {
  const timestamp = Date.now();
  for (const s of stats) {
    const sessionUp = parseBytes(s.upload);
    const sessionDown = parseBytes(s.download);

    // Get current offset and last known session values
    const offset = getOffset(s.name);

    // Detect reset: current value dropped significantly (service restart)
    // Only trigger if current < 50% of last AND last was meaningful (> 1MB)
    let newUpOffset = offset.upload_offset;
    let newDownOffset = offset.download_offset;
    const MIN_FOR_RESET = 1024 * 1024; // 1MB minimum to consider reset

    if (sessionUp < offset.last_upload * 0.5 && offset.last_upload > MIN_FOR_RESET) {
      newUpOffset += offset.last_upload;
      console.log(`[RESET] ${s.name} upload reset: ${formatBytes(offset.last_upload)} -> ${formatBytes(sessionUp)}, offset now ${formatBytes(newUpOffset)}`);
    }
    if (sessionDown < offset.last_download * 0.5 && offset.last_download > MIN_FOR_RESET) {
      newDownOffset += offset.last_download;
      console.log(`[RESET] ${s.name} download reset: ${formatBytes(offset.last_download)} -> ${formatBytes(sessionDown)}, offset now ${formatBytes(newDownOffset)}`);
    }

    // Cumulative = offset + current session
    const cumulativeUp = newUpOffset + sessionUp;
    const cumulativeDown = newDownOffset + sessionDown;

    // Save cumulative stats
    db.run(`INSERT INTO stats (timestamp, server, status, clients, upload_bytes, download_bytes, uptime) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [timestamp, s.name, s.status, s.clients, cumulativeUp, cumulativeDown, s.uptime]);

    // Update offsets table
    db.run(`INSERT OR REPLACE INTO offsets (server, upload_offset, download_offset, last_upload, last_download) VALUES (?, ?, ?, ?, ?)`,
      [s.name, newUpOffset, newDownOffset, sessionUp, sessionDown]);
  }
  saveDb();
}

// Normalize country names from geoiplookup output
function normalizeCountryName(name) {
  const mapping = {
    'Iran, Islamic Republic of': 'Iran',
    'Korea, Republic of': 'South Korea',
    "Korea, Democratic People's Republic of": 'North Korea',
    'Russian Federation': 'Russia',
    'United Kingdom': 'UK',
    'United Arab Emirates': 'UAE',
    'Viet Nam': 'Vietnam',
    'Taiwan, Province of China': 'Taiwan',
    'Hong Kong': 'Hong Kong',
    'Syrian Arab Republic': 'Syria',
    'Venezuela, Bolivarian Republic of': 'Venezuela',
    'Tanzania, United Republic of': 'Tanzania',
    'Moldova, Republic of': 'Moldova',
    'Macedonia, the Former Yugoslav Republic of': 'Macedonia',
    'Lao People\'s Democratic Republic': 'Laos',
    'Libyan Arab Jamahiriya': 'Libya',
    'Palestinian Territory, Occupied': 'Palestine',
    'Congo, The Democratic Republic of the': 'DR Congo',
  };
  return mapping[name] || name;
}

// Fetch geo stats from a single server via tcpdump + geoiplookup
async function fetchGeoStats(server) {
  try {
    // Capture unique IPs, look up countries, count occurrences
    // tcpdump output: "timestamp eth0 In IP src_ip.port > dst_ip.port: ..." - IP is field 5
    const cmd = `timeout 30 tcpdump -ni any 'inbound and (tcp or udp)' -c 500 2>/dev/null | awk '{print $5}' | cut -d. -f1-4 | grep -E '^[0-9]+\\.' | sort -u | xargs -n1 geoiplookup 2>/dev/null | grep -v 'not found' | awk -F': ' '{print $2}' | sort | uniq -c | sort -rn`;
    const output = await sshExec(server, cmd);
    const results = [];
    // Parse output: "  176 IR, Iran, Islamic Republic of"
    for (const line of output.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+([A-Z]{2}),\s*(.+)$/);
      if (match) {
        results.push({
          count: parseInt(match[1], 10),
          country_code: match[2],
          country_name: normalizeCountryName(match[3].trim()),
        });
      }
    }
    return { server: server.name, results };
  } catch (err) {
    console.error(`[GEO] Failed to fetch from ${server.name}:`, err.message);
    return { server: server.name, results: [], error: err.message };
  }
}

// Fetch geo stats from all servers and store aggregated snapshot
async function fetchAllGeoStats() {
  const timestamp = Date.now();
  const allResults = await Promise.all(SERVERS.map(fetchGeoStats));

  // Aggregate by country across all servers
  const countryTotals = {};
  for (const { results } of allResults) {
    for (const { country_code, country_name, count } of results) {
      if (!countryTotals[country_code]) {
        countryTotals[country_code] = { country_name, count: 0 };
      }
      countryTotals[country_code].count += count;
    }
  }

  // Store snapshot per server
  for (const { server, results } of allResults) {
    for (const { country_code, country_name, count } of results) {
      db.run(`INSERT INTO geo_stats (timestamp, server, country_code, country_name, count) VALUES (?, ?, ?, ?, ?)`,
        [timestamp, server, country_code, country_name, count]);
    }
  }
  saveDb();
  console.log(`[GEO] Captured ${Object.keys(countryTotals).length} countries from ${allResults.filter(r => r.results.length > 0).length}/${SERVERS.length} servers`);
}

// Batched fetching
const BATCH_SIZE = 3;
const BATCH_DELAY = 500;

async function fetchServerStats(server) {
  try {
    const output = await sshExec(server, 'systemctl status conduit 2>/dev/null; journalctl -u conduit -n 20 --no-pager 2>/dev/null; grep ExecStart /etc/systemd/system/conduit.service 2>/dev/null');
    const stats = parseConduitStatus(output, server.name);
    stats.host = server.host;
    return stats;
  } catch (err) {
    return { name: server.name, host: server.host, status: 'error', clients: 0, upload: '0 B', download: '0 B', uptime: 'N/A', maxClients: null, bandwidth: null, error: err.message };
  }
}

// Format bytes for display
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][i];
}

async function fetchAllStats() {
  const now = Date.now();
  if (statsCache.data && (now - statsCache.timestamp) < CACHE_TTL) return statsCache.data;

  const results = [];
  for (let i = 0; i < SERVERS.length; i += BATCH_SIZE) {
    const batch = SERVERS.slice(i, i + BATCH_SIZE);
    results.push(...await Promise.all(batch.map(fetchServerStats)));
    if (i + BATCH_SIZE < SERVERS.length) await new Promise(r => setTimeout(r, BATCH_DELAY));
  }

  // Save stats first (this updates offsets)
  try { saveStats(results); } catch (e) { console.error('Failed to save stats:', e); }

  // Add cumulative values to results for display
  for (const s of results) {
    const sessionUp = parseBytes(s.upload);
    const sessionDown = parseBytes(s.download);
    const offset = getOffset(s.name);

    // Calculate cumulative (offset already updated in saveStats)
    s.upload = formatBytes(offset.upload_offset + sessionUp);
    s.download = formatBytes(offset.download_offset + sessionDown);
  }

  statsCache = { data: results, timestamp: now };
  return results;
}

// Express setup
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: process.env.SESSION_SECRET || 'conduit-dashboard-secret', resave: false, saveUninitialized: false, cookie: { maxAge: 86400000 } }));

const requireAuth = (req, res, next) => {
  if (req.session.authenticated) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
};

// Routes
app.get('/login', (_, res) => res.sendFile(join(__dirname, 'public/login.html')));
app.post('/login', (req, res) => {
  if (req.body.password === PASSWORD) { req.session.authenticated = true; res.redirect('/'); }
  else res.redirect('/login?error=1');
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

app.get('/api/stats', requireAuth, async (_, res) => {
  try { res.json(await fetchAllStats()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/history', requireAuth, (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const since = Date.now() - (hours * 3600000);
    const stmt = db.prepare(`SELECT timestamp, server, status, clients, upload_bytes, download_bytes, uptime FROM stats WHERE timestamp > ? ORDER BY timestamp ASC`);
    stmt.bind([since]);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/history/:server', requireAuth, (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const since = Date.now() - (hours * 3600000);
    const stmt = db.prepare(`SELECT timestamp, status, clients, upload_bytes, download_bytes, uptime FROM stats WHERE server = ? AND timestamp > ? ORDER BY timestamp ASC`);
    stmt.bind([req.params.server, since]);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Debug endpoint to view/reset offsets
app.get('/api/offsets', requireAuth, (_, res) => {
  try {
    const stmt = db.prepare(`SELECT * FROM offsets`);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/offsets/reset', requireAuth, (_, res) => {
  try {
    db.run(`DELETE FROM offsets`);
    saveDb();
    res.json({ success: true, message: 'Offsets reset' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Clear all historical stats (use after switching to cumulative tracking)
app.post('/api/stats/clear', requireAuth, (_, res) => {
  try {
    db.run(`DELETE FROM stats`);
    db.run(`DELETE FROM offsets`);
    saveDb();
    res.json({ success: true, message: 'Stats and offsets cleared' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/bandwidth', requireAuth, (_, res) => {
  try {
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
    const results = {};
    for (const server of SERVERS) {
      const limit = server.bandwidthLimit || null;
      const stmt = db.prepare(`SELECT MAX(upload_bytes) as max_up, MAX(download_bytes) as max_down FROM stats WHERE server = ? AND timestamp > ?`);
      stmt.bind([server.name, startOfMonth]);
      if (stmt.step()) {
        const row = stmt.getAsObject();
        const upload = row.max_up || 0;
        const download = row.max_down || 0;
        // Only upload counts toward metered bandwidth (download is unmetered)
        results[server.name] = { upload, download, total: upload, limit, percent: limit ? Math.round((upload / limit) * 10000) / 100 : 0 };
      }
      stmt.free();
    }
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/geo', requireAuth, (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const since = Date.now() - (hours * 3600000);
    // Aggregate counts by country across time range
    const stmt = db.prepare(`SELECT country_code, country_name, SUM(count) as total FROM geo_stats WHERE timestamp > ? GROUP BY country_code ORDER BY total DESC`);
    stmt.bind([since]);
    const rows = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push({ country_code: row.country_code, country_name: row.country_name, count: row.total });
    }
    stmt.free();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// JOIN FLOW - Zero-friction server registration
// ═══════════════════════════════════════════════════════════════════

// GET /join/:token - Returns bash script for auto-registration
app.get('/join/:token', (req, res) => {
  if (!JOIN_TOKEN || req.params.token !== JOIN_TOKEN) {
    return res.status(403).type('text/plain').send('echo "Invalid or expired join token"');
  }

  let sshPubKey = '';
  try {
    sshPubKey = readFileSync(SSH_KEY_PATH + '.pub', 'utf8').trim();
  } catch (e) {
    return res.status(500).type('text/plain').send('echo "Dashboard SSH key not found"');
  }

  const dashboardHost = req.headers.host?.split(':')[0] || req.hostname;
  const dashboardPort = PORT;

  const script = `#!/bin/bash
set -e
echo ""
echo "╔═══════════════════════════════════════════════╗"
echo "║     Connecting to Conduit Dashboard           ║"
echo "╚═══════════════════════════════════════════════╝"
echo ""

# Add dashboard SSH key
echo "[1/3] Adding SSH key..."
mkdir -p ~/.ssh && chmod 700 ~/.ssh
if grep -qF "${sshPubKey}" ~/.ssh/authorized_keys 2>/dev/null; then
  echo "  SSH key already present"
else
  echo "${sshPubKey}" >> ~/.ssh/authorized_keys
  chmod 600 ~/.ssh/authorized_keys
  echo "  SSH key added"
fi

# Install conduit relay if not present
echo "[2/3] Checking Conduit Relay..."
if command -v conduit &>/dev/null || [ -f /usr/local/bin/conduit ]; then
  echo "  Conduit already installed: $(/usr/local/bin/conduit --version 2>/dev/null || echo 'unknown')"
else
  echo "  Installing Conduit Relay..."
  curl -sL "https://raw.githubusercontent.com/paradixe/conduit-relay/main/install.sh" | bash
fi

# Register with dashboard
echo "[3/3] Registering with dashboard..."
HOSTNAME=$(hostname | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g' | cut -c1-20)
[ -z "$HOSTNAME" ] && HOSTNAME="server"
IP=$(curl -4 -s --connect-timeout 5 ifconfig.me 2>/dev/null || curl -4 -s --connect-timeout 5 icanhazip.com 2>/dev/null || hostname -I | awk '{print $1}')

RESULT=$(curl -sX POST "http://${dashboardHost}:${dashboardPort}/api/register" \\
  -H "Content-Type: application/json" \\
  -H "X-Join-Token: ${JOIN_TOKEN}" \\
  -d "{\\"name\\":\\"$HOSTNAME\\",\\"host\\":\\"$IP\\",\\"user\\":\\"root\\"}" 2>/dev/null)

if echo "$RESULT" | grep -q '"success":true'; then
  echo ""
  echo "════════════════════════════════════════════════"
  echo "  Connected to dashboard!"
  echo "  Name: $HOSTNAME"
  echo "  IP:   $IP"
  echo "  View: http://${dashboardHost}:${dashboardPort}"
  echo "════════════════════════════════════════════════"
  echo ""
else
  echo "  Warning: Registration may have failed"
  echo "  Response: $RESULT"
  echo "  Server will still be monitored if SSH key was added correctly"
fi
`;

  res.type('text/plain').send(script);
});

// POST /api/register - Called by join script to self-register
app.post('/api/register', (req, res) => {
  const token = req.headers['x-join-token'];
  if (!JOIN_TOKEN || token !== JOIN_TOKEN) {
    return res.status(403).json({ error: 'Invalid token' });
  }

  const { name, host, user } = req.body;
  if (!name || !host) {
    return res.status(400).json({ error: 'Name and host required' });
  }

  // Check for duplicates by host
  const existingIdx = SERVERS.findIndex(s => s.host === host);
  if (existingIdx >= 0) {
    // Update existing server
    SERVERS[existingIdx] = { ...SERVERS[existingIdx], name, user: user || 'root' };
    console.log(`[JOIN] Server updated: ${name} (${host})`);
  } else {
    // Add new server
    SERVERS.push({ name, host, user: user || 'root', bandwidthLimit: null });
    console.log(`[JOIN] Server registered: ${name} (${host})`);
  }

  saveServers();
  statsCache = { data: null, timestamp: 0 }; // Clear cache to fetch new server
  res.json({ success: true });
});

// GET /api/status - Dashboard status for wizard
app.get('/api/status', requireAuth, (req, res) => {
  const isFirstRun = SERVERS.length === 0;
  const dashboardHost = req.headers.host?.split(':')[0] || req.hostname;

  res.json({
    firstRun: isFirstRun,
    serverCount: SERVERS.length,
    joinCommand: JOIN_TOKEN ? `curl -sL "http://${dashboardHost}:${PORT}/join/${JOIN_TOKEN}" | bash` : null,
    hasJoinToken: !!JOIN_TOKEN
  });
});

// GET /api/ssh-key - Get public SSH key for manual setup
app.get('/api/ssh-key', requireAuth, (req, res) => {
  try {
    const publicKey = readFileSync(SSH_KEY_PATH + '.pub', 'utf8').trim();
    res.json({ publicKey });
  } catch (e) {
    res.status(404).json({ error: 'SSH key not found' });
  }
});

// GET /api/servers - List all servers
app.get('/api/servers', requireAuth, (req, res) => {
  res.json(SERVERS);
});

// DELETE /api/servers/:name - Remove a server
app.delete('/api/servers/:name', requireAuth, (req, res) => {
  const idx = SERVERS.findIndex(s => s.name === req.params.name);
  if (idx === -1) return res.status(404).json({ error: 'Server not found' });

  // Close SSH connection if exists
  const poolEntry = sshPool.get(req.params.name);
  if (poolEntry) {
    poolEntry.conn?.end();
    sshPool.delete(req.params.name);
  }

  SERVERS.splice(idx, 1);
  saveServers();
  statsCache = { data: null, timestamp: 0 };
  res.json({ success: true });
});

// PUT /api/servers/:name - Update a server
app.put('/api/servers/:name', requireAuth, (req, res) => {
  const idx = SERVERS.findIndex(s => s.name === req.params.name);
  if (idx === -1) return res.status(404).json({ error: 'Server not found' });

  const { name, bandwidthLimit } = req.body;
  if (name && name !== req.params.name) {
    // Renaming - update pool key
    const poolEntry = sshPool.get(req.params.name);
    if (poolEntry) {
      sshPool.delete(req.params.name);
      sshPool.set(name, poolEntry);
    }
    SERVERS[idx].name = name;
  }
  if (bandwidthLimit !== undefined) {
    SERVERS[idx].bandwidthLimit = bandwidthLimit ? parseFloat(bandwidthLimit) * 1024 ** 4 : null;
  }

  saveServers();
  res.json({ success: true, server: SERVERS[idx] });
});

// ═══════════════════════════════════════════════════════════════════
// UPDATE SYSTEM - Check for updates and update all servers
// ═══════════════════════════════════════════════════════════════════

// Official Psiphon releases
const PRIMARY_BINARY_URL = 'https://github.com/Psiphon-Inc/conduit/releases/latest/download/conduit-linux-amd64';
const FALLBACK_BINARY_URL = 'https://raw.githubusercontent.com/paradixe/conduit-relay/main/bin/conduit-linux-amd64';

let cachedLatestVersion = null;
let versionCacheTime = 0;

// GET /api/version - Check current vs latest version
app.get('/api/version', requireAuth, async (req, res) => {
  try {
    // Get latest version from Psiphon releases (cache for 5 minutes)
    if (!cachedLatestVersion || Date.now() - versionCacheTime > 300000) {
      try {
        const ghRes = await fetch('https://api.github.com/repos/Psiphon-Inc/conduit/releases/latest');
        if (ghRes.ok) {
          const data = await ghRes.json();
          cachedLatestVersion = data.tag_name;
          versionCacheTime = Date.now();
        }
      } catch {}
    }

    // Get version from each server
    const versions = await Promise.all(SERVERS.map(async (server) => {
      try {
        const output = await sshExec(server, '/usr/local/bin/conduit --version 2>/dev/null || echo "unknown"');
        const match = output.match(/version\s+(\S+)/i);
        return { server: server.name, version: match ? match[1] : output.trim() };
      } catch (e) {
        return { server: server.name, version: 'error', error: e.message };
      }
    }));

    const needsUpdate = versions.filter(v => v.version !== cachedLatestVersion && v.version !== 'error' && v.version !== 'unknown');

    res.json({
      latest: cachedLatestVersion,
      servers: versions,
      updateAvailable: needsUpdate.length > 0,
      serversNeedingUpdate: needsUpdate.map(v => v.server)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/update - Update conduit on all servers (or specific ones)
app.post('/api/update', requireAuth, async (req, res) => {
  const { servers: targetServers } = req.body || {};

  try {
    // Determine which servers to update
    const serversToUpdate = targetServers
      ? SERVERS.filter(s => targetServers.includes(s.name))
      : SERVERS;

    const results = [];
    for (const server of serversToUpdate) {
      try {
        console.log(`[UPDATE] Updating ${server.name}...`);
        const output = await sshExec(server, `
          set -e
          if curl -sL "${PRIMARY_BINARY_URL}" -o /usr/local/bin/conduit.new && [ -s /usr/local/bin/conduit.new ]; then
            echo "Downloaded from Psiphon"
          elif curl -sL "${FALLBACK_BINARY_URL}" -o /usr/local/bin/conduit.new && [ -s /usr/local/bin/conduit.new ]; then
            echo "Downloaded from fallback"
          else
            echo "Download failed" && exit 1
          fi
          chmod +x /usr/local/bin/conduit.new
          systemctl stop conduit
          mv /usr/local/bin/conduit.new /usr/local/bin/conduit
          systemctl start conduit
          /usr/local/bin/conduit --version
        `);
        const match = output.match(/version\s+(\S+)/i);
        results.push({ server: server.name, success: true, version: match ? match[1] : 'updated' });
        console.log(`[UPDATE] ${server.name} updated successfully`);
      } catch (e) {
        results.push({ server: server.name, success: false, error: e.message });
        console.error(`[UPDATE] ${server.name} failed:`, e.message);
      }
    }

    // Clear version cache
    cachedLatestVersion = null;
    statsCache = { data: null, timestamp: 0 };

    res.json({ success: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/update-dashboard - Self-update the dashboard from GitHub
app.post('/api/update-dashboard', requireAuth, async (req, res) => {
  try {
    console.log('[UPDATE] Updating dashboard...');
    const { execSync } = await import('child_process');
    const dashboardDir = '/opt/conduit-dashboard';

    // Clone fresh and copy dashboard files (preserves .env and servers.json)
    execSync(`rm -rf /tmp/conduit-update && git clone --depth 1 -q https://github.com/paradixe/conduit-relay.git /tmp/conduit-update`, { encoding: 'utf8' });
    execSync(`cp -r /tmp/conduit-update/dashboard/* ${dashboardDir}/`, { encoding: 'utf8' });
    execSync(`cd ${dashboardDir} && npm install --silent`, { encoding: 'utf8' });
    execSync(`rm -rf /tmp/conduit-update`, { encoding: 'utf8' });

    console.log('[UPDATE] Dashboard updated, restarting service...');
    res.json({ success: true, message: 'Dashboard updated. Restarting...' });

    // Restart after response is sent
    setTimeout(() => {
      execSync('systemctl restart conduit-dashboard');
    }, 1000);
  } catch (e) {
    console.error('[UPDATE] Dashboard update failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/control/:action', requireAuth, async (req, res) => {
  const { action } = req.params;
  if (!['stop', 'start', 'restart'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  try {
    const results = await Promise.all(SERVERS.map(async s => {
      try { await sshExec(s, `systemctl ${action} conduit`); return { server: s.name, success: true }; }
      catch (e) { return { server: s.name, success: false, error: e.message }; }
    }));
    statsCache = { data: null, timestamp: 0 };
    res.json({ action, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/control/:server/:action', requireAuth, async (req, res) => {
  const { server: serverName, action } = req.params;
  if (!['stop', 'start', 'restart'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  const server = SERVERS.find(s => s.name === serverName);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  try {
    await sshExec(server, `systemctl ${action} conduit`);
    statsCache = { data: null, timestamp: 0 };
    res.json({ server: serverName, action, success: true });
  } catch (e) { res.status(500).json({ server: serverName, action, success: false, error: e.message }); }
});

app.use(requireAuth, express.static(join(__dirname, 'public')));
app.get('/', requireAuth, (_, res) => res.sendFile(join(__dirname, 'public/index.html')));

// Auto-stop servers exceeding bandwidth
async function checkBandwidthLimits() {
  const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  for (const server of SERVERS) {
    if (!server.bandwidthLimit) continue;
    try {
      const stmt = db.prepare(`SELECT MAX(upload_bytes) as max_up, MAX(download_bytes) as max_down FROM stats WHERE server = ? AND timestamp > ?`);
      stmt.bind([server.name, startOfMonth]);
      if (stmt.step()) {
        const row = stmt.getAsObject();
        // Only upload counts toward metered bandwidth (download is unmetered)
        const upload = row.max_up || 0;
        if (upload >= server.bandwidthLimit) {
          console.log(`[AUTO-STOP] ${server.name} exceeded limit (${(upload / 1024**4).toFixed(2)} TB / ${(server.bandwidthLimit / 1024**4).toFixed(2)} TB)`);
          try { await sshExec(server, 'systemctl stop conduit'); console.log(`[AUTO-STOP] ${server.name} stopped`); }
          catch (e) { console.error(`[AUTO-STOP] Failed to stop ${server.name}:`, e.message); }
        }
      }
      stmt.free();
    } catch (e) { console.error(`[AUTO-STOP] Error checking ${server.name}:`, e.message); }
  }
}

// Background polling for stats (every 30s)
setInterval(async () => {
  try { await fetchAllStats(); await checkBandwidthLimits(); } catch (e) { console.error('Background poll failed:', e); }
}, 30000);

// Background polling for geo stats (every 5 minutes)
setInterval(async () => {
  try { await fetchAllGeoStats(); } catch (e) { console.error('Geo poll failed:', e); }
}, 300000);

// Start
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Dashboard running on http://localhost:${PORT}`);
    if (SERVERS.length === 0) {
      console.log('No servers configured - setup wizard will guide you');
    } else {
      console.log(`Monitoring ${SERVERS.length} server(s)`);
    }
  });
  // Initial geo fetch after startup (only if servers configured)
  if (SERVERS.length > 0) {
    setTimeout(() => fetchAllGeoStats().catch(e => console.error('Initial geo fetch failed:', e)), 5000);
  }
}).catch(e => { console.error(e); process.exit(1); });
