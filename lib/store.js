const { Redis } = require('@upstash/redis');

// Reads UPSTASH_REDIS_REST_URL/TOKEN or KV_REST_API_URL/TOKEN (what the Vercel Upstash integration adds).
const redis = Redis.fromEnv();

const TTL_SECONDS = 330; // a little longer than the 270s linking window
const key = (id) => `xs:${id}`;

const save = (id, state) => redis.set(key(id), state, { ex: TTL_SECONDS });
const load = (id) => redis.get(key(id));
const shorten = (id, seconds) => redis.expire(key(id), seconds);

module.exports = { redis, save, load, shorten };
