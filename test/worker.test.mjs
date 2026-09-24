import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../examples/cloudflare-worker.js";

// No edge cache hits, so every request reaches IMDb.
globalThis.caches = { default: { match: async () => null, put: async () => {} } };

const kv = () => {
  const store = new Map();
  return {
    store,
    get: async (k) => JSON.parse(store.get(k) ?? "null"),
    put: async (k, v) => void store.set(k, v),
  };
};

const ctx = { pending: [], waitUntil(p) { this.pending.push(p); } };
const request = new Request("https://example.com/watching");
const env = (WATCH_CACHE) => ({ IMDB_USER_ID: "ur12345678", WATCH_CACHE });

const rating = {
  node: {
    userRating: { value: 8, date: "2026-01-02T00:00:00Z" },
    title: { id: "tt0000001", titleText: { text: "A Film" }, titleType: { isEpisode: false } },
  },
};

const imdbAnswers = (status) => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: { userRatings: { total: 1, edges: [rating] } } }), {
      status,
    });
};

test("a 429 is answered from the last good read", async () => {
  const cache = kv();

  imdbAnswers(200);
  await worker.fetch(request, env(cache), ctx);
  await Promise.all(ctx.pending);

  imdbAnswers(429);
  const res = await worker.fetch(request, env(cache), ctx);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.items[0].title, "A Film");
  assert.ok(body.stale);
});

test("a 429 with nothing kept is still a 502", async () => {
  imdbAnswers(429);
  assert.equal((await worker.fetch(request, env(kv()), ctx)).status, 502);
  assert.equal((await worker.fetch(request, env(undefined), ctx)).status, 502);
});
