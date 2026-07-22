#!/usr/bin/env node
// Build the merged chronological archive.
//
// Reads config.json, ingests each archive, merges all tweets across accounts,
// buckets by YYYY-MM (UTC), and writes:
//   .data/index.json            — accounts + month manifest + totals
//   .data/months/YYYY-MM.json   — merged tweets for that month (asc within month)
//   .data/media/<handle>/…      — extracted media (once per archive)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readArchive, extractMedia } from '../src/archive.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const configPath = path.join(repoRoot, 'config.json');
if (!fs.existsSync(configPath)) {
  console.error(`config.json not found at ${configPath}`);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const outputDir = path.resolve(repoRoot, config.outputDir || '.data');
const monthsDir = path.join(outputDir, 'months');
const mediaRoot = path.join(outputDir, 'media');
fs.mkdirSync(monthsDir, { recursive: true });
fs.mkdirSync(mediaRoot, { recursive: true });

const t0 = Date.now();
const accounts = [];
const allTweets = [];

for (const arch of config.archives) {
  console.log(`\n📥  Ingesting ${arch.handle}  ←  ${arch.zip}`);
  const t = Date.now();

  const result = await readArchive(arch);
  const { source, profile, createdAt, archiveGeneratedAt, tweets, counts } = result;
  console.log(`   ${counts.tweets.toLocaleString()} tweets  ·  ${counts.notes} notes  (joined ${counts.notesJoined}, orphaned ${counts.notesOrphaned})  ·  ${((Date.now()-t)/1000).toFixed(1)}s`);

  // Extract media (resumable — unzip -n skips existing).
  const mediaTarget = path.join(mediaRoot, source.handle);
  console.log(`   extracting media → ${path.relative(repoRoot, mediaTarget)}/`);
  const mediaCounts = await extractMedia(arch.zip, mediaTarget);
  console.log(`   media: tweets_media ${mediaCounts.tweets_media} · community_tweet_media ${mediaCounts.community_tweet_media} · profile_media ${mediaCounts.profile_media}`);

  // Derive avatar local path from profile.avatarMediaUrl basename.
  const profileMediaDir = path.join(mediaTarget, 'data', 'profile_media');
  const resolveProfileMedia = (remoteUrl) => {
    if (!remoteUrl) return null;
    const basename = remoteUrl.split('/').pop();
    // Try exact match first (avatar URLs include extension), then common extensions
    // for banner URLs (which typically omit extension).
    const candidates = [
      `${source.accountId}-${basename}`,
      `${source.accountId}-${basename}.jpg`,
      `${source.accountId}-${basename}.png`,
      `${source.accountId}-${basename}.jpeg`,
    ];
    for (const c of candidates) {
      if (fs.existsSync(path.join(profileMediaDir, c))) {
        return `media/${source.handle}/data/profile_media/${c}`;
      }
    }
    return null;
  };

  const avatarLocal = resolveProfileMedia(profile.avatarMediaUrl);
  const headerLocal = resolveProfileMedia(profile.headerMediaUrl);

  accounts.push({
    handle: source.handle,
    accountId: source.accountId,
    displayName: source.displayName,
    createdAt,
    archiveGeneratedAt,
    bio: profile.bio,
    location: profile.location,
    website: profile.website,
    avatarLocal,
    avatarRemote: profile.avatarMediaUrl,
    headerLocal,
    headerRemote: profile.headerMediaUrl,
    tweetCount: counts.tweets,
    noteCount: counts.notes,
  });

  for (const tw of tweets) allTweets.push(tw);
}

console.log(`\n🔀  Merging ${allTweets.length.toLocaleString()} tweets across ${accounts.length} accounts…`);

// Sort ascending overall; per-month bucket keeps ascending order too.
allTweets.sort((a, b) => a.createdAtEpoch - b.createdAtEpoch);

// Bucket by YYYY-MM (UTC).
const monthMap = new Map();
for (const tw of allTweets) {
  const d = new Date(tw.createdAtEpoch);
  const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  let arr = monthMap.get(key);
  if (!arr) { arr = []; monthMap.set(key, arr); }
  arr.push(tw);
}

// Wipe existing month files (we're rewriting all of them).
for (const f of fs.readdirSync(monthsDir)) {
  if (f.endsWith('.json')) fs.unlinkSync(path.join(monthsDir, f));
}

const months = [];
const perAccountPerMonth = {}; // { handle: { 'YYYY-MM': count } }
for (const acc of accounts) perAccountPerMonth[acc.handle] = {};

for (const [key, arr] of [...monthMap.entries()].sort()) {
  fs.writeFileSync(path.join(monthsDir, `${key}.json`), JSON.stringify(arr));
  const perAccount = {};
  for (const tw of arr) {
    perAccount[tw.account] = (perAccount[tw.account] || 0) + 1;
    perAccountPerMonth[tw.account][key] = (perAccountPerMonth[tw.account][key] || 0) + 1;
  }
  months.push({ key, count: arr.length, perAccount });
}

const first = allTweets[0];
const last = allTweets[allTweets.length - 1];

const index = {
  builtAt: new Date().toISOString(),
  accounts,
  months,
  perAccountPerMonth,
  totals: {
    tweets: allTweets.length,
    accounts: accounts.length,
    dateRange: first && last ? {
      first: first.createdAtIso,
      last: last.createdAtIso,
    } : null,
  },
};

fs.writeFileSync(path.join(outputDir, 'index.json'), JSON.stringify(index, null, 2));

console.log(`\n✅  Wrote ${months.length} month files + index.json → ${path.relative(repoRoot, outputDir)}/`);
console.log(`   Range: ${index.totals.dateRange?.first?.slice(0,10)} → ${index.totals.dateRange?.last?.slice(0,10)}`);
console.log(`   Total: ${((Date.now()-t0)/1000).toFixed(1)}s\n`);
