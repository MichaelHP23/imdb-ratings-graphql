# imdb-ratings-graphql

Read an IMDb account's ratings programmatically — no API key, no login, no CSV
export, no scraping.

```bash
node src/cli.mjs p.abc123def456ghi789jkl012
```

```
42 ratings, 4 most recent titles:

2024-06-18   8/10  Poor Things
2024-06-11   9/10  The Bear — S3E4 Violet  [4 eps]
2024-05-30   7/10  Furiosa: A Mad Max Saga
2024-05-22  10/10  Shogun — S1E10 A Dream of a Dream  [10 eps]
```

Zero dependencies. Node 18+.

## Why this exists

IMDb publishes no API for personal account data, and the routes people reach for
are all shut:

| Route | Result |
| --- | --- |
| `www.imdb.com` (scraping) | `202` — AWS WAF bot challenge, needs a real browser to solve |
| `caching.graphql.imdb.com` | `403` |
| `rss.imdb.com/user/*/ratings` | `404` — retired |
| Ratings CSV export | Works, but manual and login-gated |

So the usual advice is that IMDb is a dead end, and that you should use
Letterboxd or Trakt instead.

But **`api.graphql.imdb.com`** — the endpoint IMDb's own web app talks to — has
no bot protection and answers `userRatings(userId:)` with no authentication at
all. That endpoint is well known for *title* data; several libraries wrap it.
Less documented is that it will also return an account's **ratings**, which is
what makes an automatic "recently watched" feed possible.

Ratings do not appear to need to be set to public — a private account's ratings
came back unchanged in testing.

## Install

```bash
git clone https://github.com/MichaelHP23/imdb-ratings-graphql
cd imdb-ratings-graphql
node src/cli.mjs <profile-id>
```

Nothing to install: no dependencies.

## Usage

```js
import { recentlyWatched } from "./src/imdb.js";

const { items } = await recentlyWatched("p.abc123def456ghi789jkl012", { limit: 8 });
```

```jsonc
{
  "id": "tt0944947",
  "title": "Game of Thrones",
  "kind": "series",
  "episode": { "season": 6, "number": 9, "title": "Battle of the Bastards", "id": "tt4283016" },
  "episodeCount": 5,           // rated episodes of this series in the window
  "myRating": 10,
  "imdbRating": 9.9,
  "ratedAt": "2024-04-02T21:14:07.000Z",
  "year": 2011,
  "genre": "Action",
  "poster": "https://m.media-amazon.com/images/...",
  "url": "https://www.imdb.com/title/tt0944947/"
}
```

### API

| Function | Returns |
| --- | --- |
| `recentlyWatched(id, { limit })` | One entry per title, episodes folded into their series, newest first |
| `fetchRatings(id, { first })` | Raw rating rows, newest first |
| `resolveUserId(id)` | `p....` → `ur....` |
| `fetchProfile(profileId)` | `{ userId, nickName }` |

Both id formats are accepted everywhere.

`examples/cloudflare-worker.js` serves this as a cached JSON endpoint.

## How it works

### Two id formats

Current IMDb profile URLs carry an opaque id:

```
https://www.imdb.com/user/p.abc123def456ghi789jkl012
```

`userRatings` predates that and only accepts the legacy numeric form. Hand it a
`p....` id and it fails with `Internal server error` — the same thing it returns
for a garbage string, which makes this confusing to debug.

`userProfile(input: { profileId: })` bridges the two:

```graphql
{ userProfile(input: { profileId: "p.abc123def456ghi789jkl012" }) {
    userId    # ur12345678
    nickName
} }
```

The mapping is permanent, so cache it. This library resolves automatically.

### The ratings query

```graphql
{ userRatings(userId: "ur12345678", first: 250) {
    total
    edges { node {
      userRating { value date }
      title {
        id titleText { text } titleType { id isEpisode isSeries }
        releaseYear { year } primaryImage { url }
        ratingsSummary { aggregateRating }
        series {
          episodeNumber { seasonNumber episodeNumber }
          series { id titleText { text } primaryImage { url } }
        }
      }
    } }
} }
```

One request returns the rating **and** the parent series **and** the
season/episode numbers. That is the main advantage over the CSV export, which
records that an episode was rated but not which series it belongs to — forcing a
second metadata lookup per row through something like OMDb.

`userRating.date` is a full ISO timestamp, so episodes rated minutes apart during
a binge stay correctly ordered. The CSV export is date-only and loses that.

### Sorting

`RatingsSortBy` exists as an enum, but introspection is disabled on this
endpoint and none of ten plausible values were accepted. So ordering is done
client-side: request a wide window and sort by rating date. `first` is a window
over the list rather than a page — ask for more than you need.

### Required headers

IMDb rejects requests that do not look like its own web client:

```
x-imdb-client-name: imdb-web-next
x-imdb-user-country: US
x-imdb-user-language: en-US
```

## Caveats

**This is undocumented internal plumbing.** Nobody promised it will keep
working, and it may change shape or disappear without notice. If you depend on
it, keep a fallback — the CSV export is the obvious one.

**IMDb's terms apply.** The endpoint returns this disclaimer with every response:

> Public, commercial, and/or non-private use of the IMDb data provided by this
> API is not allowed. For limited non-commercial use of IMDb data and the
> associated requirements see
> [IMDb's guidance](https://help.imdb.com/article/imdb/general-information/can-i-use-imdb-data-in-my-software/G5JTRESSHJBBHTGX).

Read it before building on this. Displaying your own ratings on your own
non-commercial site is the case it contemplates.

**Please don't use this to harvest other people's data.** The query accepts any
user id, which means it could be pointed at strangers in bulk. That is not what
this is for, and no discovery or enumeration helpers are included here
deliberately. Cache aggressively and don't hammer the endpoint.

All ids and titles in this README are made up for illustration.

## Contributing

Issues and pull requests welcome. Run the tests with:

```bash
node --test test/imdb.test.mjs
```

## Licence

MIT — see [LICENSE](./LICENSE).
