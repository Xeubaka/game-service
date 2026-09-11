// Upstash Redis REST client — the free-tier stand-in for a Durable Object's
// own storage. Upstash's REST API is plain HTTP GET/POST, so this is a
// handful of fetch() calls rather than a new npm dependency, matching how
// worker.js already talks to analysis-service/BOT_ORIGIN.
//
// See docs/CLOUDFLARE.md "Free-tier alternative" for why this exists instead
// of a Durable Object — gameRoom.js (the DO version this replaces) is in git
// history, not kept alongside this.

function upstash(env, ...command) {
  return fetch(`${env.UPSTASH_REDIS_REST_URL}/${command.map(encodeURIComponent).join("/")}`, {
    headers: { authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }
  }).then((res) => res.json());
}

export async function getRaw(env, key) {
  const { result } = await upstash(env, "GET", key);
  return result ? JSON.parse(result) : null;
}

export async function setRaw(env, key, value) {
  await upstash(env, "SET", key, JSON.stringify(value));
}

// ponytail: fixed window via INCR+EXPIRE, not a sliding window — a client
// can burst up to 2x limit right at a window boundary. Fine against a
// flood; revisit with a sorted-set sliding window only if that boundary
// burst is actually exploited. See docs/CLOUDFLARE.md "Rate limiting".
export async function rateLimitHit(env, ip, limit = 60, windowSeconds = 10) {
  const key = `rl:${ip}`;
  const count = await upstash(env, "INCR", key);
  if (count.result === 1) await upstash(env, "EXPIRE", key, windowSeconds);
  return count.result > limit;
}
