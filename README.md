# twitter-archive-merger

Merge multiple Twitter/X account archive zips into one browsable chronological timeline.

Zips stay put — nothing is modified or moved. The tool reads them in place, extracts JSON via `unzip -p`, extracts media once (resumably) to `.data/media/<handle>/`, buckets the merged timeline by year-month, and serves it as a static site.

## Requirements

- Node.js ≥ 20 (uses ESM + top-level await)
- `unzip` on `$PATH` (macOS + most Linux distros already have it)

## First run

```bash
# 1. Copy the template and point it at your archive zips
cp config.example.json config.json
$EDITOR config.json

# 2. Build the merged data (idempotent — reruns are fast; media extraction skips existing files)
npm run build

# 3. Serve the viewer
npm run serve
# → http://localhost:7716
```

Or in one shot: `npm start`.

`config.json` is gitignored — safe to store absolute paths to your local archive files. `config.example.json` is the shape reference; commit changes to that.

## config.json

```json
{
  "archives": [
    { "handle": "alchemisthomer",  "zip": "/absolute/path/to/alchemisthomer.zip" },
    { "handle": "odysseyofchrist", "zip": "/absolute/path/to/odysseyofchristtwitter.zip" }
  ],
  "outputDir": ".data",
  "servePort": 7716
}
```

`handle` is what shows up in the sidebar and on each tweet. It's used as the display name if the archive's `account.js` doesn't have one; either way it's the folder name for extracted media.

## Adding a new account

1. Download the account's Twitter/X archive.
2. Move (or leave) the zip anywhere on disk.
3. Add an entry to `config.json`.
4. `npm run build` — the new account is ingested, media extracted to `.data/media/<handle>/`, and the merged month buckets rewritten.
5. Refresh the viewer.

Old accounts stay intact between runs (media extraction is `unzip -n`, never overwrite). Removing an account from `config.json` and rebuilding drops its tweets from the merged timeline but leaves the extracted media on disk — delete `.data/media/<handle>/` manually to reclaim.

## What's in the timeline

Currently: **tweets, retweets, community tweets, replies, and note-tweets** (long-form X posts, joined back to their originating tweet by same-second timestamp).

Not included in this build: likes, DMs, blocks, mutes. Those live in the archive too and can be layered in later without changing the ingest schema.

## What's on disk after a build

```
.data/
├── index.json                        # accounts + month manifest + totals
├── months/
│   ├── 2021-09.json                  # one file per year-month, ascending order
│   ├── 2021-10.json
│   └── …
└── media/
    └── <handle>/
        └── data/
            ├── tweets_media/         # <tweetId>-<basename>.<ext>
            ├── community_tweet_media/
            └── profile_media/        # avatar + banner
```

`.data/` is gitignored. It's derived output — regenerate any time from the zips.

## How the viewer works

- Sidebar: account checkboxes (filter in/out), text search, hide-retweets/hide-replies toggles, year jumper, order toggle (newest first vs oldest first).
- Main pane: chronological timeline. Loads one month at a time; IntersectionObserver at top/bottom sentinels lazy-loads adjacent months as you scroll.
- Each tweet card shows avatar, display name, handle, timestamp (with a link to the tweet on x.com), body (with linkified URLs / mentions / hashtags), inline media, note-tweet expansion (highlighted with a left border when present), and badges for RT / reply / long-form / non-English.

## Retweet media

Twitter's archive only bundles YOUR media. Retweets that reference someone else's photo/video will show the remote `pbs.twimg.com` URL as a fallback — those may or may not still resolve, depending on whether the source tweet still exists. If both local and remote fail, the tile is replaced with a "media not in archive" placeholder.

## Tech notes

- No frameworks. Vanilla HTML/CSS/JS. `bin/serve.mjs` is a ~60-line Node HTTP server with zero runtime deps.
- Twitter's YTD `.js` data files are wrapped `window.YTD.<name>.part<N> = [...]`. `src/parsers.mjs` strips the assignment prefix and `JSON.parse`s the body. Multi-part files (large accounts) are discovered from `data/manifest.js`.
- Note-tweets join to regular tweets by `(accountId, floor(createdAt / 1s))` because their IDs are related-but-distinct snowflakes. In the dry-run against two archives, 1,061 / 1,061 notes joined with zero orphans.
- Sort key throughout is `createdAtEpoch` (UTC ms). Month buckets use `YYYY-MM` on UTC — a tweet posted at 23:30 UTC on the last day of the month falls in that UTC month, not your local one.
