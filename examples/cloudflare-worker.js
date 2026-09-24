// A Cloudflare Worker serving one account's recent watches as JSON.
//
//   wrangler secret put IMDB_USER_ID   # or set it as a plain var
//
// Use the ur.... id, not the p.... one: resolving a p.... id costs an extra
// request on every cold read, and the mapping never changes.
//
// The edge cache matters here: without it every page load hits IMDb.
//
// IMDb also rate-limits datacenter IPs, so from a Worker it answers 429 for a
// while, then fine again, with no warning either way. Bind a KV namespace as
// WATCH_CACHE and every good read is kept there; a failed one is answered from
// it instead of returning an error. Without the binding, failures are a 502.

import { recentlyWatched } from "../src/imdb.js";

const TTL = 600; // seconds
const LAST_GOOD = "imdb:last-good";

const json = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...init.headers,
    },
  });

export default {
  async fetch(request, env, ctx) {
    const cache = caches.default;
    const key = new Request(new URL(request.url).origin + "/watching");

    const hit = await cache.match(key);
    if (hit) return hit;

    try {
      const { items } = await recentlyWatched(env.IMDB_USER_ID, { limit: 8 });

      if (env.WATCH_CACHE && items.length) {
        const at = new Date().toISOString();
        ctx.waitUntil(env.WATCH_CACHE.put(LAST_GOOD, JSON.stringify({ items, at })));
      }

      const response = json(
        { items },
        { headers: { "Cache-Control": `public, max-age=${TTL}` } }
      );
      ctx.waitUntil(cache.put(key, response.clone()));
      return response;
    } catch (err) {
      const stale = await env.WATCH_CACHE?.get(LAST_GOOD, "json").catch(() => null);
      // Not edge-cached, so the next request tries IMDb again.
      if (stale?.items?.length) return json({ items: stale.items, stale: stale.at });

      return json({ error: err.code || "error", message: err.message }, { status: 502 });
    }
  },
};
