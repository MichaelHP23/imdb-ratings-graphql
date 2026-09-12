// Read an IMDb account's ratings through IMDb's own GraphQL endpoint.
//
// IMDb publishes no API for personal account data, and the obvious routes are
// closed: www.imdb.com answers a non-browser request with an AWS WAF bot
// challenge, caching.graphql.imdb.com returns 403, and the per-user ratings RSS
// feeds were retired years ago. But api.graphql.imdb.com — the endpoint IMDb's
// own web app talks to — answers `userRatings(userId:)` with no authentication.
//
// See the README for the full write-up, including IMDb's terms.

const ENDPOINT = "https://api.graphql.imdb.com/";

// IMDb rejects requests that do not look like its own web client.
const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
  "x-imdb-client-name": "imdb-web-next",
  "x-imdb-user-country": "US",
  "x-imdb-user-language": "en-US",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
};

/** Legacy numeric id, e.g. ur12345678 — the only form userRatings accepts. */
export const UR_ID = /^ur\d{6,12}$/;

/** Current opaque profile id, e.g. p.abc123def456ghi789jkl012. */
export const PROFILE_ID = /^p\.[a-z0-9]{16,40}$/i;

export const isImdbUserId = (value) =>
  UR_ID.test(value || "") || PROFILE_ID.test(value || "");

export class ImdbError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ImdbError";
    this.code = code;
  }
}

async function query(document, variables, options = {}) {
  const doFetch = options.fetch || globalThis.fetch;

  const res = await doFetch(ENDPOINT, {
    method: "POST",
    headers: { ...DEFAULT_HEADERS, ...(options.headers || {}) },
    body: JSON.stringify({ query: document, variables }),
    ...(options.requestInit || {}),
  });

  if (!res.ok) {
    throw new ImdbError(`IMDb GraphQL returned ${res.status}`, "http_error");
  }

  const body = await res.json();

  if (body.errors?.length) {
    const message = body.errors[0].message || "Unknown GraphQL error";
    if (/Authentication required/i.test(message)) {
      throw new ImdbError(
        "IMDb refused the request without authentication — the account's " +
          "ratings are not readable this way",
        "auth_required"
      );
    }
    // What the endpoint says for an id it cannot parse, including a p.... one.
    if (/Internal server error/i.test(message)) {
      throw new ImdbError(
        "IMDb rejected the user id. userRatings only accepts the legacy " +
          "ur.... form — resolve a p.... id with resolveUserId() first",
        "bad_user_id"
      );
    }
    throw new ImdbError(message, "graphql_error");
  }

  return body.data;
}

const PROFILE_QUERY = `query Profile($id: ID!) {
  userProfile(input: { profileId: $id }) { userId nickName }
}`;

const RATINGS_QUERY = `query UserRatings($userId: ID!, $first: Int!) {
  userRatings(userId: $userId, first: $first) {
    total
    edges {
      node {
        userRating { value date }
        title {
          id
          titleText { text }
          titleType { id isEpisode isSeries }
          releaseYear { year }
          runtime { seconds }
          primaryImage { url }
          ratingsSummary { aggregateRating }
          genres { genres { text } }
          series {
            episodeNumber { seasonNumber episodeNumber }
            series {
              id
              titleText { text }
              primaryImage { url }
              releaseYear { year }
              ratingsSummary { aggregateRating }
              genres { genres { text } }
            }
          }
        }
      }
    }
  }
}`;

/**
 * Trade a current p.... profile id for the legacy ur.... id.
 *
 * IMDb moved profile URLs to the opaque form, but `userRatings` was never
 * updated to understand it — handed a p.... id it fails the same way it fails
 * on a garbage string. This is the bridge between the two.
 *
 * The mapping is permanent, so callers should cache it.
 */
export async function resolveUserId(profileId, options = {}) {
  if (UR_ID.test(profileId)) return profileId;

  if (!PROFILE_ID.test(profileId)) {
    throw new ImdbError(`Not an IMDb profile id: ${profileId}`, "bad_user_id");
  }

  const data = await query(PROFILE_QUERY, { id: profileId }, options);
  const userId = data?.userProfile?.userId;

  if (!userId) {
    throw new ImdbError(`Could not resolve ${profileId}`, "not_found");
  }
  return userId;
}

/** The nickname and both ids for a profile. */
export async function fetchProfile(profileId, options = {}) {
  const data = await query(PROFILE_QUERY, { id: profileId }, options);
  if (!data?.userProfile) {
    throw new ImdbError(`Could not resolve ${profileId}`, "not_found");
  }
  return data.userProfile;
}

/**
 * Raw ratings for an account, newest first.
 *
 * A `RatingsSortBy` enum exists but its values are not guessable with
 * introspection disabled, so ordering is done here rather than in the query.
 * That means `first` is a window over the whole list, not a page — ask for more
 * than you need.
 */
export async function fetchRatings(id, options = {}) {
  const { first = 250 } = options;
  const userId = await resolveUserId(id, options);

  const data = await query(RATINGS_QUERY, { userId, first }, options);
  const ratings = data?.userRatings;

  if (!ratings) throw new ImdbError("No ratings in response", "empty");

  const rows = (ratings.edges || [])
    .map((edge) => edge?.node)
    .filter((node) => node?.title?.id && node?.userRating?.date)
    .sort((a, b) => new Date(b.userRating.date) - new Date(a.userRating.date));

  if (!rows.length && ratings.total) {
    throw new ImdbError(
      `IMDb reports ${ratings.total} ratings but returned none`,
      "withheld"
    );
  }

  return { total: ratings.total ?? rows.length, userId, rows };
}

const firstGenre = (node) => node?.genres?.genres?.[0]?.text || null;
const minutes = (seconds) => (seconds ? Math.round(seconds / 60) : null);

/**
 * Ratings collapsed into a watch feed: one entry per title, episodes folded
 * into the series they belong to, newest first.
 *
 * Rating eight episodes of one show in a night yields a single entry at the top
 * carrying the newest episode and an `episodeCount` of 8, rather than eight
 * rows burying everything else.
 */
export async function recentlyWatched(id, options = {}) {
  const { limit = 10, ...rest } = options;
  const { rows, userId, total } = await fetchRatings(id, rest);

  const groups = new Map();

  for (const node of rows) {
    const { title } = node;
    const parent = title.series?.series || null;
    const isEpisode = Boolean(title.titleType?.isEpisode && parent);

    // Episodes collapse onto their series; a rated series and a rated episode
    // of it share a key and merge naturally.
    const key = isEpisode ? parent.id : title.id;
    const existing = groups.get(key);

    if (existing) {
      if (isEpisode) existing.episodeCount += 1;
      continue;
    }
    groups.set(key, { key, node, parent, isEpisode, episodeCount: isEpisode ? 1 : 0 });
  }

  const items = [...groups.values()].map(
    ({ key, node, parent, isEpisode, episodeCount }) => {
      const { title, userRating } = node;
      const shown = parent || title;

      let episode = null;
      if (isEpisode) {
        const { seasonNumber, episodeNumber } = title.series?.episodeNumber || {};
        episode = {
          season: seasonNumber ?? null,
          number: episodeNumber ?? null,
          title: title.titleText?.text || null,
          id: title.id,
        };
      }

      return {
        id: key,
        title: shown.titleText?.text || "Unknown title",
        kind: isEpisode || title.titleType?.isSeries ? "series" : "movie",
        episode,
        episodeCount,
        myRating: userRating.value ?? null,
        imdbRating: shown.ratingsSummary?.aggregateRating ?? null,
        ratedAt: new Date(userRating.date).toISOString(),
        year: shown.releaseYear?.year ?? null,
        genre: firstGenre(shown) || firstGenre(title),
        runtimeMinutes: isEpisode ? null : minutes(title.runtime?.seconds),
        poster: shown.primaryImage?.url || title.primaryImage?.url || null,
        url: `https://www.imdb.com/title/${key}/`,
      };
    }
  );

  return { userId, total, items: items.slice(0, limit) };
}
