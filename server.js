// HACA Office Explorer server: serves the game files and relays player state + voice signalling.
//   npm install
//   node server.js     (PORT / HTTPS_PORT env vars change the ports, default 8080 / 8443)
//
// Browsers only allow the microphone on https:// (or localhost), so the server also listens on
// HTTPS with a self-signed certificate made for this PC's network addresses. Both ports share
// one game world.
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);
const ROOT = __dirname;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.json': 'application/json',
};
const PUBLIC = new Set(['/index.html', '/game.js', '/paint-hide-seek-office.glb']);

function serveFile(req, res) {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  if (url === '/config.json') { // tells the page where the secure (voice-enabled) address is
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ httpsPort: httpsServer ? HTTPS_PORT : null }));
    return;
  }
  if (!PUBLIC.has(url)) { res.writeHead(404); res.end('Not found'); return; }
  const file = path.join(ROOT, url);
  fs.stat(file, (err, st) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

const lanAddresses = () => {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const n of list || []) if (n.family === 'IPv4' && !n.internal) out.push(n.address);
  return out;
};

// ---------------------------------------------------------------- game relay
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const players = new Map(); // id -> { ws, name, outfit, state }
let nextId = 1;

const send = (ws, msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
const broadcast = (msg, exceptId) => { for (const [id, p] of players) if (id !== exceptId) send(p.ws, msg); };
const clean = (s, n) => String(s || '').replace(/[<>]/g, '').slice(0, n);

wss.on('connection', (ws) => {
  const id = nextId++;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const me = players.get(id);
    if (msg.type === 'join' && !me) {
      const p = { ws, name: clean(msg.name, 16) || 'Player', outfit: clean(msg.outfit, 12), state: null };
      players.set(id, p);
      send(ws, { type: 'welcome', id, players: [...players].filter(([pid]) => pid !== id).map(([pid, q]) => ({ id: pid, name: q.name, outfit: q.outfit, state: q.state })) });
      broadcast({ type: 'joined', id, name: p.name, outfit: p.outfit }, id);
      console.log(`+ ${p.name} (#${id}) — ${players.size} online`);
    } else if (msg.type === 'state' && me && Array.isArray(msg.s)) {
      me.state = msg.s.slice(0, 7).map(Number);
      broadcast({ type: 'state', id, s: me.state }, id);
    } else if (msg.type === 'signal' && me) { // WebRTC offer/answer/ICE, forwarded to one peer
      const to = players.get(msg.to);
      if (to) send(to.ws, { type: 'signal', from: id, data: msg.data });
    }
  });

  ws.on('close', () => {
    const p = players.get(id);
    if (!p) return;
    players.delete(id);
    broadcast({ type: 'left', id });
    console.log(`- ${p.name} (#${id}) — ${players.size} online`);
  });
});

// drop dead connections
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

function attach(server) {
  server.on('upgrade', (req, socket, head) => {
    if (req.url.split('?')[0] !== '/ws') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
}

// ---------------------------------------------------------------- HTTPS certificate
// Self-signed and cached in certs/; remade when this PC's network addresses change.
async function loadCert() {
  const dir = path.join(ROOT, 'certs');
  const ips = ['127.0.0.1', ...lanAddresses()];
  const metaFile = path.join(dir, 'ips.json');
  try {
    if (JSON.stringify(JSON.parse(fs.readFileSync(metaFile, 'utf8'))) === JSON.stringify(ips)) {
      return { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) };
    }
  } catch { /* no cached certificate yet */ }
  const selfsigned = require('selfsigned');
  const now = new Date();
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'HACA Office Explorer' }], {
    keySize: 2048,
    notBeforeDate: now,
    notAfterDate: new Date(now.getTime() + 2 * 365 * 24 * 3600 * 1000),
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, ...ips.map(ip => ({ type: 7, ip }))] }],
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'key.pem'), pems.private);
  fs.writeFileSync(path.join(dir, 'cert.pem'), pems.cert);
  fs.writeFileSync(metaFile, JSON.stringify(ips));
  return { key: pems.private, cert: pems.cert };
}

// ---------------------------------------------------------------- start
let httpsServer = null;
const httpServer = http.createServer(serveFile);
attach(httpServer);

(async () => {
  await new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(PORT, resolve); });
  try {
    httpsServer = https.createServer(await loadCert(), serveFile);
    attach(httpsServer);
    await new Promise((resolve, reject) => { httpsServer.once('error', reject); httpsServer.listen(HTTPS_PORT, resolve); });
  } catch (err) {
    console.log(`(HTTPS not started: ${err.message}) — voice chat will only work on localhost`);
    httpsServer = null;
  }
  console.log('');
  console.log('  HACA Office Explorer is running');
  console.log(`  This PC:        http://localhost:${PORT}`);
  for (const ip of lanAddresses()) {
    if (httpsServer) console.log(`  Same Wi-Fi:     https://${ip}:${HTTPS_PORT}   <- share this one (voice chat works)`);
    console.log(`  Same Wi-Fi:     http://${ip}:${PORT}    (no voice)`);
  }
  if (httpsServer) console.log('  First visit to the https link shows a security warning: click "Advanced" -> "Proceed".');
  console.log('');
})().catch((err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use — is the game already running in another window?` : err);
  process.exit(1);
});
