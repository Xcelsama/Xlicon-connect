const fs = require('fs');
const os = require('os');
const path = require('path');
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
const { save } = require('./store');

const LIMIT_MS = 270 * 1000; // stay under the function's 300s maxDuration
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logger = pino({ level: 'silent' });

// Runs one whole linking attempt. Progress is written to Redis so any instance can answer /api/status.
async function link({ id, mode, number }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xs-')); // /tmp is the only writable place on Vercel
  const state = { state: 'starting' };
  let sock = null;
  let finished = false;
  let opening = false;
  let codeRequested = false;

  // Serialize Redis writes so an older update can never land after a newer one.
  let chain = Promise.resolve();
  const publish = (patch) => {
    Object.assign(state, patch);
    const snapshot = { ...state };
    chain = chain.then(() => save(id, snapshot)).catch(() => {});
    return chain;
  };

  const stop = () => {
    if (!sock) return;
    try { sock.ev.removeAllListeners(); } catch {}
    try { sock.end(undefined); } catch {} // end(), never logout(): logout would unlink the device
    sock = null;
  };

  let finish;
  const settled = new Promise((resolve) => { finish = resolve; });
  const end = async (patch) => {
    if (finished) return;
    finished = true;
    stop();
    await publish(patch);
    finish();
  };

  const timer = setTimeout(() => end({ state: 'error', error: 'Timed out. Start again.' }), LIMIT_MS);

  const connect = async () => {
    stop(); // after WhatsApp's post-link restart, drop the old socket first
    const { state: auth, saveCreds } = await useMultiFileAuthState(dir);
    const fetched = await fetchLatestBaileysVersion().catch(() => ({}));
    const s = makeWASocket({
      version: fetched.version,
      logger,
      browser: Browsers.ubuntu('Chrome'),
      auth: { creds: auth.creds, keys: makeCacheableSignalKeyStore(auth.keys, logger) },
    });
    sock = s;
    s.ev.on('creds.update', saveCreds);

    s.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (finished || sock !== s) return;

      if (qr) {
        if (mode === 'qr') {
          await publish({ state: 'qr', qr: await QRCode.toDataURL(qr, { margin: 1, width: 320 }) });
        } else if (!codeRequested) {
          codeRequested = true; // ask once; QR events keep firing underneath
          try {
            const raw = await s.requestPairingCode(number);
            await publish({ state: 'code', code: raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw });
          } catch {
            await end({ state: 'error', error: 'Could not get a pairing code. Check the number (country code, digits only) and try again.' });
          }
        }
      }

      if (connection === 'open' && !opening) {
        opening = true;
        await sleep(2000); // let WhatsApp's last creds updates reach disk
        try {
          const raw = fs.readFileSync(path.join(dir, 'creds.json'), 'utf8');
          if (!JSON.parse(raw).me?.id) throw new Error('not registered');
          await end({ state: 'done', sessionId: Buffer.from(raw).toString('base64'), qr: undefined, code: undefined });
        } catch {
          await end({ state: 'error', error: 'Linked, but the session file was not ready. Try again.' });
        }
      }

      if (connection === 'close' && !opening) {
        const status = lastDisconnect?.error?.output?.statusCode;
        if (status === DisconnectReason.restartRequired) {
          await publish({ state: 'linking', qr: undefined, code: undefined }); // normal: one reconnect right after you link
          connect().catch(() => end({ state: 'error', error: 'Reconnect failed. Try again.' }));
        } else {
          await end({ state: 'error', error: `Connection closed (code ${status ?? 'unknown'}). Try again.` });
        }
      }
    });
  };

  try {
    await connect();
    await settled;
  } catch {
    await end({ state: 'error', error: 'Could not reach WhatsApp. Try again.' });
  } finally {
    clearTimeout(timer);
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { link };
