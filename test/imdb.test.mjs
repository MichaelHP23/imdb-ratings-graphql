import { test } from "node:test";
import assert from "node:assert/strict";
import { recentlyWatched, resolveUserId, isImdbUserId, ImdbError } from "../src/imdb.js";

const episode = (id, name, season, number, date, value, seriesId, seriesName) => ({
  node: {
    userRating: { value, date },
    title: {
      id,
      titleText: { text: name },
      titleType: { id: "tvEpisode", isEpisode: true, isSeries: false },
      releaseYear: { year: 2024 },
      runtime: { seconds: 1320 },
      primaryImage: { url: `https://img/${id}.jpg` },
      ratingsSummary: { aggregateRating: 8.8 },
      genres: { genres: [{ text: "Animation" }] },
      series: {
        episodeNumber: { seasonNumber: season, episodeNumber: number },
        series: {
          id: seriesId,
          titleText: { text: seriesName },
          primaryImage: { url: `https://img/${seriesId}.jpg` },
          releaseYear: { year: 2013 },
          ratingsSummary: { aggregateRating: 9.1 },
          genres: { genres: [{ text: "Animation" }] },
        },
      },
    },
  },
});

const movie = {
  node: {
    userRating: { value: 10, date: "2026-08-03T00:00:00Z" },
    title: {
      id: "tt14230458", titleText: { text: "Poor Things" },
      titleType: { id: "movie", isEpisode: false, isSeries: false },
      releaseYear: { year: 2026 }, runtime: { seconds: 7200 },
      primaryImage: { url: "https://img/poor-things.jpg" },
      ratingsSummary: { aggregateRating: 7.9 },
      genres: { genres: [{ text: "Action" }] },
      series: null,
    },
  },
};

/** Stubs global fetch with a canned GraphQL response. */
function stub(handler) {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify(handler(body)), { status: 200 });
  };
}

const RATINGS = {
  data: { userRatings: { total: 4, edges: [
    // deliberately out of order — the library must sort
    episode("tt_e8", "Napkins", 9, 9, "2026-08-02T03:21:55Z", 8, "tt14452776", "The Bear"),
    movie,
    episode("tt_e10", "Fun and Games", 9, 10, "2026-08-02T03:43:58Z", 9, "tt14452776", "The Bear"),
    episode("tt_e7", "Doors", 9, 8, "2026-08-02T02:58:28Z", 8, "tt14452776", "The Bear"),
  ] } },
};

test("collapses episodes into one entry per series, newest first", async () => {
  stub(() => RATINGS);
  const { items } = await recentlyWatched("ur12345678");

  assert.equal(items.length, 2, "three episodes plus a film become two entries");

  const series = items.find((i) => i.title === "The Bear");
  assert.equal(series.episodeCount, 3);
  assert.equal(series.episode.number, 10, "newest episode represents the series");
  assert.equal(series.url, "https://www.imdb.com/title/tt14452776/");
  assert.equal(series.poster, "https://img/tt14452776.jpg", "series poster, not the episode still");
  assert.equal(series.myRating, 9, "the newest episode's score is the one shown");

  const film = items.find((i) => i.kind === "movie");
  assert.equal(film.runtimeMinutes, 120);
  assert.equal(film.episode, null, "films carry no episode block");
});

test("orders strictly by when each title was last rated", async () => {
  stub(() => RATINGS);
  const { items } = await recentlyWatched("ur12345678");
  const dates = items.map((i) => new Date(i.ratedAt).getTime());
  assert.deepEqual(dates, [...dates].sort((a, b) => b - a));
});

test("resolves a p.... profile id to its ur.... id", async () => {
  stub((body) =>
    body.query.includes("userProfile")
      ? { data: { userProfile: { userId: "ur12345678", nickName: "moviefan" } } }
      : RATINGS
  );
  assert.equal(await resolveUserId("p.abc123def456ghi789jkl012"), "ur12345678");
  assert.equal(await resolveUserId("ur12345678"), "ur12345678", "ur ids pass through untouched");
});

test("explains a rejected user id rather than leaking the raw error", async () => {
  stub(() => ({ errors: [{ message: "Internal server error" }] }));
  await assert.rejects(
    () => recentlyWatched("ur999999999"),
    (err) => err instanceof ImdbError && err.code === "bad_user_id"
  );
});

test("flags ratings that are counted but withheld", async () => {
  stub(() => ({ data: { userRatings: { total: 168, edges: [] } } }));
  await assert.rejects(
    () => recentlyWatched("ur12345678"),
    (err) => err.code === "withheld" && /168/.test(err.message)
  );
});

test("validates id shapes", () => {
  assert.ok(isImdbUserId("ur12345678"));
  assert.ok(isImdbUserId("p.abc123def456ghi789jkl012"));
  assert.ok(!isImdbUserId("moviefan"), "a nickname is not an id");
  assert.ok(!isImdbUserId(""));
});
