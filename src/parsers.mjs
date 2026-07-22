// Parsers for Twitter's YTD archive format.
//
// Every data/*.js file is shaped: `window.YTD.<name>.part<N> = [ ... ]`
// Strip the assignment prefix, JSON.parse the array body.

export function unwrapYtdText(text) {
  const eq = text.indexOf('=');
  if (eq === -1) throw new Error('Not a YTD file: missing "="');
  return JSON.parse(text.slice(eq + 1));
}

// Twitter's classic created_at: "Sat Jul 05 08:43:50 +0000 2025".
// note-tweet.createdAt is ISO 8601. Both parse fine with new Date().
export function parseTwitterDate(s) {
  const d = new Date(s);
  if (isNaN(d.getTime())) throw new Error(`Bad date: ${s}`);
  return d;
}

// "<a href="…">Twitter for iPhone</a>" → "Twitter for iPhone"
export function cleanSource(html) {
  if (!html) return null;
  const m = String(html).match(/>([^<]+)</);
  return m ? m[1] : html;
}

function normalizeMedia(m) {
  const variants = m.video_info?.variants || null;
  const mp4s = variants ? variants
    .filter(v => v.content_type === 'video/mp4' && v.bitrate)
    .sort((a, b) => Number(b.bitrate) - Number(a.bitrate)) : null;
  return {
    type: m.type,
    id: m.id_str,
    url: m.media_url_https || m.media_url,
    bestMp4: mp4s && mp4s.length ? mp4s[0].url : null,
    sourceStatusId: m.source_status_id || null,
    sourceUserId: m.source_user_id_str || m.source_user_id || null,
  };
}

export function normalizeTweet(raw, source) {
  const t = raw.tweet;
  const media = (t.extended_entities?.media || t.entities?.media || []).map(normalizeMedia);
  const urls = (t.entities?.urls || []).map(u => ({
    tco: u.url,
    expanded: u.expanded_url,
    display: u.display_url,
  }));
  const mentions = (t.entities?.user_mentions || []).map(u => ({
    id: u.id_str,
    screenName: u.screen_name,
    name: u.name,
  }));
  const hashtags = (t.entities?.hashtags || []).map(h => h.text);
  const created = parseTwitterDate(t.created_at);
  const rtMatch = t.full_text?.match(/^RT @(\w+):\s?/);

  return {
    id: t.id_str,
    account: source.handle,
    accountId: source.accountId,
    createdAtIso: created.toISOString(),
    createdAtEpoch: created.getTime(),
    text: t.full_text || '',
    lang: t.lang || null,
    inReplyToTweetId: t.in_reply_to_status_id_str || null,
    inReplyToUserId: t.in_reply_to_user_id_str || null,
    inReplyToScreenName: t.in_reply_to_screen_name || null,
    isRetweet: !!rtMatch,
    retweetOf: rtMatch ? rtMatch[1] : null,
    source: cleanSource(t.source),
    favoriteCount: Number(t.favorite_count) || 0,
    retweetCount: Number(t.retweet_count) || 0,
    possiblySensitive: !!t.possibly_sensitive,
    media,
    urls,
    mentions,
    hashtags,
    noteText: null,
  };
}

export function normalizeNoteTweet(raw) {
  const n = raw.noteTweet;
  const created = new Date(n.createdAt);
  return {
    id: n.noteTweetId,
    createdAtEpoch: created.getTime(),
    text: n.core?.text || '',
  };
}

// Note tweets link to regular tweets by (accountId, same-second createdAt).
// We build a bucket keyed by `${accountId}:${secondEpoch}` → tweets[], and
// for each note find the best-matching tweet in the bucket.
export function joinNoteTweets(tweets, notes) {
  const bucket = new Map();
  for (const tw of tweets) {
    const key = `${tw.accountId}:${Math.floor(tw.createdAtEpoch / 1000)}`;
    let arr = bucket.get(key);
    if (!arr) { arr = []; bucket.set(key, arr); }
    arr.push(tw);
  }

  let joined = 0;
  let orphans = 0;
  for (const note of notes) {
    // Try same second, then +/- 1s (clock skew).
    const s = Math.floor(note.createdAtEpoch / 1000);
    let candidates = null;
    for (const off of [0, -1, 1, -2, 2]) {
      const key = `${note.__accountId}:${s + off}`;
      const arr = bucket.get(key);
      if (arr && arr.length) { candidates = arr; break; }
    }
    if (!candidates) { orphans++; continue; }

    // Prefer tweets whose text is a prefix of the note text (accounting for trailing "… https://t.co/xxx").
    let best = null;
    let bestScore = -1;
    for (const tw of candidates) {
      if (tw.noteText) continue;
      const stripped = tw.text.replace(/\s*…?\s*https:\/\/t\.co\/\S+\s*$/, '');
      const head = stripped.length > 20 ? stripped.slice(0, Math.min(60, stripped.length - 5)) : stripped;
      const score = note.text.startsWith(head) ? head.length : 0;
      if (score > bestScore) { best = tw; bestScore = score; }
    }
    if (!best) best = candidates.find(t => !t.noteText) || candidates[0];
    best.noteText = note.text;
    joined++;
  }
  return { joined, orphans };
}
