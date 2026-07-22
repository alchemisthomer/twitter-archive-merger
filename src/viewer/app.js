// twitter-archive-merger — viewer
//
// State model:
//   index         — /data/index.json (accounts, months, per-account per-month counts)
//   orderedKeys   — index.months keys sorted per current display order
//   loaded        — Map<monthKey, tweets[]>
//   windowStart   — first orderedKeys index currently mounted
//   windowEnd     — last  orderedKeys index currently mounted (inclusive)
//   filters       — { accounts: Set<handle>, search: string, hideRetweets, hideReplies }
//   order         — 'desc' | 'asc'

const state = {
  index: null,
  order: 'desc',
  orderedKeys: [],
  loaded: new Map(),
  windowStart: -1,
  windowEnd: -1,
  filters: {
    accounts: new Set(),
    search: '',
    hideRetweets: false,
    hideReplies: false,
  },
  fetchInFlight: new Set(),
};

const el = {
  sidebar: document.getElementById('sidebar'),
  meta: document.getElementById('meta'),
  accounts: document.getElementById('accounts'),
  search: document.getElementById('search'),
  hideRetweets: document.getElementById('hide-retweets'),
  hideReplies: document.getElementById('hide-replies'),
  years: document.getElementById('years'),
  tweets: document.getElementById('tweets'),
  loading: document.getElementById('loading'),
  empty: document.getElementById('empty'),
  counts: document.getElementById('counts'),
  sentinelTop: document.getElementById('sentinel-top'),
  sentinelBottom: document.getElementById('sentinel-bottom'),
};

async function boot() {
  const r = await fetch('/data/index.json');
  if (!r.ok) {
    el.tweets.innerHTML = `<p style="padding:40px;color:var(--muted)">No /data/index.json found. Run <code>npm run build</code> first.</p>`;
    return;
  }
  state.index = await r.json();
  for (const a of state.index.accounts) state.filters.accounts.add(a.handle);
  computeOrderedKeys();
  renderSidebar();
  setupObservers();
  wireControls();
  await loadInitial();
}

function computeOrderedKeys() {
  const asc = state.index.months.map(m => m.key).sort();
  state.orderedKeys = state.order === 'desc' ? asc.reverse() : asc;
}

function renderSidebar() {
  const { totals, dateRange } = { totals: state.index.totals, dateRange: state.index.totals.dateRange };
  el.meta.textContent = `${totals.tweets.toLocaleString()} tweets · ${totals.accounts} accounts · ${dateRange?.first?.slice(0,10)} → ${dateRange?.last?.slice(0,10)}`;

  el.accounts.innerHTML = '';
  for (const a of state.index.accounts) {
    const row = document.createElement('label');
    row.className = 'account';
    row.innerHTML = `
      <input type="checkbox" data-handle="${escapeAttr(a.handle)}" checked />
      ${a.avatarLocal
        ? `<img src="/data/${escapeAttr(a.avatarLocal)}" alt="" />`
        : `<span class="placeholder">${escapeHtml((a.handle || '?')[0].toUpperCase())}</span>`}
      <span class="who">
        <span class="name">${escapeHtml(a.displayName || a.handle)}</span>
        <span class="handle">@${escapeHtml(a.handle)}</span>
      </span>
      <span class="count">${a.tweetCount.toLocaleString()}</span>
    `;
    row.querySelector('input').addEventListener('change', (e) => {
      const h = e.target.dataset.handle;
      if (e.target.checked) state.filters.accounts.add(h);
      else state.filters.accounts.delete(h);
      rerender();
    });
    el.accounts.appendChild(row);
  }

  const years = [...new Set(state.orderedKeys.map(k => k.slice(0, 4)))];
  el.years.innerHTML = '';
  for (const y of years) {
    const btn = document.createElement('button');
    btn.textContent = y;
    btn.dataset.year = y;
    btn.addEventListener('click', () => jumpToYear(y));
    el.years.appendChild(btn);
  }
}

function wireControls() {
  el.search.addEventListener('input', (e) => {
    state.filters.search = e.target.value.trim().toLowerCase();
    rerender();
  });
  el.hideRetweets.addEventListener('change', (e) => {
    state.filters.hideRetweets = e.target.checked;
    rerender();
  });
  el.hideReplies.addEventListener('change', (e) => {
    state.filters.hideReplies = e.target.checked;
    rerender();
  });
  for (const r of document.querySelectorAll('input[name="order"]')) {
    r.addEventListener('change', (e) => {
      if (!e.target.checked) return;
      state.order = e.target.value;
      computeOrderedKeys();
      resetWindow();
      loadInitial();
    });
  }
}

async function loadInitial() {
  if (!state.orderedKeys.length) {
    el.empty.hidden = false;
    return;
  }
  state.windowStart = 0;
  state.windowEnd = -1;
  renderProfileHero();
  await fillViewport('down');
  updateGlobalEmptyState();
}

// Keep extending in the given direction until the viewport contains real content
// or we exhaust available months. Guards against infinite loops.
async function fillViewport(direction) {
  const extend = direction === 'up' ? extendUp : extendDown;
  const sentinel = direction === 'up' ? el.sentinelTop : el.sentinelBottom;
  let safety = 200;
  while (safety-- > 0) {
    // Stop if the container has enough real content past the current viewport.
    const contentHeight = el.tweets.getBoundingClientRect().height;
    if (contentHeight >= window.innerHeight * 1.5) return;
    const extended = await extend();
    if (!extended) return;
  }
}

function updateGlobalEmptyState() {
  const hasAnyTweet = el.tweets.querySelector('article.tweet') !== null;
  el.empty.hidden = hasAnyTweet;
}

function resetWindow() {
  state.loaded.clear();
  state.windowStart = -1;
  state.windowEnd = -1;
  el.tweets.innerHTML = '';
}

async function jumpToYear(year) {
  const idx = state.orderedKeys.findIndex(k => k.startsWith(year));
  if (idx === -1) return;
  resetWindow();
  state.windowStart = idx;
  state.windowEnd = idx - 1;
  renderProfileHero();
  await fillViewport('down');
  updateGlobalEmptyState();
  for (const b of el.years.querySelectorAll('button')) b.classList.toggle('active', b.dataset.year === year);
  window.scrollTo({ top: 0, behavior: 'instant' });
}

// Fetch a single month by key (memoized).
async function fetchMonth(key) {
  if (state.loaded.has(key)) return state.loaded.get(key);
  if (state.fetchInFlight.has(key)) {
    while (state.fetchInFlight.has(key)) await new Promise(r => setTimeout(r, 30));
    return state.loaded.get(key);
  }
  state.fetchInFlight.add(key);
  try {
    const r = await fetch(`/data/months/${key}.json`);
    if (!r.ok) throw new Error(`fetch ${key}: ${r.status}`);
    const arr = await r.json();
    state.loaded.set(key, arr);
    return arr;
  } finally {
    state.fetchInFlight.delete(key);
  }
}

// Extend the mounted window by one month (later in display order).
async function extendDown() {
  if (state.windowEnd >= state.orderedKeys.length - 1) return false;
  el.loading.hidden = false;
  const nextIdx = state.windowEnd + 1;
  const key = state.orderedKeys[nextIdx];
  const arr = await fetchMonth(key);
  state.windowEnd = nextIdx;
  appendMonth(key, arr);
  el.loading.hidden = true;
  updateCounts();
  return true;
}

async function extendUp() {
  if (state.windowStart <= 0) return false;
  el.loading.hidden = false;
  const prevIdx = state.windowStart - 1;
  const key = state.orderedKeys[prevIdx];
  const arr = await fetchMonth(key);
  state.windowStart = prevIdx;
  prependMonth(key, arr);
  el.loading.hidden = true;
  updateCounts();
  return true;
}

function appendMonth(key, arr) {
  const frag = renderMonth(key, arr);
  el.tweets.appendChild(frag);
}

function prependMonth(key, arr) {
  const frag = renderMonth(key, arr);
  const prevHeight = document.documentElement.scrollHeight;
  const hero = document.getElementById('profile-hero');
  const anchor = hero ? hero.nextSibling : el.tweets.firstChild;
  el.tweets.insertBefore(frag, anchor);
  const newHeight = document.documentElement.scrollHeight;
  window.scrollBy({ top: newHeight - prevHeight, behavior: 'instant' });
}

async function rerender() {
  const start = state.windowStart, end = state.windowEnd;
  el.tweets.innerHTML = '';
  renderProfileHero();
  for (let i = start; i <= end; i++) {
    const key = state.orderedKeys[i];
    const arr = state.loaded.get(key);
    if (arr) appendMonth(key, arr);
  }
  await fillViewport('down');
  updateGlobalEmptyState();
  updateCounts();
}

function renderMonth(key, arr) {
  // Filter first — if zero tweets pass, don't emit the month header at all.
  const ordered = state.order === 'desc' ? [...arr].reverse() : arr;
  const kept = ordered.filter(passesFilter);
  if (kept.length === 0) return document.createDocumentFragment();

  const frag = document.createDocumentFragment();
  const [y, m] = key.split('-');
  const monthName = new Date(Date.UTC(Number(y), Number(m) - 1, 1))
    .toLocaleString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });

  const header = document.createElement('div');
  header.className = 'month-header';
  header.dataset.month = key;
  header.textContent = monthName;
  frag.appendChild(header);

  for (const tw of kept) frag.appendChild(renderTweet(tw));
  return frag;
}

function renderProfileHero() {
  const existing = document.getElementById('profile-hero');
  if (existing) existing.remove();
  if (state.filters.accounts.size !== 1) return;
  const handle = [...state.filters.accounts][0];
  const a = state.index.accounts.find(x => x.handle === handle);
  if (!a) return;

  const joined = a.createdAt ? new Date(a.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long' }) : null;
  const archived = a.archiveGeneratedAt ? new Date(a.archiveGeneratedAt).toLocaleDateString() : null;

  const hero = document.createElement('section');
  hero.id = 'profile-hero';
  hero.className = 'profile-hero';
  const bannerBg = a.headerLocal
    ? `background-image:url('/data/${escapeAttr(a.headerLocal)}')`
    : a.headerRemote
      ? `background-image:url('${escapeAttr(a.headerRemote)}')`
      : '';
  hero.innerHTML = `
    <div class="banner" style="${bannerBg}"></div>
    <div class="body">
      <div class="avatar">${a.avatarLocal
        ? `<img src="/data/${escapeAttr(a.avatarLocal)}" alt="" />`
        : `<span class="placeholder">${escapeHtml((handle || '?')[0].toUpperCase())}</span>`}</div>
      <div class="who">
        <div class="name">${escapeHtml(a.displayName || handle)}</div>
        <div class="handle">@${escapeHtml(handle)}</div>
      </div>
      ${a.bio ? `<div class="bio">${escapeHtml(a.bio)}</div>` : ''}
      <div class="stats">
        ${a.location ? `<span>📍 ${escapeHtml(a.location)}</span>` : ''}
        ${joined ? `<span>📅 joined ${joined}</span>` : ''}
        <span>${a.tweetCount.toLocaleString()} tweets</span>
        ${a.noteCount ? `<span>${a.noteCount.toLocaleString()} long-form</span>` : ''}
        ${archived ? `<span>🗄 archive ${archived}</span>` : ''}
      </div>
    </div>
  `;
  // Insert at the top of the tweets container.
  el.tweets.insertBefore(hero, el.tweets.firstChild);
}

function passesFilter(tw) {
  if (!state.filters.accounts.has(tw.account)) return false;
  if (state.filters.hideRetweets && tw.isRetweet) return false;
  if (state.filters.hideReplies && tw.inReplyToTweetId) return false;
  if (state.filters.search) {
    const q = state.filters.search;
    const hay = (tw.text + ' ' + (tw.noteText || '')).toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function renderTweet(tw) {
  const account = state.index.accounts.find(a => a.handle === tw.account);
  const div = document.createElement('article');
  div.className = 'tweet';
  const date = new Date(tw.createdAtEpoch);
  const when = date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const openUrl = `https://x.com/${encodeURIComponent(tw.account)}/status/${tw.id}`;

  const avatar = account?.avatarLocal
    ? `<img src="/data/${escapeAttr(account.avatarLocal)}" alt="" />`
    : `<div class="placeholder">${escapeHtml((tw.account || '?')[0].toUpperCase())}</div>`;

  const badges = [];
  if (tw.isRetweet) badges.push(`<span class="badge rt">RT @${escapeHtml(tw.retweetOf)}</span>`);
  if (tw.inReplyToScreenName) badges.push(`<span class="badge reply">↩ @${escapeHtml(tw.inReplyToScreenName)}</span>`);
  if (tw.noteText) badges.push(`<span class="badge note">long-form</span>`);
  if (tw.lang && tw.lang !== 'en' && tw.lang !== 'zxx') badges.push(`<span class="badge">${escapeHtml(tw.lang)}</span>`);

  div.innerHTML = `
    <div class="head">
      <div class="avatar">${avatar}</div>
      <div class="who">
        <span class="name">${escapeHtml(account?.displayName || tw.account)}</span>
        <span class="handle">@${escapeHtml(tw.account)}</span>
      </div>
      <div class="when"><a href="${escapeAttr(openUrl)}" target="_blank" rel="noreferrer noopener" title="open on x.com">${escapeHtml(when)}</a></div>
    </div>
    <div class="body">${linkify(tw.text, tw, state.filters.search)}</div>
    ${tw.noteText ? `<div class="note-expanded">${linkify(tw.noteText, tw, state.filters.search)}</div>` : ''}
    ${renderMedia(tw, account)}
    ${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}
    <div class="foot">
      ${tw.favoriteCount ? `♥ ${tw.favoriteCount}` : ''}
      ${tw.retweetCount ? `<span>↻ ${tw.retweetCount}</span>` : ''}
      ${tw.source ? `<span>via ${escapeHtml(tw.source)}</span>` : ''}
    </div>
  `;
  return div;
}

// Global error handler — pops next fallback URL from data-fallbacks.
window.__mediaFallback = function(imgEl) {
  const raw = imgEl.getAttribute('data-fallbacks') || '';
  const list = raw ? raw.split('\n').filter(Boolean) : [];
  if (list.length === 0) {
    const label = imgEl.tagName === 'VIDEO' ? 'video not in archive' : 'media not in archive';
    const div = document.createElement('div');
    div.className = 'missing';
    div.textContent = label;
    imgEl.replaceWith(div);
    return;
  }
  const next = list.shift();
  imgEl.setAttribute('data-fallbacks', list.join('\n'));
  imgEl.src = next;
};

// For an entry in tweet.media, produce a chain of local + remote candidate URLs
// keyed by a basename derived from `key` (e.g. the poster URL for images, the
// bestMp4 URL for videos). The tweetId (and sourceStatusId when retweeting) may
// be the file's prefix — try both.
function localCandidatesForBasename(tw, m, basenameKey) {
  const bn = basenameKey ? basenameKey.split('/').pop() : '';
  const ids = [tw.id, m.sourceStatusId].filter(Boolean);
  const folders = ['tweets_media', 'community_tweet_media'];
  const out = [];
  for (const id of ids) for (const folder of folders) {
    out.push(`/data/media/${tw.account}/data/${folder}/${id}-${bn}`);
  }
  return out;
}

function renderMedia(tw, account) {
  if (!tw.media || !tw.media.length) return '';
  const parts = tw.media.map(m => {
    // Poster (photo/thumbnail) chain — derived from m.url (photo or video-thumb).
    const posterChain = [...localCandidatesForBasename(tw, m, m.url), m.url].filter(Boolean);
    const posterPrimary = posterChain[0];
    const posterFbAttr = escapeAttr(posterChain.slice(1).join('\n'));

    if (m.type === 'video' || m.type === 'animated_gif') {
      // Video source chain — derived from m.bestMp4. Remote video URLs are
      // typically dead (require session), so local file is the only real bet.
      const videoChain = [...localCandidatesForBasename(tw, m, m.bestMp4), m.bestMp4].filter(Boolean);
      if (videoChain.length === 0) {
        // Video with no MP4 metadata at all — render poster only.
        return `<img loading="lazy" src="${escapeAttr(posterPrimary)}" data-fallbacks="${posterFbAttr}" onerror="window.__mediaFallback(this)" alt="" />`;
      }
      // Emit one <source> per candidate. Browsers try them in order, falling
      // through to the next when one fails to load. Autoplay off; user-triggered.
      const sources = videoChain
        .map(u => `<source src="${escapeAttr(u)}" type="video/mp4" />`)
        .join('');
      return `<video controls playsinline preload="metadata" poster="${escapeAttr(posterPrimary)}">${sources}</video>`;
    }

    return `<img loading="lazy" src="${escapeAttr(posterPrimary)}" data-fallbacks="${posterFbAttr}" onerror="window.__mediaFallback(this)" alt="" />`;
  });
  return `<div class="media">${parts.join('')}</div>`;
}

// Convert URLs, @mentions, #hashtags to clickable links + apply search highlight.
function linkify(text, tw, query) {
  // Replace t.co links with expanded_url text.
  let out = text;
  if (tw.urls && tw.urls.length) {
    for (const u of tw.urls) {
      const label = u.display || u.expanded || u.tco;
      out = out.split(u.tco).join(`URL${u.expanded || u.tco}${label}`);
    }
  }
  // Escape HTML.
  out = escapeHtml(out);
  // Turn our sentinels into <a>.
  out = out.replace(/URL([^]+)([^]+)/g,
    (_, href, label) => `<a href="${href}" target="_blank" rel="noreferrer noopener">${label}</a>`);
  // @mentions
  out = out.replace(/(^|[^A-Za-z0-9_])@([A-Za-z0-9_]{1,15})/g,
    (_, pre, h) => `${pre}<a href="https://x.com/${encodeURIComponent(h)}" target="_blank" rel="noreferrer noopener">@${h}</a>`);
  // #hashtags
  out = out.replace(/(^|[^A-Za-z0-9_])#([A-Za-z0-9_]+)/g,
    (_, pre, h) => `${pre}<a href="https://x.com/hashtag/${encodeURIComponent(h)}" target="_blank" rel="noreferrer noopener">#${h}</a>`);
  // Autolink bare URLs — only in text nodes, never inside existing tags/anchors.
  out = out.split(/(<[^>]+>)/g).map(part => {
    if (part.startsWith('<')) return part;
    return part.replace(/(https?:\/\/[^\s<"']+)/g,
      (u) => `<a href="${u}" target="_blank" rel="noreferrer noopener">${u}</a>`);
  }).join('');
  // Search highlight
  if (query) {
    const re = new RegExp(`(${escapeRegex(query)})`, 'gi');
    // Highlight only in text nodes (not inside tags). Do a naive split-and-splice.
    out = highlightOutsideTags(out, re);
  }
  return out;
}

function highlightOutsideTags(html, re) {
  const parts = html.split(/(<[^>]+>)/g);
  return parts.map(p => (p.startsWith('<') ? p : p.replace(re, '<mark>$1</mark>'))).join('');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function updateCounts() {
  const loaded = state.windowEnd - state.windowStart + 1;
  const total = state.orderedKeys.length;
  el.counts.textContent = `showing months ${loaded}/${total} · built ${state.index.builtAt?.slice(0,10)}`;
}

function setupObservers() {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      if (e.target.id === 'sentinel-bottom') extendDown();
      if (e.target.id === 'sentinel-top') extendUp();
    }
  }, { rootMargin: '400px' });
  io.observe(el.sentinelBottom);
  io.observe(el.sentinelTop);
}

boot().catch(err => {
  console.error(err);
  el.tweets.innerHTML = `<p style="padding:40px;color:tomato">boot error: ${escapeHtml(err.message)}</p>`;
});
