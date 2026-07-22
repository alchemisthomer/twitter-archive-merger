// Read Twitter YTD archives directly from the .zip (no full extraction of JSON).
// Media folders are extracted once to disk (resumable, idempotent) via `unzip -n`.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

import { unwrapYtdText, normalizeTweet, normalizeNoteTweet, joinNoteTweets } from './parsers.mjs';

const exec = promisify(execFile);

// unzip -p prints a file to stdout. maxBuffer bumped to 128MB for large tweets.js.
async function readZipFile(zipPath, innerPath) {
  const { stdout } = await exec('unzip', ['-p', zipPath, innerPath], {
    maxBuffer: 128 * 1024 * 1024,
    encoding: 'utf8',
  });
  return stdout;
}

// The manifest is `window.__THAR_CONFIG = { ... };` — different prefix from other files.
async function readManifest(zipPath) {
  const text = await readZipFile(zipPath, 'data/manifest.js');
  const eq = text.indexOf('=');
  return JSON.parse(text.slice(eq + 1));
}

function filesFor(manifest, typeKey) {
  const t = manifest.dataTypes?.[typeKey];
  if (!t?.files) return [];
  return t.files.map(f => f.fileName);
}

export async function readArchive({ handle, zip: zipPath }) {
  if (!fs.existsSync(zipPath)) throw new Error(`Zip not found: ${zipPath}`);

  const manifest = await readManifest(zipPath);
  const accountId = manifest.userInfo?.accountId || null;
  const displayName = manifest.userInfo?.displayName || null;
  const archiveGeneratedAt = manifest.archiveInfo?.generationDate || null;

  // account + profile give us richer attribution.
  const accountRaw = unwrapYtdText(await readZipFile(zipPath, 'data/account.js'));
  const profileRaw = unwrapYtdText(await readZipFile(zipPath, 'data/profile.js'));
  const account = accountRaw[0]?.account || {};
  const profile = profileRaw[0]?.profile || {};

  const source = {
    handle: handle || account.username,
    accountId: accountId || account.accountId,
    displayName: displayName || account.accountDisplayName,
  };

  // Collect tweets across tweets.js + community-tweet.js (same schema).
  const tweetFiles = [
    ...filesFor(manifest, 'tweets'),
    ...filesFor(manifest, 'communityTweet'),
  ];
  const tweets = [];
  for (const file of tweetFiles) {
    let raw;
    try { raw = unwrapYtdText(await readZipFile(zipPath, file)); }
    catch (e) {
      console.warn(`  ! skipping ${file}: ${e.message}`);
      continue;
    }
    for (const rec of raw) {
      try { tweets.push(normalizeTweet(rec, source)); }
      catch (e) { console.warn(`  ! bad tweet in ${file}: ${e.message}`); }
    }
  }

  // Note-tweets
  const noteFiles = filesFor(manifest, 'noteTweet');
  const notes = [];
  for (const file of noteFiles) {
    let raw;
    try { raw = unwrapYtdText(await readZipFile(zipPath, file)); }
    catch (e) {
      console.warn(`  ! skipping ${file}: ${e.message}`);
      continue;
    }
    for (const rec of raw) {
      try {
        const n = normalizeNoteTweet(rec);
        n.__accountId = source.accountId;
        notes.push(n);
      } catch (e) { console.warn(`  ! bad note in ${file}: ${e.message}`); }
    }
  }

  const joinStats = joinNoteTweets(tweets, notes);

  return {
    source,
    profile: {
      bio: profile.description?.bio || '',
      location: profile.description?.location || '',
      website: profile.description?.website || '',
      avatarMediaUrl: profile.avatarMediaUrl || null,
      headerMediaUrl: profile.headerMediaUrl || null,
    },
    createdAt: account.createdAt || null,
    archiveGeneratedAt,
    tweets,
    counts: {
      tweets: tweets.length,
      notes: notes.length,
      notesJoined: joinStats.joined,
      notesOrphaned: joinStats.orphans,
    },
  };
}

// Extract media folders in-place (idempotent — unzip -n never overwrites).
// Returns whichever inner-path folders were present.
export async function extractMedia(zipPath, targetDir, folders = ['tweets_media', 'community_tweet_media', 'profile_media']) {
  fs.mkdirSync(targetDir, { recursive: true });
  const results = {};
  for (const folder of folders) {
    const pattern = `data/${folder}/*`;
    try {
      const { stdout } = await exec('unzip', ['-n', '-q', zipPath, pattern, '-d', targetDir], {
        maxBuffer: 32 * 1024 * 1024,
      });
      // Count files present after extraction.
      const dir = path.join(targetDir, 'data', folder);
      const count = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
      results[folder] = count;
    } catch (e) {
      // unzip returns non-zero if the pattern matched nothing — silently OK.
      if (!/caution:.*not matched|filename not matched/i.test(e.stderr || e.message)) {
        console.warn(`  ! media extract for ${folder}: ${e.message}`);
      }
      results[folder] = 0;
    }
  }
  return results;
}
