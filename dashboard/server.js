import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import initSqlJs from 'sql.js';
import { Client } from 'ssh2';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.DASHBOARD_PASSWORD || 'changeme';
const SSH_KEY_PATH = process.env.SSH_KEY_PATH || join(process.env.HOME, '.ssh/id_ed25519');
const DB_PATH = join(__dirname, 'stats.db');
const JOIN_TOKEN = process.env.JOIN_TOKEN || null;
const SERVERS_PATH = join(__dirname, 'servers.json');
const CONDUIT_MON_USER = 'conduitmon'; // SSH user for dashboard monitoring (single source of truth)

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
  // Geo stats table for country breakdown (with bandwidth tracking)
  db.run(`
    CREATE TABLE IF NOT EXISTS geo_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      server TEXT NOT NULL,
      country_code TEXT NOT NULL,
      country_name TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      bytes INTEGER DEFAULT 0
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_geo_timestamp ON geo_stats(timestamp)`);
  // Client stats table for per-IP traffic tracking
  db.run(`
    CREATE TABLE IF NOT EXISTS client_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      server TEXT NOT NULL,
      ip_address TEXT NOT NULL,
      country_code TEXT,
      country_name TEXT,
      bytes_in INTEGER DEFAULT 0,
      bytes_out INTEGER DEFAULT 0
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_client_timestamp ON client_stats(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_client_ip ON client_stats(ip_address)`);
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
      port: server.sshPort || 22,
      username: server.user,
      privateKey,
      readyTimeout: 30000, // 30 seconds for slow Tailscale connections
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
  const result = { name: serverName, status: 'offline', clients: 0, connecting: 0, upload: '0 B', download: '0 B', uptime: 'N/A', error: null, maxClients: null, bandwidth: null };
  if (!output) return result;

  if (output.includes('Active: active') || output.includes('running')) result.status = 'running';
  else if (output.includes('Active: inactive') || output.includes('dead')) result.status = 'stopped';

  const newFormat = [...output.matchAll(/\[STATS\]\s*Connecting:\s*(\d+)\s*\|\s*Connected:\s*(\d+)\s*\|\s*Up:\s*([^|]+)\|\s*Down:\s*([^|]+)\|\s*Uptime:\s*(\S+)/g)];
  const oldFormat = [...output.matchAll(/\[STATS\]\s*Clients:\s*(\d+)\s*\|\s*Up:\s*([^|]+)\|\s*Down:\s*([^|]+)\|\s*Uptime:\s*(\S+)/g)];

  if (newFormat.length > 0) {
    const m = newFormat[newFormat.length - 1];
    result.connecting = parseInt(m[1], 10);
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
// Now captures bandwidth (bytes) per country, not just connection counts
async function fetchGeoStats(server) {
  try {
    // Capture packets with sizes, aggregate bytes per IP, then geo lookup
    // tcpdump -q output includes "length X" for packet sizes
    const cmd = `sudo -n /usr/bin/timeout 30 /usr/bin/tcpdump -n -q -i any 'inbound and (tcp or udp)' -c 2000 2>/dev/null | \\
      awk '{
        for(i=1;i<=NF;i++) if($i=="IP"){src=$(i+1);gsub(/\\.[0-9]+$/,"",src);break}
        if(match($0,/length ([0-9]+)/,a))len=a[1];else len=0
        if(src~/^[0-9]+\\./ && len>0)b[src]+=len
      } END{for(ip in b)print b[ip],ip}' | sort -rn | head -200 | \\
      while read bytes ip; do
        geo=$(geoiplookup "$ip" 2>/dev/null | grep -v "not found" | head -1)
        [ -n "$geo" ] && echo "$bytes|$(echo "$geo" | awk -F": " "{print \\$2}")"
      done`;
    const output = await sshExec(server, cmd);
    const results = [];
    // Parse output: "12345|IR, Iran, Islamic Republic of"
    for (const line of output.split('\n')) {
      const match = line.trim().match(/^(\d+)\|([A-Z]{2}),\s*(.+)$/);
      if (match) {
        results.push({
          bytes: parseInt(match[1], 10),
          count: 1, // Each line is one IP
          country_code: match[2],
          country_name: normalizeCountryName(match[3].trim()),
        });
      }
    }
    // Aggregate by country (sum bytes from multiple IPs in same country)
    const aggregated = {};
    for (const r of results) {
      if (!aggregated[r.country_code]) {
        aggregated[r.country_code] = { bytes: 0, count: 0, country_name: r.country_name };
      }
      aggregated[r.country_code].bytes += r.bytes;
      aggregated[r.country_code].count += r.count;
    }
    const finalResults = Object.entries(aggregated).map(([code, data]) => ({
      country_code: code,
      country_name: data.country_name,
      count: data.count,
      bytes: data.bytes,
    }));
    return { server: server.name, results: finalResults };
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
  let totalBytes = 0;
  for (const { results } of allResults) {
    for (const { country_code, country_name, count, bytes } of results) {
      if (!countryTotals[country_code]) {
        countryTotals[country_code] = { country_name, count: 0, bytes: 0 };
      }
      countryTotals[country_code].count += count;
      countryTotals[country_code].bytes += bytes || 0;
      totalBytes += bytes || 0;
    }
  }

  // Store snapshot per server
  for (const { server, results } of allResults) {
    for (const { country_code, country_name, count, bytes } of results) {
      db.run(`INSERT INTO geo_stats (timestamp, server, country_code, country_name, count, bytes) VALUES (?, ?, ?, ?, ?, ?)`,
        [timestamp, server, country_code, country_name, count, bytes || 0]);
    }
  }
  saveDb();
  console.log(`[GEO] Captured ${Object.keys(countryTotals).length} countries, ${formatBytes(totalBytes)} from ${allResults.filter(r => r.results.length > 0).length}/${SERVERS.length} servers`);
}

// ═══════════════════════════════════════════════════════════════════
// CLIENT (PER-IP) TRAFFIC TRACKING
// ═══════════════════════════════════════════════════════════════════

// Fetch per-IP traffic stats from a single server
async function fetchClientStats(server) {
  try {
    // Capture inbound and outbound traffic per IP
    // Inbound = bytes coming TO the server (client upload)
    // Outbound = bytes going FROM the server (client download)
    const cmd = `sudo -n /usr/bin/timeout 20 /usr/bin/tcpdump -n -q -i any '(tcp or udp)' -c 3000 2>/dev/null | \\
      awk '{
        dir=""; src=""; dst=""; len=0
        for(i=1;i<=NF;i++) {
          if($i=="In") dir="in"
          if($i=="Out") dir="out"
          if($i=="IP" || $i=="IP6") { src=$(i+1); dst=$(i+3) }
        }
        gsub(/\\.[0-9]+:$/,"",src); gsub(/\\.[0-9]+:$/,"",dst)
        gsub(/:$/,"",src); gsub(/:$/,"",dst)
        if(match($0,/length ([0-9]+)/,a)) len=a[1]
        if(dir=="in" && src~/^[0-9]+\\./ && len>0) { in_bytes[src]+=len; seen[src]=1 }
        if(dir=="out" && dst~/^[0-9]+\\./ && len>0) { out_bytes[dst]+=len; seen[dst]=1 }
      } END {
        for(ip in seen) print in_bytes[ip]+0, out_bytes[ip]+0, ip
      }' | sort -t' ' -k1,1rn -k2,2rn | head -50 | \\
      while read bytes_in bytes_out ip; do
        geo=$(geoiplookup "$ip" 2>/dev/null | grep -v "not found" | head -1)
        if [ -n "$geo" ]; then
          cc=$(echo "$geo" | awk -F": " "{print \\$2}" | cut -d',' -f1)
          cn=$(echo "$geo" | awk -F": " "{print \\$2}" | cut -d',' -f2-)
          echo "$bytes_in|$bytes_out|$ip|$cc|$cn"
        else
          echo "$bytes_in|$bytes_out|$ip||Unknown"
        fi
      done`;
    const output = await sshExec(server, cmd);
    const results = [];
    // Parse output: "12345|67890|1.2.3.4|IR|Iran, Islamic Republic of"
    for (const line of output.split('\n')) {
      const parts = line.trim().split('|');
      if (parts.length >= 5) {
        const bytes_in = parseInt(parts[0], 10) || 0;
        const bytes_out = parseInt(parts[1], 10) || 0;
        if (bytes_in > 0 || bytes_out > 0) {
          results.push({
            ip_address: parts[2],
            country_code: parts[3] || '',
            country_name: normalizeCountryName(parts[4]?.trim() || 'Unknown'),
            bytes_in,
            bytes_out,
          });
        }
      }
    }
    return { server: server.name, results };
  } catch (err) {
    console.error(`[CLIENTS] Failed to fetch from ${server.name}:`, err.message);
    return { server: server.name, results: [], error: err.message };
  }
}

// Fetch client stats from all servers and store
async function fetchAllClientStats() {
  const timestamp = Date.now();
  const allResults = await Promise.all(SERVERS.map(fetchClientStats));

  let totalClients = 0;
  let totalIn = 0;
  let totalOut = 0;

  // Store per-IP data
  for (const { server, results } of allResults) {
    for (const { ip_address, country_code, country_name, bytes_in, bytes_out } of results) {
      db.run(`INSERT INTO client_stats (timestamp, server, ip_address, country_code, country_name, bytes_in, bytes_out) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [timestamp, server, ip_address, country_code, country_name, bytes_in, bytes_out]);
      totalClients++;
      totalIn += bytes_in;
      totalOut += bytes_out;
    }
  }

  // Clean up old data (keep last 2 hours for per-IP tracking)
  const cutoff = timestamp - (2 * 3600000);
  db.run(`DELETE FROM client_stats WHERE timestamp < ?`, [cutoff]);
  
  saveDb();
  if (totalClients > 0) {
    console.log(`[CLIENTS] Tracked ${totalClients} IPs, IN: ${formatBytes(totalIn)}, OUT: ${formatBytes(totalOut)} from ${allResults.filter(r => r.results.length > 0).length}/${SERVERS.length} servers`);
  }
}

// Batched fetching
const BATCH_SIZE = 3;
const BATCH_DELAY = 500;

// Cache for server deployment mode (docker vs native)
const serverModeCache = new Map();

// Detect if conduit runs in Docker or native on a server
async function detectConduitMode(server) {
  // Check cache first (valid for 5 minutes)
  const cached = serverModeCache.get(server.name);
  if (cached && Date.now() - cached.timestamp < 300000) {
    return cached.mode;
  }

  try {
    // Single command to detect mode: check Docker first (both container names), then systemd
    const output = await sshExec(server,
      'docker ps --format "{{.Names}}" 2>/dev/null | grep -E "^conduit(-relay)?$" | head -1 || echo ""; ' +
      'systemctl is-active conduit 2>/dev/null || echo ""'
    );

    let mode = 'unknown';
    let containerName = null;
    // Match both 'conduit' (ssmirr) and 'conduit-relay' (our) container names
    const containerMatch = output.match(/^(conduit(-relay)?)$/m);
    if (containerMatch) {
      mode = 'docker';
      containerName = containerMatch[1];
      // Store container name for later use
      serverModeCache.set(server.name, { mode, containerName, timestamp: Date.now() });
      return mode;
    } else if (output.includes('active')) {
      mode = 'native';
    }

    serverModeCache.set(server.name, { mode, containerName: null, timestamp: Date.now() });
    return mode;
  } catch {
    return 'unknown';
  }
}

// Get container name for a server (from cache)
function getContainerName(serverName) {
  const cached = serverModeCache.get(serverName);
  return cached?.containerName || 'conduit-relay';
}

// Get stats command based on deployment mode
function getStatsCommand(mode, serverName) {
  if (mode === 'docker') {
    const container = getContainerName(serverName);
    return `docker logs ${container} --tail 50 2>&1 | grep -E "STATS|Connected|started" | tail -20; ` +
           `docker inspect ${container} --format "{{.State.Status}}" 2>/dev/null || echo "stopped"`;
  }
  // Native (systemd) - use 50 lines for better stats capture
  return 'sudo -n systemctl status conduit 2>/dev/null; ' +
         'sudo -n journalctl -u conduit -n 50 --no-pager 2>/dev/null; ' +
         'sudo -n grep ExecStart /etc/systemd/system/conduit.service 2>/dev/null';
}

// Get service control command based on mode
function getControlCommand(action, mode, serverName) {
  if (mode === 'docker') {
    const container = getContainerName(serverName);
    return `docker ${action} ${container}`;
  }
  return `sudo -n systemctl ${action} conduit`;
}

// Cache for last known good stats per server (prevents showing 0/N/A when STATS not in log window)
const lastKnownStats = new Map();

async function fetchServerStats(server) {
  try {
    const mode = await detectConduitMode(server);
    const output = await sshExec(server, getStatsCommand(mode, server.name));
    const stats = parseConduitStatus(output, server.name);
    stats.host = server.host;
    stats.mode = mode; // Track deployment mode
    
    // Get or create cache for this server
    const cached = lastKnownStats.get(server.name) || {};
    
    // Cache each field independently - only update if we got a good value
    // For clients/connecting: cache if > 0, OR if uptime is valid (means STATS line was parsed)
    const hasValidStats = stats.uptime !== 'N/A';
    
    if (hasValidStats) {
      // STATS line was found - cache all values from it
      cached.clients = stats.clients;
      cached.connecting = stats.connecting;
      cached.uptime = stats.uptime;
      cached.upload = stats.upload;
      cached.download = stats.download;
    } else if (stats.status === 'running' || stats.status === 'connected') {
      // Service running but STATS line not found - use cached values
      if (cached.clients !== undefined) stats.clients = cached.clients;
      if (cached.connecting !== undefined) stats.connecting = cached.connecting;
      if (cached.uptime !== undefined) stats.uptime = cached.uptime;
      if (cached.upload !== undefined) stats.upload = cached.upload;
      if (cached.download !== undefined) stats.download = cached.download;
    }
    
    lastKnownStats.set(server.name, cached);
    return stats;
  } catch (err) {
    // On error, try to return cached data with error status
    const cached = lastKnownStats.get(server.name) || {};
    return { 
      name: server.name, 
      host: server.host, 
      status: 'error', 
      clients: cached.clients || 0, 
      connecting: cached.connecting || 0, 
      upload: cached.upload || '0 B', 
      download: cached.download || '0 B', 
      uptime: cached.uptime || 'N/A', 
      maxClients: null, 
      bandwidth: null,
      mode: 'unknown',
      error: err.message 
    };
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
    // Aggregate counts and bytes by country across time range
    const stmt = db.prepare(`SELECT country_code, country_name, SUM(count) as total_count, SUM(bytes) as total_bytes FROM geo_stats WHERE timestamp > ? GROUP BY country_code ORDER BY total_bytes DESC`);
    stmt.bind([since]);
    const rows = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push({ 
        country_code: row.country_code, 
        country_name: row.country_name, 
        count: row.total_count,
        bytes: row.total_bytes || 0
      });
    }
    stmt.free();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get active clients (per-IP traffic) with speed calculation
app.get('/api/clients', requireAuth, (req, res) => {
  try {
    const minutes = parseInt(req.query.minutes) || 30;
    const since = Date.now() - (minutes * 60000);
    
    // Get recent client data with aggregation and speed calculation
    // Group by IP, sum bytes, calculate speed based on time span
    const stmt = db.prepare(`
      SELECT 
        ip_address,
        country_code,
        country_name,
        server,
        SUM(bytes_in) as total_in,
        SUM(bytes_out) as total_out,
        COUNT(*) as samples,
        MIN(timestamp) as first_seen,
        MAX(timestamp) as last_seen
      FROM client_stats 
      WHERE timestamp > ? 
      GROUP BY ip_address, server
      ORDER BY (total_in + total_out) DESC
      LIMIT 100
    `);
    stmt.bind([since]);
    const rows = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      const duration = Math.max(1, (row.last_seen - row.first_seen) / 1000); // seconds
      const totalBytes = row.total_in + row.total_out;
      // Speed in bytes/sec (only if we have multiple samples over time)
      const speed = row.samples > 1 ? Math.round(totalBytes / duration) : 0;
      rows.push({
        ip: maskIP(row.ip_address),
        ip_full: row.ip_address, // For debugging, can be removed in production
        country_code: row.country_code || '',
        country_name: row.country_name || 'Unknown',
        server: row.server,
        bytes_in: row.total_in,
        bytes_out: row.total_out,
        total: totalBytes,
        speed: speed, // bytes per second
        samples: row.samples,
        last_seen: row.last_seen,
      });
    }
    stmt.free();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mask IP for privacy (show first 2 octets only)
function maskIP(ip) {
  if (!ip) return 'Unknown';
  const parts = ip.split('.');
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.*.*`;
  }
  // IPv6 - show first segment
  if (ip.includes(':')) {
    return ip.split(':').slice(0, 2).join(':') + ':*';
  }
  return ip;
}

// ═══════════════════════════════════════════════════════════════════
// JOIN FLOW - Zero-friction server registration
// ═══════════════════════════════════════════════════════════════════

// GET /join/:token - Returns bash script for auto-registration
// Supports ?port=2222 to specify custom SSH port
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
  const customSshPort = req.query.port ? parseInt(req.query.port, 10) : null;

  const script = `#!/bin/bash
set -e

MON_USER="${CONDUIT_MON_USER}"
DEPLOY_MODE=""
SSH_PORT="${customSshPort || ''}"

echo ""
echo "╔═══════════════════════════════════════════════╗"
echo "║     Connecting to Conduit Dashboard           ║"
echo "╚═══════════════════════════════════════════════╝"
echo ""

# Detect SSH port (from query param, sshd_config, or default to 22)
if [ -z "\$SSH_PORT" ]; then
  SSH_PORT=\$(grep -E "^Port " /etc/ssh/sshd_config 2>/dev/null | awk '{print \$2}' | head -1)
  [ -z "\$SSH_PORT" ] && SSH_PORT=22
fi
echo "SSH port: \$SSH_PORT"

# Detect deployment mode
if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
  if docker compose version &>/dev/null 2>&1; then
    DEPLOY_MODE="docker"
    echo "Docker detected - using containerized deployment"
  else
    echo "Docker found but compose plugin missing - using native deployment"
    DEPLOY_MODE="native"
  fi
else
  DEPLOY_MODE="native"
  echo "Using native deployment"
fi
echo ""

# [1/5] Install sudo and create monitoring user + SSH key
echo "[1/5] Installing sudo and creating monitoring user..."
apt-get update -qq && apt-get install -y -qq sudo >/dev/null 2>&1 || true
if ! id "$MON_USER" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$MON_USER"
fi

install -d -m 700 -o "$MON_USER" -g "$MON_USER" "/home/$MON_USER/.ssh"
touch "/home/$MON_USER/.ssh/authorized_keys"
chown "$MON_USER:$MON_USER" "/home/$MON_USER/.ssh/authorized_keys"
chmod 600 "/home/$MON_USER/.ssh/authorized_keys"

if grep -qF "${sshPubKey}" "/home/$MON_USER/.ssh/authorized_keys" 2>/dev/null; then
  echo "  SSH key already present for $MON_USER"
else
  echo "${sshPubKey}" >> "/home/$MON_USER/.ssh/authorized_keys"
  sort -u "/home/$MON_USER/.ssh/authorized_keys" -o "/home/$MON_USER/.ssh/authorized_keys"
  chown "$MON_USER:$MON_USER" "/home/$MON_USER/.ssh/authorized_keys"
  chmod 600 "/home/$MON_USER/.ssh/authorized_keys"
  echo "  SSH key added for $MON_USER"
fi

# [2/5] Configure limited sudo for monitoring commands
echo "[2/5] Configuring sudoers for $MON_USER..."
mkdir -p /etc/sudoers.d
cat > "/etc/sudoers.d/conduit-dashboard" <<SUDOEOF
Defaults:\${MON_USER} !requiretty
\${MON_USER} ALL=(root) NOPASSWD: \\
  /usr/bin/systemctl * conduit, /bin/systemctl * conduit, \\
  /usr/bin/journalctl -u conduit *, /bin/journalctl -u conduit *, \\
  /usr/bin/grep ExecStart /etc/systemd/system/conduit.service, /bin/grep ExecStart /etc/systemd/system/conduit.service, \\
  /usr/bin/timeout * /usr/bin/tcpdump *, /usr/bin/tcpdump *, /usr/sbin/tcpdump *
SUDOEOF
chmod 440 /etc/sudoers.d/conduit-dashboard

# [3/5] Add monitoring user to docker group (if Docker mode)
if [ "$DEPLOY_MODE" = "docker" ]; then
  echo "[3/5] Adding $MON_USER to docker group..."
  usermod -aG docker "$MON_USER" 2>/dev/null || true
else
  echo "[3/5] Skipping docker group (native mode)"
fi

# [4/5] Install/Start conduit relay
echo "[4/5] Setting up Conduit Relay ($DEPLOY_MODE mode)..."

if [ "$DEPLOY_MODE" = "docker" ]; then
  # Docker deployment
  CONDUIT_DIR="/opt/conduit"
  mkdir -p "$CONDUIT_DIR"
  cd "$CONDUIT_DIR"

  # Check if already running (our conduit-relay OR conduit-manager's conduit)
  EXISTING_CONTAINER=\$(docker ps --format "{{.Names}}" 2>/dev/null | grep -E "^conduit(-relay)?\$" | head -1)
  if [ -n "\$EXISTING_CONTAINER" ]; then
    echo "  Conduit container already running: \$EXISTING_CONTAINER"
  else
    # Download relay-only compose file
    curl -sLo docker-compose.yml "https://raw.githubusercontent.com/paradixe/conduit-relay/main/docker-compose.relay-only.yml"

    # Create .env with defaults
    cat > .env <<ENVEOF
MAX_CLIENTS=200
BANDWIDTH=-1
ENVEOF

    # Pull and start
    docker compose pull
    docker compose up -d
    echo "  Conduit relay container started"
  fi
else
  # Native deployment
  if command -v conduit &>/dev/null || [ -f /usr/local/bin/conduit ]; then
    echo "  Conduit already installed: \$(/usr/local/bin/conduit --version 2>/dev/null || echo 'unknown')"
  else
    echo "  Installing Conduit Relay..."
    curl -sL "https://raw.githubusercontent.com/paradixe/conduit-relay/main/install.sh" | bash
  fi
fi

# [5/5] Register with dashboard (use MON_USER)
echo "[5/5] Registering with dashboard..."
HOSTNAME=\$(hostname | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g' | cut -c1-20)
[ -z "\$HOSTNAME" ] && HOSTNAME="server"
IP=\$(curl -4 -s --connect-timeout 5 ifconfig.me 2>/dev/null || curl -4 -s --connect-timeout 5 icanhazip.com 2>/dev/null || hostname -I | awk '{print \$1}')

RESULT=\$(curl -sX POST "http://${dashboardHost}:${dashboardPort}/api/register" \\
  -H "Content-Type: application/json" \\
  -H "X-Join-Token: ${JOIN_TOKEN}" \\
  -d "{\\"name\\":\\"\$HOSTNAME\\",\\"host\\":\\"\$IP\\",\\"user\\":\\"$MON_USER\\",\\"sshPort\\":\$SSH_PORT}" 2>/dev/null)

if echo "\$RESULT" | grep -q '"success":true'; then
  echo ""
  echo "════════════════════════════════════════════════"
  echo "  Connected to dashboard!"
  echo "  Name: \$HOSTNAME"
  echo "  IP:   \$IP"
  echo "  SSH:  \$SSH_PORT"
  echo "  User: $MON_USER"
  echo "  Mode: \$DEPLOY_MODE"
  echo "  View: http://${dashboardHost}:${dashboardPort}"
  echo "════════════════════════════════════════════════"
  echo ""
else
  echo "  Warning: Registration may have failed"
  echo "  Response: \$RESULT"
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

  const { name, host, user, sshPort } = req.body;
  if (!name || !host) {
    return res.status(400).json({ error: 'Name and host required' });
  }

  const parsedPort = sshPort ? parseInt(sshPort, 10) : null;

  // Check for duplicates by host
  const existingIdx = SERVERS.findIndex(s => s.host === host);
  if (existingIdx >= 0) {
    // Update existing server
    SERVERS[existingIdx] = {
      ...SERVERS[existingIdx],
      name,
      user: user || CONDUIT_MON_USER,
      sshPort: parsedPort || SERVERS[existingIdx].sshPort || null
    };
    console.log(`[JOIN] Server updated: ${name} (${host}:${parsedPort || 22})`);
  } else {
    // Add new server
    SERVERS.push({ name, host, user: user || CONDUIT_MON_USER, sshPort: parsedPort, bandwidthLimit: null });
    console.log(`[JOIN] Server registered: ${name} (${host}:${parsedPort || 22})`);
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

  const { name, bandwidthLimit, sshPort } = req.body;
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
  if (sshPort !== undefined) {
    // Close existing connection if port changed
    const oldPort = SERVERS[idx].sshPort || 22;
    const newPort = sshPort ? parseInt(sshPort, 10) : null;
    if (oldPort !== (newPort || 22)) {
      const poolEntry = sshPool.get(SERVERS[idx].name);
      if (poolEntry) {
        poolEntry.conn?.end();
        sshPool.delete(SERVERS[idx].name);
      }
    }
    SERVERS[idx].sshPort = newPort;
  }

  saveServers();
  res.json({ success: true, server: SERVERS[idx] });
});

// PUT /api/servers/:name/config - Update conduit service config (-m, -b flags)
app.put('/api/servers/:name/config', requireAuth, async (req, res) => {
  const server = SERVERS.find(s => s.name === req.params.name);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const { maxClients, bandwidth } = req.body;
  
  // Validate inputs
  if (maxClients !== undefined && maxClients !== null && maxClients !== '') {
    const m = parseInt(maxClients, 10);
    if (isNaN(m) || m < 1 || m > 10000) {
      return res.status(400).json({ error: 'Max clients must be between 1 and 10000' });
    }
  }
  if (bandwidth !== undefined && bandwidth !== null && bandwidth !== '') {
    const b = parseInt(bandwidth, 10);
    if (isNaN(b) || (b < -1) || (b > 1000000)) {
      return res.status(400).json({ error: 'Bandwidth must be -1 (unlimited) or 0-1000000 Mbps' });
    }
  }

  try {
    // Read current service file
    const readCmd = 'cat /etc/systemd/system/conduit.service 2>/dev/null';
    const serviceFile = await sshExec(server, readCmd);
    
    if (!serviceFile || !serviceFile.includes('ExecStart')) {
      return res.status(500).json({ error: 'Could not read service file' });
    }

    // Parse and update ExecStart line
    let newServiceFile = serviceFile;
    const execMatch = serviceFile.match(/^(ExecStart=.*)$/m);
    if (!execMatch) {
      return res.status(500).json({ error: 'Could not find ExecStart in service file' });
    }

    let execLine = execMatch[1];
    
    // Update -m flag
    if (maxClients !== undefined && maxClients !== null && maxClients !== '') {
      if (execLine.match(/-m\s+\d+/)) {
        execLine = execLine.replace(/-m\s+\d+/, `-m ${maxClients}`);
      } else {
        // Add -m flag after 'conduit start'
        execLine = execLine.replace(/conduit start/, `conduit start -m ${maxClients}`);
      }
    }

    // Update -b flag
    if (bandwidth !== undefined && bandwidth !== null && bandwidth !== '') {
      if (execLine.match(/-b\s+-?\d+/)) {
        execLine = execLine.replace(/-b\s+-?\d+/, `-b ${bandwidth}`);
      } else {
        // Add -b flag after -m or after 'conduit start'
        if (execLine.includes('-m')) {
          execLine = execLine.replace(/-m\s+\d+/, (match) => `${match} -b ${bandwidth}`);
        } else {
          execLine = execLine.replace(/conduit start/, `conduit start -b ${bandwidth}`);
        }
      }
    }

    newServiceFile = serviceFile.replace(execMatch[1], execLine);

    // Write updated service file and restart
    const updateCmd = `
      echo '${newServiceFile.replace(/'/g, "'\\''")}' | sudo tee /etc/systemd/system/conduit.service > /dev/null && \
      sudo systemctl daemon-reload && \
      sudo systemctl restart conduit
    `;
    
    await sshExec(server, updateCmd);
    
    // Clear cache to refresh stats
    statsCache = { data: null, timestamp: 0 };
    
    console.log(`[CONFIG] Updated ${server.name}: maxClients=${maxClients}, bandwidth=${bandwidth}`);
    res.json({ success: true, message: 'Configuration updated and service restarted' });
  } catch (err) {
    console.error(`[CONFIG] Failed to update ${server.name}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// UPDATE SYSTEM - Check for updates and update all servers
// ═══════════════════════════════════════════════════════════════════

// Binary source (ssmirr builds)
const BINARY_BASE_URL = 'https://github.com/ssmirr/conduit/releases/latest/download';

let cachedLatestVersion = null;
let versionCacheTime = 0;
let cachedDashboardVersion = null;
let dashboardVersionCacheTime = 0;

// Extract version number from tag (e.g., "release-cli-1.0.0" -> "1.0.0")
function extractVersion(tag) {
  if (!tag) return null;
  const match = tag.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : tag;
}

// Get local dashboard version (git commit hash)
function getLocalDashboardVersion() {
  try {
    const { execSync } = require('child_process');
    return execSync('git rev-parse --short HEAD', { cwd: __dirname, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

// GET /api/version - Check current vs latest version
app.get('/api/version', requireAuth, async (req, res) => {
  try {
    // Get latest version from Psiphon releases (cache for 5 minutes)
    if (!cachedLatestVersion || Date.now() - versionCacheTime > 300000) {
      try {
        const ghRes = await fetch('https://api.github.com/repos/ssmirr/conduit/releases/latest');
        if (ghRes.ok) {
          const data = await ghRes.json();
          cachedLatestVersion = extractVersion(data.tag_name);
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

    // Check dashboard version (cache for 5 minutes)
    let dashboardLatest = cachedDashboardVersion;
    if (!dashboardLatest || Date.now() - dashboardVersionCacheTime > 300000) {
      try {
        const ghRes = await fetch('https://api.github.com/repos/paradixe/conduit-relay/commits/main');
        if (ghRes.ok) {
          const data = await ghRes.json();
          dashboardLatest = data.sha?.substring(0, 7) || null;
          cachedDashboardVersion = dashboardLatest;
          dashboardVersionCacheTime = Date.now();
        }
      } catch {}
    }
    const dashboardLocal = getLocalDashboardVersion();
    const dashboardNeedsUpdate = dashboardLatest && dashboardLocal !== 'unknown' && dashboardLocal !== dashboardLatest;

    res.json({
      latest: cachedLatestVersion,
      servers: versions,
      updateAvailable: needsUpdate.length > 0,
      serversNeedingUpdate: needsUpdate.map(v => v.server),
      dashboard: {
        local: dashboardLocal,
        latest: dashboardLatest,
        updateAvailable: dashboardNeedsUpdate
      }
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
        const mode = await detectConduitMode(server);

        let output;
        if (mode === 'docker') {
          // Docker update: pull new image and recreate container
          const container = getContainerName(server.name);
          output = await sshExec(server, `
            set -e
            cd ~/conduit 2>/dev/null || cd /opt/conduit 2>/dev/null || true
            docker compose pull 2>/dev/null || docker pull ghcr.io/ssmirr/conduit/conduit:latest
            docker compose up -d 2>/dev/null || docker restart ${container}
            docker logs ${container} --tail 5 2>&1 | grep -i version || echo "updated"
          `);
        } else {
          // Native update: download binary and restart service
          output = await sshExec(server, `
            set -e
            ARCH=$(uname -m)
            case "$ARCH" in
              x86_64)  BINARY="conduit-linux-amd64" ;;
              aarch64) BINARY="conduit-linux-arm64" ;;
              armv7l)  BINARY="conduit-linux-arm64" ;;
              *)       echo "Unsupported arch: $ARCH" && exit 1 ;;
            esac
            URL="${BINARY_BASE_URL}/$BINARY"
            if ! curl -fsSL "$URL" -o /usr/local/bin/conduit.new || [ ! -s /usr/local/bin/conduit.new ]; then
              echo "Download failed from $URL" && exit 1
            fi
            chmod +x /usr/local/bin/conduit.new
            sudo -n systemctl stop conduit
            sudo -n mv /usr/local/bin/conduit.new /usr/local/bin/conduit
            sudo -n systemctl start conduit
            /usr/local/bin/conduit --version
          `);
        }
        const match = output.match(/version\s+(\S+)/i);
        results.push({ server: server.name, success: true, version: match ? match[1] : 'updated', mode });
        console.log(`[UPDATE] ${server.name} updated successfully (${mode})`);
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
      try {
        const mode = await detectConduitMode(s);
        await sshExec(s, getControlCommand(action, mode, s.name));
        return { server: s.name, success: true, mode };
      } catch (e) { return { server: s.name, success: false, error: e.message }; }
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
    const mode = await detectConduitMode(server);
    await sshExec(server, getControlCommand(action, mode, server.name));
    statsCache = { data: null, timestamp: 0 };
    res.json({ server: serverName, action, success: true, mode });
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
          try {
            const mode = await detectConduitMode(server);
            await sshExec(server, getControlCommand('stop', mode, server.name));
            console.log(`[AUTO-STOP] ${server.name} stopped (${mode})`);
          } catch (e) { console.error(`[AUTO-STOP] Failed to stop ${server.name}:`, e.message); }
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

// Background polling for client stats (every 2 minutes)
setInterval(async () => {
  try { await fetchAllClientStats(); } catch (e) { console.error('Client poll failed:', e); }
}, 120000);

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
    setTimeout(() => fetchAllClientStats().catch(e => console.error('Initial client fetch failed:', e)), 8000);
  }
}).catch(e => { console.error(e); process.exit(1); });
