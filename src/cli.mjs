#!/usr/bin/env node
// Print an IMDb account's recent watches.
//
//   node src/cli.mjs p.abc123def456ghi789jkl012
//   node src/cli.mjs ur12345678 --limit 20 --json

import { recentlyWatched, fetchProfile, isImdbUserId, PROFILE_ID } from "./imdb.js";

const argv = process.argv.slice(2);

// --limit takes a value; --json does not. Everything left over is the id.
const VALUE_FLAGS = new Set(["--limit"]);
const options = {};
const positional = [];

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (VALUE_FLAGS.has(arg)) options[arg.slice(2)] = argv[++i];
  else if (arg.startsWith("--")) options[arg.slice(2)] = true;
  else positional.push(arg);
}

const id = positional[0];
const asJson = Boolean(options.json);
const limit = Number(options.limit ?? 10);

if (!id || !isImdbUserId(id)) {
  console.error(`Usage: imdb-ratings <profile-id> [--limit N] [--json]

  <profile-id>  the id from your IMDb profile URL, either form:
                  https://www.imdb.com/user/p.abc123def456ghi789jkl012
                  https://www.imdb.com/user/ur12345678
`);
  process.exit(1);
}

try {
  if (PROFILE_ID.test(id)) {
    const profile = await fetchProfile(id);
    console.error(`${profile.nickName}  ${id} -> ${profile.userId}\n`);
  }

  const { items, total } = await recentlyWatched(id, { limit });

  if (asJson) {
    console.log(JSON.stringify(items, null, 2));
  } else {
    console.error(`${total} ratings, ${items.length} most recent titles:\n`);
    for (const item of items) {
      const when = item.ratedAt.slice(0, 10);
      const score = item.myRating ? `${String(item.myRating).padStart(2)}/10` : "  -  ";
      const ep = item.episode
        ? ` — S${item.episode.season}E${item.episode.number} ${item.episode.title}`
        : "";
      const binge = item.episodeCount > 1 ? `  [${item.episodeCount} eps]` : "";
      console.log(`${when}  ${score}  ${item.title}${ep}${binge}`);
    }
  }
} catch (err) {
  console.error(`${err.name || "Error"} [${err.code || "unknown"}]: ${err.message}`);
  process.exit(1);
}
