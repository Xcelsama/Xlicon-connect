const crypto = require('crypto');
const { waitUntil } = require('@vercel/functions');
const { redis, save } = require('../lib/store');
const { link } = require('../lib/link');

const START_LIMIT = 5;           // starts per IP...
const START_WINDOW_SECONDS = 600; // ...per 10 minutes

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const mode = body.mode;
  if (mode !== 'qr' && mode !== 'pair') return res.status(400).json({ error: 'Pick QR or pairing code.' });

  let number = '';
  if (mode === 'pair') {
    number = String(body.number || '').replace(/\D/g, '');
    if (number.length < 8 || number.length > 15) {
      return res.status(400).json({ error: 'Enter your number with country code, digits only.' });
    }
  }

  try {
    // Shared across instances, so the limit holds on serverless.
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const rateKey = `xs:rl:${ip}`;
    const count = await redis.incr(rateKey);
    if (count === 1) await redis.expire(rateKey, START_WINDOW_SECONDS);
    if (count > START_LIMIT) return res.status(429).json({ error: 'Too many attempts. Wait a few minutes.' });

    const id = crypto.randomBytes(16).toString('hex');
    await save(id, { state: 'starting' });

    // Respond now, keep this invocation (and the WhatsApp socket inside it) alive until linking ends.
    waitUntil(
      link({ id, mode, number }).catch(() =>
        save(id, { state: 'error', error: 'Something went wrong. Try again.' }).catch(() => {})
      )
    );
    return res.status(200).json({ id });
  } catch {
    return res.status(500).json({ error: 'Server is not set up yet. Check the Redis environment variables.' });
  }
};
