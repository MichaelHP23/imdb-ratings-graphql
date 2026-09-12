// A Cloudflare Worker serving one account's recent watches as JSON.
//
//   wrangler secret put IMDB_USER_ID   # or set it as a plain var
//
// The edge cache matters here: without it every page load hits IMDb.

import { recentlyWatched } from "../src/imdb.js";

const TTL = 600; // seconds

export default {
  async fetch(request, env, ctx) {
    const cache = caches.default;
    const key = new Request(new URL(request.url).origin + "/watching");

    const hit = await cache.match(key);
    if (hit) return hit;

    try {
      const { items } = await recentlyWatched(env.IMDB_USER_ID, { limit: 8 });

      const response = new Response(JSON.stringify({ items }), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${TTL}`,
          "Access-Control-Allow-Origin": "*",
        },
      });

      ctx.waitUntil(cache.put(key, response.clone()));
      return response;
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.code || "error", message: err.message }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }
  },
};
