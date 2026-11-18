// Phase 0 probe server: static files + Web Push endpoints.
// Loopback only; publish with `tailscale serve`. Throwaway code.
import http from 'node:http';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateVAPIDKeys, setVapidDetails, sendNotification } from 'web-push';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, '.data');
const subFile = path.join(dataDir, 'subscription.json');
const vapidFile = path.join(dataDir, 'vapid.json');
const MAX_DELAY_MS = 120_000;
const MAX_BODY = 1 << 20;

function portFromArgs() {
  for (const v of [process.argv[2], process.env.PORT]) {
    const n = Number.parseInt(v ?? '', 10);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  }
  return 8787;
}
const port = portFromArgs();

mkdirSync(dataDir, { recursive: true, mode: 0o700 });

// VAPID keys, generated on first run.
let vapid;
if (existsSync(vapidFile)) {
  vapid = JSON.parse(readFileSync(vapidFile, 'utf8'));
} else {
  vapid = generateVAPIDKeys();
  writeFileSync(vapidFile, JSON.stringify(vapid, null, 2) + '\n', { mode: 0o600 });
  console.log(`generated VAPID key pair: ${vapidFile}`);
}
setVapidDetails('mailto:phase0-probe@localhost', vapid.publicKey, vapid.privateKey);

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/icons/icon-180.png': ['icons/icon-180.png', 'image/png'],
  '/icons/icon-512.png': ['icons/icon-512.png', 'image/png'],
};

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj) + '\n';
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

function loadSubscription() {
  if (!existsSync(subFile)) return null;
  try {
    return JSON.parse(readFileSync(subFile, 'utf8'));
  } catch {
    return null;
  }
}

function sendPush() {
  const sub = loadSubscription();
  if (!sub) return console.error('push skipped: no stored subscription');
  const payload = JSON.stringify({
    title: 'Phase 0 probe',
    body: `Test push ${new Date().toLocaleTimeString()}`,
  });
  sendNotification(sub, payload)
    .then((r) => console.log(`push sent: endpoint ${new URL(sub.endpoint).host} -> ${r.statusCode}`))
    .catch((err) => {
      console.error(`push failed: ${err.statusCode ?? ''} ${err.message}`);
      if (err.statusCode === 404 || err.statusCode === 410) {
        console.error('push service says the subscription is gone; tap "Enable notifications & subscribe" on the phone again.');
      }
    });
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const log = () => console.log(`${new Date().toISOString()} ${req.method} ${url} -> ${res.statusCode}`);
  res.on('finish', log);

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (url === '/vapid-public') {
      return sendJSON(res, 200, { publicKey: vapid.publicKey });
    }
    const entry = STATIC[url];
    if (entry) {
      try {
        const buf = readFileSync(path.join(root, entry[0]));
        res.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-cache' });
        return res.end(req.method === 'HEAD' ? undefined : buf);
      } catch (err) {
        console.error(err);
        return sendJSON(res, 500, { error: 'failed to read static file' });
      }
    }
    return sendJSON(res, 404, { error: 'not found' });
  }

  if (req.method === 'POST' && (url === '/subscribe' || url === '/push')) {
    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return sendJSON(res, 400, { error: 'invalid JSON body' });
    }

    if (url === '/subscribe') {
      const ok =
        body &&
        typeof body.endpoint === 'string' &&
        body.keys &&
        typeof body.keys.p256dh === 'string' &&
        typeof body.keys.auth === 'string';
      if (!ok) return sendJSON(res, 400, { error: 'not a PushSubscription JSON' });
      writeFileSync(subFile, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
      chmodSync(subFile, 0o600);
      return sendJSON(res, 200, { ok: true, stored: subFile });
    }

    // POST /push: schedule a test push.
    const delayMs = Math.min(Math.max(Number(body.delayMs ?? 0) | 0, 0), MAX_DELAY_MS);
    if (!loadSubscription()) return sendJSON(res, 409, { error: 'no stored subscription; enable notifications on the phone first' });
    const sendAt = new Date(Date.now() + delayMs);
    setTimeout(sendPush, delayMs);
    return sendJSON(res, 200, { ok: true, delayMs, sendAt: sendAt.toISOString() });
  }

  return sendJSON(res, 404, { error: 'not found' });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`phase0 probe: http://127.0.0.1:${port} (loopback only; publish with: tailscale serve --bg ${port})`);
});
