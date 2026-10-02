const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  DisconnectReason,
} = require('baileys');

const PORT = process.env.PORT || 3000;
const MAX_ACTIVE = 5;                 // linking attempts running at once
const TTL_MS = 3 * 60 * 1000;         // an attempt dies after 3 minutes
const KEEP_DONE_MS = 5 * 60 * 1000;   // a finished SESSION_ID stays fetchable this long
const START_LIMIT = 5;                // starts allowed per IP...
const START_WINDOW_MS = 10 * 60 * 1000; // ...per 10 minutes

const logger = pino({ level: 'silent' });
const sessions = new Map(); // id -> attempt state
const starts = new Map();   // ip -> [timestamps]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- one linking attempt ----------

function closeSocket(s) {
  if (!s.sock) return;
  try { s.sock.ev.removeAllListeners(); } catch {}
  try { s.sock.end(undefined); } catch {}   // NOT logout(): logging out would unlink the device
  s.sock = null;
}

function destroy(id) {
  const s = sessions.get(id);
  if (!s) return;
  closeSocket(s);
  fs.rm(s.dir, { recursive: true, force: true }, () => {});
  sessions.delete(id);
}

function fail(s, message) {
  if (s.state === 'done') return;
  s.state = 'error';
  s.error = message;
  closeSocket(s);
  fs.rm(s.dir, { recursive: true, force: true }, () => {});
}

async function finish(s) {
  if (s.finishing || s.state === 'done') return;
  s.finishing = true;
  await sleep(2000); // let WhatsApp's last creds updates land on disk
  try {
    const raw = fs.readFileSync(path.join(s.dir, 'creds.json'), 'utf8');
    if (!JSON.parse(raw).me?.id) throw new Error('not registered');
    s.sessionId = Buffer.from(raw).toString('base64'); // XLICON-MD decodes this with atob()
    s.state = 'done';
    s.expires = Date.now() + KEEP_DONE_MS;
    closeSocket(s);
    fs.rm(s.dir, { recursive: true, force: true }, () => {});
  } catch {
    fail(s, 'Linked, but the session file was not ready. Try again.');
  }
}

async function connect(s) {
  closeSocket(s); // after a restart, drop the previous socket first
  const { state, saveCreds } = await useMultiFileAuthState(s.dir);
  const fetched = await fetchLatestBaileysVersion().catch(() => ({}));
  const sock = makeWASocket({
    version: fetched.version,
    logger,
    browser: Browsers.ubuntu('Chrome'),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
  });
  s.sock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (s.state === 'done' || s.state === 'error') return;

    if (qr) {
      if (s.mode === 'qr') {
        s.qr = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
        s.state = 'qr';
      } else if (!s.codeRequested) {
        s.codeRequested = true; // ask once; the QR keeps refreshing underneath
        try {
          const raw = await sock.requestPairingCode(s.number);
          s.code = raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
          s.state = 'code';
        } catch {
          fail(s, 'Could not get a pairing code. Check the number (country code, digits only) and try again.');
        }
      }
    }

    if (connection === 'open') finish(s);

    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode;
      if (s.finishing) return;
      if (status === DisconnectReason.restartRequired) {
        s.state = 'linking'; // normal: WhatsApp asks for one reconnect right after you link
        connect(s).catch(() => fail(s, 'Reconnect failed. Try again.'));
      } else {
        fail(s, `Connection closed (code ${status ?? 'unknown'}). Try again.`);
      }
    }
  });
}

// ---------- housekeeping ----------

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now > s.expires) destroy(id);
  for (const [ip, times] of starts) {
    const recent = times.filter((t) => now - t < START_WINDOW_MS);
    if (recent.length) starts.set(ip, recent); else starts.delete(ip);
  }
}, 30 * 1000).unref();

// ---------- web ----------

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', 1); // set when behind Render/Heroku/nginx
app.use(express.json({ limit: '1kb' }));
app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/start', (req, res) => {
  const mode = req.body?.mode;
  if (mode !== 'qr' && mode !== 'pair') return res.status(400).json({ error: 'Pick QR or pairing code.' });

  let number = '';
  if (mode === 'pair') {
    number = String(req.body?.number || '').replace(/\D/g, '');
    if (number.length < 8 || number.length > 15) {
      return res.status(400).json({ error: 'Enter your number with country code, digits only.' });
    }
  }

  const recent = (starts.get(req.ip) || []).filter((t) => Date.now() - t < START_WINDOW_MS);
  if (recent.length >= START_LIMIT) return res.status(429).json({ error: 'Too many attempts. Wait a few minutes.' });
  const active = [...sessions.values()].filter((s) => s.state !== 'done' && s.state !== 'error').length;
  if (active >= MAX_ACTIVE) return res.status(503).json({ error: 'Busy right now. Try again in a minute.' });
  recent.push(Date.now());
  starts.set(req.ip, recent);

  const id = crypto.randomBytes(16).toString('hex');
  const s = {
    mode, number, state: 'starting',
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'xs-')),
    expires: Date.now() + TTL_MS,
  };
  sessions.set(id, s);
  connect(s).catch(() => fail(s, 'Could not reach WhatsApp. Try again.'));
  res.json({ id });
});

app.get('/api/status/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ state: 'expired' });
  res.json({ state: s.state, qr: s.qr, code: s.code, sessionId: s.sessionId, error: s.error });
});

app.delete('/api/session/:id', (req, res) => {
  destroy(req.params.id);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Session site running on http://localhost:${PORT}`));
