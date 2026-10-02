# XLICON-MD session site (Vercel)

Gives you a SESSION_ID for XLICON-MD via QR or pairing code.

## Deploy
1. Push this folder to its own GitHub repo.
2. Vercel: Add New > Project > import the repo. Framework preset: Other. No build command.
3. Project > Storage > add **Upstash Redis** (Marketplace). This adds the KV_REST_API_URL / KV_REST_API_TOKEN env vars.
4. Redeploy so the env vars apply.
5. (Optional) Settings > Functions > pick the region nearest the phone's country.

## How it works
- `POST /api/start` answers at once, then `waitUntil()` keeps the function alive (max 300s) while Baileys links.
- Progress (QR, code, final ID) is written to Redis; `GET /api/status?id=...` reads it, so any instance can answer.
- The session ID sits in Redis for at most 5 minutes (1 minute after you first see it).

## Safety
The session ID is a password for that WhatsApp account. Use a spare number. Do not run the bot and this site on the same session at once.
