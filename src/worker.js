/**
 * Stremio addon running on Cloudflare Workers.
 *
 * Two playlists, both shown in Stremio as a series. Every video is an episode and every stream
 * carries the same bingeGroup, so Stremio plays the next video when one ends and keeps your
 * progress in Continue Watching.
 *
 *   /addon/<config>/manifest.json          An M3U playlist or a single video link.
 *                                          <config> is the URL-encoded JSON {"url": "..."}.
 *   /torbox/<ADDON_SECRET>/manifest.json   The videos from PLAYLIST_URL first, then your airlocked
 *                                          TorBox downloads (torrents and web downloads), oldest
 *                                          first. TorBox download links are requested when you
 *                                          press play.
 *
 * Secrets (Worker > Settings > Variables and Secrets, type "Secret"):
 *   TORBOX_API_KEY  TorBox API key. Only ever sent to the TorBox API.
 *   ADDON_SECRET    Long random password (16+ characters) that protects the TorBox routes.
 * Variables (wrangler.jsonc "vars"):
 *   PLAYLIST_URL    Optional M3U playlist whose videos play before the TorBox ones. A line
 *                   "#TORBOX:<words from a download name>" moves that download to that spot.
 * TORBOX_API_BASE can override the TorBox API URL for local testing.
 */

const TORBOX_API = 'https://api.torbox.app/v1/api';
const TORBOX_PAGE_SIZE = 1000;
// TorBox keeps torrents and web downloads (direct links, file hosters) in separate lists, each with its
// own download-link endpoint. Torrent ids and play links keep their original format, so Continue
// Watching progress saved before web downloads were added still applies.
const TORBOX_KINDS = {
  torrent: { list: '/torrents/mylist', link: '/torrents/requestdl', idParam: 'torrent_id', idPart: '', playPart: '', one: 'torrent', many: 'torrents' },
  web: { list: '/webdl/mylist', link: '/webdl/requestdl', idParam: 'web_id', idPart: 'web:', playPart: 'web/', one: 'web download', many: 'web downloads' },
};
const M3U_PREFIX = 'm3upl:';
const M3U_CATALOG = 'm3u-playlist';
const TORBOX_PREFIX = 'tbpl:';
const TORBOX_META_ID = `${TORBOX_PREFIX}library`;
const TORBOX_CATALOG = 'torbox-playlist';
const TORBOX_NAME = 'TorBox Playlist';
const PLAYLIST_TTL_MS = 5 * 60 * 1000;
// TorBox keeps a generated link open for a few hours; reuse it for a while to save API calls.
const LINK_TTL_MS = 30 * 60 * 1000;
const MAX_PLAYLIST_BYTES = 5 * 1024 * 1024;
const MIN_SECRET_LENGTH = 16;
const VIDEO_FILE = /\.(mp4|m4v|mkv|avi|mov|webm|wmv|flv|ts|m2ts|mpe?g)$/i;
// TorBox download links (e.g. store-1.weur.tb-cdn.st) expire after a few hours.
const TORBOX_CDN_HOST = /(^|\.)(tb-cdn\.[a-z]+|torbox\.app)$/i;
const WEB_READY_FILE = /\.(mp4|m4v|webm)$/i;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};
const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy':
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      return await route(request, env, url);
    } catch (error) {
      console.error(`${request.method} ${redact(url.pathname)} failed: ${error && error.message}`);
      return json({ err: 'server error' }, 500);
    }
  },
};

async function route(request, env, url) {
  const { pathname, origin } = url;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method === 'POST') {
    if (pathname === '/validate') return validateM3u(request, env, origin);
    if (pathname === '/torbox') return torboxLinkPage(request, env, origin);
    return notFound();
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return notFound();

  if (pathname === '/') return htmlResponse(homePage(env));
  if (pathname === '/dashboard') return dashboard(url);
  // Stremio's "Configure" button opens <addon>/configure; the form lives on the home page.
  if (pathname === '/addon/configure' || pathname === '/configure') return Response.redirect(`${origin}/`, 302);
  if (pathname === '/addon/manifest.json') return json(m3uManifest(origin, false));

  let match = pathname.match(/^\/addon\/(.+)\/manifest\.json$/);
  if (match) {
    return playlistUrlFromConfig(match[1]) ? json(m3uManifest(origin, true)) : json({ err: 'bad config' }, 400);
  }
  match = pathname.match(/^\/addon\/(.+?)\/(catalog|meta|stream)\/([^/]+)\/([^/]+?)(?:\/[^/]+)?\.json$/);
  if (match) return m3uResource(origin, match[1], match[2], match[4]);
  match = pathname.match(/^\/torbox\/([^/]+)(\/.*)$/);
  if (match) return torboxRoute(request, env, origin, match[1], match[2]);
  return notFound();
}

// ---------------------------------------------------------------------------------------------
// M3U playlist addon
// ---------------------------------------------------------------------------------------------

function m3uManifest(origin, configured) {
  return {
    id: 'org.sidh.m3uaddon',
    version: '2.0.0',
    name: 'M3U & Direct Video Addon',
    description: 'Plays an M3U playlist as a series: videos play one after another and Stremio keeps your progress',
    resources: ['catalog', 'meta', 'stream'],
    types: ['series'],
    idPrefixes: [M3U_PREFIX],
    catalogs: [{ type: 'series', id: M3U_CATALOG, name: 'M3U Playlist' }],
    // Without a playlist in the link, Stremio shows "Configure", which leads to the home page.
    behaviorHints: configured ? {} : { configurable: true, configurationRequired: true },
    background: `${origin}/poster.svg`,
  };
}

async function m3uResource(origin, configSegment, resource, rawId) {
  const playlistUrl = playlistUrlFromConfig(configSegment);
  const id = safeDecode(rawId);
  if (!playlistUrl || id === null) return json({ err: 'bad request' }, 400);
  console.log(`M3U ${resource} ${id}`);
  const metaId = await m3uPlaylistId(playlistUrl);

  if (resource === 'catalog') {
    if (id !== M3U_CATALOG) return json({ metas: [] });
    try {
      const playlist = await loadPlaylist(playlistUrl);
      return json({ metas: [preview(origin, metaId, playlist.name, playlist.items.length)] });
    } catch (error) {
      console.error(`M3U catalog: ${error.message}`);
      return json({ metas: [] });
    }
  }
  if (resource === 'meta') {
    if (id !== metaId) return json({ err: 'not found' }, 404);
    const playlist = await loadPlaylist(playlistUrl);
    const videos = playlist.items.map((item, i) => episode(`${metaId}:1:${i + 1}`, item.title, i, item.logo));
    return json({ meta: { ...preview(origin, metaId, playlist.name, videos.length), videos } });
  }
  const match = id.match(/^(.+):1:(\d+)$/);
  if (!match || match[1] !== metaId) return json({ streams: [] });
  const playlist = await loadPlaylist(playlistUrl);
  const item = playlist.items[Number(match[2]) - 1];
  if (!item) return json({ streams: [] });
  // Plain-http links have to go through Stremio's streaming server.
  return json({ streams: [stream(item.url, 'M3U', item.title, metaId, !item.url.startsWith('http:'))] });
}

// <config> is the URL-encoded JSON {"url": "<playlist url>"}, the same format the Stremio SDK uses.
function playlistUrlFromConfig(segment) {
  try {
    const { url } = JSON.parse(decodeURIComponent(segment));
    return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
  } catch {
    return null;
  }
}

// Stable id per playlist URL, so Stremio's progress survives redeploys.
async function m3uPlaylistId(url) {
  return M3U_PREFIX + (await sha1Hex(url)).slice(0, 12);
}

async function sha1Hex(text) {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Download and parse a playlist. A single video link (MP4, HLS .m3u8, ...) becomes a one-video playlist.
function loadPlaylist(url) {
  return cached(`m3u:${url}`, PLAYLIST_TTL_MS, async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      await discard(response);
      throw new Error(`HTTP ${response.status}`);
    }
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const length = Number(response.headers.get('content-length')) || 0;
    const single = { kind: 'direct', name: nameFromUrl(url), items: [{ title: nameFromUrl(url), url }] };
    if (contentType.startsWith('video/') || length > MAX_PLAYLIST_BYTES) {
      // A video file, not a playlist: keep the link and don't download the video.
      await discard(response);
      return single;
    }
    const text = await readText(response, MAX_PLAYLIST_BYTES);
    // HLS (.m3u8) describes one stream, not a list of videos.
    if (/^#EXT-X-(TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE)/m.test(text)) return single;
    const parsed = parseM3U(text, url);
    if (!parsed.entries.length) throw new Error('No video links found');
    console.log(`Loaded ${parsed.items.length} videos from ${url}`);
    return { kind: 'm3u', name: parsed.name || 'M3U Playlist', items: parsed.items, entries: parsed.entries };
  });
}

// Parse an M3U playlist: each video is an optional "#EXTINF:<duration> <key="value">...,<title>"
// line followed by the video URL. Relative URLs are resolved against the playlist URL.
// `items` has the videos; `entries` also keeps the "#TORBOX:<words>" lines in their place. Only the
// TorBox playlist uses those lines (see torboxLibrary); other players skip them like any comment.
function parseM3U(text, playlistUrl) {
  const items = [];
  const entries = [];
  let name = null;
  let info = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#PLAYLIST:')) {
      name = line.slice('#PLAYLIST:'.length).trim() || null;
    } else if (/^#TORBOX:/i.test(line)) {
      const words = line.slice('#TORBOX:'.length).trim();
      if (words) entries.push({ torbox: words });
      // The line stands in for a video, so an #EXTINF title right above it doesn't move to the next link.
      info = null;
    } else if (line.startsWith('#EXTINF')) {
      // Skip the duration ("-1") and attributes; the title is what follows the comma.
      const match = line.match(/^#EXTINF:\s*-?[\d.]*((?:\s+[\w-]+="[^"]*")*)\s*,(.*)$/);
      const title = match ? match[2] : line.includes(',') ? line.slice(line.lastIndexOf(',') + 1) : '';
      const logo = match && match[1].match(/tvg-logo="([^"]+)"/);
      info = { title: title.trim(), logo: logo ? logo[1] : undefined };
    } else if (!line.startsWith('#')) {
      // Relative links are only accepted right after an #EXTINF line, so stray text is ignored.
      let url = null;
      try {
        url = new URL(line, info ? playlistUrl : undefined);
      } catch {
        // not a URL
      }
      if (url && (url.protocol === 'https:' || url.protocol === 'http:')) {
        const item = { title: (info && info.title) || nameFromUrl(url.href), url: url.href, logo: info && info.logo };
        items.push(item);
        entries.push(item);
      }
      info = null;
    }
  }
  return { name, items, entries };
}

// ---------------------------------------------------------------------------------------------
// TorBox addon
// ---------------------------------------------------------------------------------------------

function torboxManifest(origin) {
  return {
    id: 'org.sidh.m3uaddon.torbox',
    version: '1.1.0',
    name: TORBOX_NAME,
    description: 'Your playlist links, then your airlocked TorBox torrents and web downloads in the order you added them (a #TORBOX line in the playlist can move one). Videos play one after another and Stremio keeps your progress',
    resources: ['catalog', 'meta', 'stream'],
    types: ['series'],
    idPrefixes: [TORBOX_PREFIX],
    catalogs: [{ type: 'series', id: TORBOX_CATALOG, name: TORBOX_NAME }],
    background: `${origin}/poster.svg`,
  };
}

function torboxEnabled(env) {
  return Boolean(env.TORBOX_API_KEY) && typeof env.ADDON_SECRET === 'string' && env.ADDON_SECRET.length >= MIN_SECRET_LENGTH;
}

async function torboxRoute(request, env, origin, secretSegment, rest) {
  const secret = safeDecode(secretSegment);
  // Wrong or missing secret looks exactly like a page that doesn't exist.
  if (secret === null || !torboxEnabled(env) || !(await sameSecret(secret, env.ADDON_SECRET))) {
    return json({ err: 'not found' }, 404);
  }
  if (rest === '/manifest.json') return json(torboxManifest(origin));

  // /play/<torrent id>/<file id> or /play/web/<web download id>/<file id>
  let match = rest.match(/^\/play\/(?:(web)\/)?(\d+)\/(\d+)$/);
  if (match) return torboxPlay(request, env, match[1] || 'torrent', match[2], match[3]);

  match = rest.match(/^\/(catalog|meta|stream)\/([^/]+)\/([^/]+?)(?:\/[^/]+)?\.json$/);
  const id = match && safeDecode(match[3]);
  if (!match || id === null) return json({ err: 'not found' }, 404);
  const resource = match[1];
  console.log(`TorBox ${resource} ${id}`);

  if (resource === 'catalog') {
    if (id !== TORBOX_CATALOG) return json({ metas: [] });
    try {
      const { items } = await torboxLibrary(env);
      return json({ metas: items.length ? [preview(origin, TORBOX_META_ID, TORBOX_NAME, items.length)] : [] });
    } catch (error) {
      console.error(`TorBox catalog: ${error.message}`);
      return json({ metas: [] });
    }
  }
  if (resource === 'meta') {
    if (id !== TORBOX_META_ID) return json({ err: 'not found' }, 404);
    const { items } = await torboxLibrary(env);
    const videos = items.map((item, i) => episode(item.id, item.title, i));
    return json({ meta: { ...preview(origin, TORBOX_META_ID, TORBOX_NAME, videos.length), videos } });
  }
  const item = (await torboxLibrary(env)).items.find((entry) => entry.id === id);
  if (!item) return json({ streams: [] });
  // Links from PLAYLIST_URL (e.g. Dropbox) don't expire, so Stremio gets them as they are.
  if (item.url) return json({ streams: [stream(item.url, item.source, item.title, TORBOX_META_ID, item.webReady)] });
  // TorBox streams point back to this Worker, which asks TorBox for a fresh link at play time. That keeps
  // Continue Watching working long after a saved TorBox link would have expired.
  const playUrl = `${origin}/torbox/${encodeURIComponent(secret)}/play/${item.play}`;
  return json({ streams: [stream(playUrl, 'TorBox', item.title, TORBOX_META_ID, item.webReady)] });
}

// Redirect the player to a fresh TorBox download link. `kind` is a key of TORBOX_KINDS.
async function torboxPlay(request, env, kind, downloadId, fileId) {
  const { link: endpoint, idParam } = TORBOX_KINDS[kind];
  console.log(`TorBox play ${kind} ${downloadId}/${fileId}`);
  const link = await cached(`torbox-link:${kind}:${downloadId}:${fileId}`, LINK_TTL_MS, async () => {
    const params = new URLSearchParams({
      token: env.TORBOX_API_KEY,
      [idParam]: downloadId,
      file_id: fileId,
      zip_link: 'false',
      redirect: 'false',
    });
    // Lets TorBox pick the CDN server closest to the viewer.
    const ip = request.headers.get('CF-Connecting-IP');
    if (ip) params.set('user_ip', ip);
    const data = await torboxApi(env, `${endpoint}?${params}`);
    if (typeof data !== 'string' || !/^https?:\/\//.test(data)) throw new Error('TorBox did not return a download link');
    return data;
  });
  return new Response(null, { status: 302, headers: { Location: link, 'Cache-Control': 'no-store', ...CORS } });
}

// The TorBox playlist: videos from PLAYLIST_URL first (e.g. the Dropbox links in a gist), then the
// airlocked TorBox torrents and web downloads together, oldest first (the order you added them).
// A "#TORBOX:<words>" line in PLAYLIST_URL plays the downloads whose name (or video title) has those
// words at that spot instead, oldest first if several match. As the last line of the playlist it
// puts them right after the playlist videos.
// Every part is cached on its own, so a list that fails to load is retried on the next request.
async function torboxLibrary(env) {
  let webError = '';
  const [extra, torrents, web] = await Promise.all([
    extraPlaylist(env),
    torboxDownloads(env, 'torrent'),
    // Web downloads are extra: if TorBox won't list them, the torrents still play.
    torboxDownloads(env, 'web').catch((error) => {
      console.error(`TorBox web downloads: ${error.message}`);
      webError = error.message;
      return [];
    }),
  ]);
  const torbox = buildTorboxPlaylist({ torrent: torrents, web });
  const items = [];
  const placed = new Set();
  const unmatched = [];
  for (const entry of extra.entries) {
    if (!entry.torbox) {
      items.push(entry);
      continue;
    }
    const words = matchText(entry.torbox);
    const hits = words ? torbox.groups.filter((group) => group.names.some((name) => name.includes(words))) : [];
    if (!hits.length) unmatched.push(entry.torbox);
    for (const group of hits) {
      // A download plays only once: the first line that matches it wins.
      if (placed.has(group)) continue;
      placed.add(group);
      items.push(...group.items);
    }
  }
  for (const group of torbox.groups) if (!placed.has(group)) items.push(...group.items);
  return {
    items,
    extraCount: extra.entries.filter((entry) => !entry.torbox).length,
    extraError: extra.error,
    webError,
    placedCount: placed.size,
    unmatched,
    kinds: torbox.kinds,
  };
}

// Whole words, lowercase and without accents, with a space on each side: "Dune.Part.Two" matches
// "dune part two", and "Dune" doesn't match "Dunes".
function matchText(text) {
  const words = String(text).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ');
  return words ? ` ${words} ` : '';
}

// Every download of one kind (a key of TORBOX_KINDS) on the TorBox account.
function torboxDownloads(env, kind) {
  const { list: endpoint, many } = TORBOX_KINDS[kind];
  return cached(`torbox-${kind}`, PLAYLIST_TTL_MS, async () => {
    const downloads = new Map();
    // mylist is paginated. Stop at a page that isn't full or adds nothing new (20 pages at most).
    for (let page = 0; page < 20; page += 1) {
      const data = await torboxApi(env, `${endpoint}?offset=${page * TORBOX_PAGE_SIZE}&limit=${TORBOX_PAGE_SIZE}`);
      const list = Array.isArray(data) ? data : [];
      const before = downloads.size;
      for (const download of list) if (download && download.id != null) downloads.set(download.id, download);
      if (list.length < TORBOX_PAGE_SIZE || downloads.size === before) break;
    }
    console.log(`TorBox: ${downloads.size} ${many}`);
    return [...downloads.values()];
  });
}

// Videos from PLAYLIST_URL, in playlist order, with its "#TORBOX:" lines kept in place. TorBox CDN
// links are skipped: they expire, and the airlocked downloads below provide fresh ones.
async function extraPlaylist(env) {
  const playlistUrl = String(env.PLAYLIST_URL || '').trim();
  if (!playlistUrl) return { entries: [] };
  if (!/^https?:\/\//i.test(playlistUrl)) return { entries: [], error: 'PLAYLIST_URL must start with http:// or https://' };
  try {
    const playlist = await loadPlaylist(playlistUrl);
    const seen = new Set();
    const kept = (playlist.entries || playlist.items).filter((entry) => {
      if (entry.torbox) return true;
      if (seen.has(entry.url) || TORBOX_CDN_HOST.test(new URL(entry.url).hostname)) return false;
      seen.add(entry.url);
      return true;
    });
    const entries = await Promise.all(kept.map(async (entry) => (entry.torbox ? entry : {
      id: `${TORBOX_PREFIX}url:${(await sha1Hex(entry.url)).slice(0, 12)}`,
      url: entry.url,
      source: new URL(entry.url).hostname.replace(/^www\./, ''),
      title: entry.title,
      // Plain-http links have to go through Stremio's streaming server.
      webReady: !entry.url.startsWith('http:'),
    })));
    return { entries };
  } catch (error) {
    console.error(`PLAYLIST_URL: ${error.message}`);
    return { entries: [], error: `could not load PLAYLIST_URL (${error.message})` };
  }
}

// `lists` holds the TorBox lists by kind: { torrent: [...], web: [...] }.
function buildTorboxPlaylist(lists) {
  const kinds = {};
  const chosen = [];
  for (const [kind, list] of Object.entries(lists)) {
    // Only airlocked downloads. If TorBox doesn't report the flag for a kind at all, every download of
    // that kind is used and the install page says so.
    const airlockKnown = list.some((d) => typeof d.airlocked === 'boolean');
    const picked = airlockKnown ? list.filter((d) => d.airlocked === true) : list;
    kinds[kind] = { total: list.length, chosen: picked.length, airlockKnown };
    for (const download of picked) chosen.push({ kind, download });
  }
  // Downloads without a date go last. Ties are broken by kind, then by id (TorBox ids grow as you add
  // downloads).
  const addedAt = ({ download }) => {
    const time = Date.parse(download.created_at);
    return Number.isNaN(time) ? Infinity : time;
  };
  const kindOrder = Object.keys(lists);
  const ready = chosen
    // Skip downloads that are still downloading or whose files are gone.
    .filter(({ download: d }) => Array.isArray(d.files) && d.download_present !== false && d.download_finished !== false)
    .sort((a, b) => (addedAt(a) - addedAt(b)) || (kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind))
      || Number(a.download.id) - Number(b.download.id));
  // One group per download, so a "#TORBOX:" line can move all of a download's videos together.
  const groups = [];
  for (const { kind, download } of ready) {
    const { idPart, playPart } = TORBOX_KINDS[kind];
    const videos = download.files.filter((file) => file && file.id != null && isVideoFile(file, kind === 'web'));
    const withoutSamples = videos.filter((file) => !/\bsample\b/i.test(torboxFileName(file)));
    const files = (withoutSamples.length ? withoutSamples : videos).sort((a, b) =>
      torboxFileName(a).localeCompare(torboxFileName(b), undefined, { numeric: true, sensitivity: 'base' }));
    const items = files.map((file) => {
      const title = torboxFileName(file).replace(/\.\w{2,4}$/, '');
      return {
        id: `${TORBOX_PREFIX}${idPart}${download.id}:${file.id}`,
        play: `${playPart}${download.id}/${file.id}`,
        title: files.length > 1 ? `${download.name} - ${title}` : title,
        webReady: WEB_READY_FILE.test(torboxFileName(file)),
      };
    });
    // A "#TORBOX:" line can use words from the download name or from a title shown in Stremio.
    const names = [download.name || '', ...items.map((item) => item.title)].map(matchText);
    if (items.length) groups.push({ items, names });
  }
  return { groups, kinds };
}

function torboxFileName(file) {
  return String(file.short_name || String(file.name || '').split('/').pop() || '');
}

// A web download keeps the name of the file it came from, which may have no extension at all (some
// Dropbox links do). With `allowBareName`, such a file counts as a video unless TorBox knows its type.
function isVideoFile(file, allowBareName = false) {
  const mimetype = String(file.mimetype || '');
  if (mimetype.startsWith('video/') || VIDEO_FILE.test(torboxFileName(file))) return true;
  return allowBareName && !/\.[a-z0-9]{2,4}$/i.test(torboxFileName(file))
    && (!mimetype || mimetype === 'application/octet-stream');
}

async function torboxApi(env, path) {
  let response;
  try {
    response = await fetch(`${env.TORBOX_API_BASE || TORBOX_API}${path}`, {
      headers: { Authorization: `Bearer ${env.TORBOX_API_KEY}`, 'User-Agent': 'stremio-m3u-addon' },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    // The request URL can contain the API key, so the original error isn't passed along.
    throw new Error('TorBox: could not reach the API');
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.success === false) {
    throw new Error(`TorBox: ${(body && (body.detail || body.error)) || `HTTP ${response.status}`}`);
  }
  return body.data;
}

// Compare secrets in constant time (hashing first makes both sides the same length).
async function sameSecret(given, expected) {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all(
    [given, expected].map((value) => crypto.subtle.digest('SHA-256', encoder.encode(String(value)))),
  );
  return crypto.subtle.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------------------------
// Web pages
// ---------------------------------------------------------------------------------------------

const LOGO = `<img class="logo" src="/poster.svg" alt="" width="56" height="56">`;

function homePage(env, { m3uError = '', url = '', torboxError = '' } = {}) {
  const torbox = torboxEnabled(env)
    ? `<div class="divider"></div>
      <h3>TorBox Playlist</h3>
      ${torboxError ? `<p class="error">${escapeHtml(torboxError)}</p>` : ''}
      <form action="/torbox" method="POST">
        <input type="password" name="secret" placeholder="Your ADDON_SECRET" aria-label="Addon secret" autocomplete="current-password" required>
        <button type="submit">Get TorBox Install Link</button>
      </form>`
    : `<div class="divider"></div>
      <p class="note">TorBox playlist is off. Add the secrets TORBOX_API_KEY and ADDON_SECRET (at least ${MIN_SECRET_LENGTH} characters) to this Worker to enable it.</p>`;
  return renderPage('Stremio M3U & TorBox Addon', `
    ${LOGO}
    <h1>M3U & TorBox Addon</h1>
    <p class="subtitle">Paste an M3U playlist or direct video URL</p>
    <div class="card">
      ${m3uError ? `<p class="error">${escapeHtml(m3uError)}</p>` : ''}
      <form action="/validate" method="POST">
        <input type="url" name="url" placeholder="https://example.com/playlist.m3u" aria-label="Playlist or video URL" value="${escapeHtml(url)}" required>
        <button type="submit">Validate Link</button>
      </form>
      ${torbox}
    </div>`);
}

async function validateM3u(request, env, origin) {
  const form = await request.formData();
  const url = String(form.get('url') || '').trim();
  if (!url) return htmlResponse(homePage(env, { m3uError: 'URL is required' }), 400);
  if (!/^https?:\/\//i.test(url)) {
    return htmlResponse(homePage(env, { m3uError: 'Invalid link - the URL must start with http:// or https://', url }), 400);
  }
  let playlist;
  try {
    playlist = await loadPlaylist(url);
  } catch (error) {
    return htmlResponse(homePage(env, { m3uError: `Invalid link - ${error.message}`, url }), 400);
  }
  // The playlist URL goes inside the install link, so the addon needs no storage.
  const manifestUrl = `${origin}/addon/${encodeURIComponent(JSON.stringify({ url }))}/manifest.json`;
  const kind = playlist.kind === 'm3u' ? `M3U Playlist, ${playlist.items.length} videos` : 'Direct Video';
  return htmlResponse(installPage({
    summary: `Link is valid (${kind})!`,
    manifestUrl,
    playlistName: playlist.name,
    extra: `<p>URL: ${escapeHtml(url)}</p>
      <a href="/dashboard?url=${encodeURIComponent(url)}">View Dashboard</a>`,
  }));
}

async function torboxLinkPage(request, env, origin) {
  const noStore = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
  if (!torboxEnabled(env)) return htmlResponse(homePage(env), 404, noStore);
  const form = await request.formData();
  const secret = String(form.get('secret') || '');
  if (!(await sameSecret(secret, env.ADDON_SECRET))) {
    return htmlResponse(homePage(env, { torboxError: 'Wrong secret' }), 403, noStore);
  }
  let library;
  try {
    library = await torboxLibrary(env);
  } catch (error) {
    return htmlResponse(homePage(env, { torboxError: error.message }), 502, noStore);
  }
  const torboxVideos = library.items.length - library.extraCount;
  const kinds = Object.entries(library.kinds);
  // "5 airlocked torrents and 1 airlocked web download". Web downloads are only named when there are some.
  const sources = kinds
    .filter(([kind, info]) => kind === 'torrent' || info.chosen > 0)
    .map(([kind, info]) => `${info.chosen}${info.airlockKnown ? ' airlocked' : ''} `
      + (info.chosen === 1 ? TORBOX_KINDS[kind].one : TORBOX_KINDS[kind].many))
    .join(' and ');
  const summary = library.placedCount
    ? `TorBox connected: ${library.items.length} videos, ${library.extraCount} from your playlist and ${torboxVideos} from ${sources}. `
      + `The #TORBOX lines in your playlist place ${library.placedCount} of these downloads; the others play after the playlist, oldest first.`
    : `TorBox connected: ${library.items.length} videos. First ${library.extraCount} from your playlist, `
      + `then ${torboxVideos} from ${sources} (oldest first).`;
  const airlocked = kinds.some(([, info]) => info.airlockKnown) ? ' airlocked' : '';
  const warnings = [
    library.extraError && `Playlist: ${library.extraError}.`,
    library.webError && `Could not load your TorBox web downloads (${library.webError}), so only torrents are included.`,
    ...library.unmatched.map((words) => `"#TORBOX:${words}" in your playlist matched nothing. `
      + `Only${airlocked} TorBox downloads that have finished downloading and contain a video count.`),
    ...kinds.filter(([, info]) => !info.airlockKnown && info.total > 0)
      .map(([kind]) => `TorBox did not say which ${TORBOX_KINDS[kind].many} are airlocked, so all of them are included.`),
  ].filter(Boolean).map((text) => `<p class="error">${escapeHtml(text)}</p>`).join('');
  return htmlResponse(installPage({
    summary,
    manifestUrl: `${origin}/torbox/${encodeURIComponent(secret)}/manifest.json`,
    playlistName: TORBOX_NAME,
    extra: `${warnings}<p>Keep this link private: anyone who has it can play your TorBox files.</p>`,
  }), 200, noStore);
}

function installPage({ summary, manifestUrl, playlistName, extra }) {
  const installUrl = manifestUrl.replace(/^https?:\/\//, 'stremio://');
  return renderPage('Install in Stremio', `
    ${LOGO}
    <h1>M3U & TorBox Addon</h1>
    <div class="card">
      <p class="success">${escapeHtml(summary)}</p>
      <a class="btn" href="${escapeHtml(installUrl)}">Install in Stremio</a>
      <p class="info">Or copy the manifest URL:</p>
      <div class="manifest-url"><a href="${escapeHtml(manifestUrl)}">${escapeHtml(manifestUrl)}</a></div>
      <p class="info">Open "${escapeHtml(playlistName)}" from the Stremio home screen and play the first episode.<br>
      The next video starts automatically and your progress shows up in Continue Watching.</p>
      ${extra}
    </div>
    <a href="/">← Back to Home</a>`);
}

async function dashboard(url) {
  const playlistUrl = url.searchParams.get('url') || '';
  let playlist = null;
  let error = '';
  if (/^https?:\/\//i.test(playlistUrl)) {
    try {
      playlist = await loadPlaylist(playlistUrl);
    } catch (e) {
      error = e.message;
    }
  }
  const videoList = playlist
    ? playlist.items.map((v) => `<li>${escapeHtml(v.title)}: <a href="${escapeHtml(v.url)}">${escapeHtml(v.url)}</a></li>`).join('')
    : '';
  return htmlResponse(renderPage('M3U/Direct Video Dashboard', `
    ${LOGO}
    <h1>Dashboard</h1>
    <div class="card">
      <p class="info">Configured: ${playlist ? `${escapeHtml(playlist.kind)} — ${escapeHtml(playlistUrl)}` : 'None'}</p>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
      <h2>Videos</h2>
      <ul>${videoList || '<li>No videos configured</li>'}</ul>
    </div>
    <a href="/">← Back to Home</a>`));
}

function notFound() {
  return htmlResponse(renderPage('Not found', `
    ${LOGO}
    <h1>404</h1>
    <p class="info">Page not found</p>
    <a class="btn" href="/">Back to Home</a>`), 404);
}

const STYLE = `
  *,*::before,*::after { box-sizing: border-box; }
  body {
    background: linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%);
    color: #e0e0ef;
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    text-align: center;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    margin: 0;
    padding: 32px 16px;
    line-height: 1.5;
  }
  .logo { width: 56px; height: 56px; margin-bottom: 8px; opacity: 0.9; }
  h1 {
    font-size: 1.6rem;
    font-weight: 700;
    color: #fff;
    margin: 0 0 4px;
  }
  h2 {
    font-size: 1.2rem;
    font-weight: 600;
    color: #c8c8e0;
    margin: 24px 0 12px;
  }
  h3 {
    font-size: 1rem;
    font-weight: 600;
    color: #a8a8cc;
    margin: 28px 0 8px;
  }
  .subtitle {
    color: #8888aa;
    font-size: 0.85rem;
    margin: 0 0 24px;
  }
  .card {
    background: rgba(255,255,255,0.06);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 16px;
    padding: 28px 24px;
    width: 100%;
    max-width: 460px;
    margin: 12px 0;
  }
  form { display: flex; flex-direction: column; align-items: center; gap: 12px; }
  input[type="url"], input[type="password"] {
    width: 100%;
    max-width: 380px;
    padding: 12px 16px;
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 10px;
    background: rgba(0,0,0,0.3);
    color: #fff;
    font-size: 0.9rem;
    outline: none;
    transition: border-color 0.2s;
  }
  input:focus { border-color: #7b4dff; }
  input::placeholder { color: #6a6a88; }
  button {
    padding: 12px 28px;
    background: linear-gradient(135deg, #7b4dff, #3ea6ff);
    color: white;
    border: none;
    border-radius: 10px;
    cursor: pointer;
    font-weight: 600;
    font-size: 0.9rem;
    transition: opacity 0.2s, transform 0.15s;
  }
  button:hover { opacity: 0.9; transform: translateY(-1px); }
  button:active { transform: translateY(0); }
  p { max-width: 90vw; overflow-wrap: anywhere; margin: 8px 0; }
  p.error {
    color: #ff6b6b;
    background: rgba(255,60,60,0.1);
    border: 1px solid rgba(255,60,60,0.2);
    border-radius: 10px;
    padding: 10px 16px;
    font-size: 0.85rem;
  }
  p.success {
    color: #69db7c;
    background: rgba(60,255,100,0.08);
    border: 1px solid rgba(60,255,100,0.15);
    border-radius: 10px;
    padding: 10px 16px;
    font-size: 0.85rem;
  }
  a {
    color: #7b9dff;
    text-decoration: none;
    transition: color 0.2s;
    overflow-wrap: anywhere;
  }
  a:hover { color: #a8c0ff; text-decoration: underline; }
  a.btn {
    display: inline-block;
    padding: 10px 24px;
    background: linear-gradient(135deg, #7b4dff, #3ea6ff);
    color: #fff;
    border-radius: 10px;
    font-weight: 600;
    font-size: 0.9rem;
    margin: 6px 0;
    transition: opacity 0.2s, transform 0.15s;
  }
  a.btn:hover { opacity: 0.9; transform: translateY(-1px); text-decoration: none; }
  .manifest-url {
    background: rgba(0,0,0,0.3);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 10px;
    padding: 10px 14px;
    font-size: 0.75rem;
    color: #8888aa;
    word-break: break-all;
    margin: 8px 0;
  }
  .manifest-url a { color: #8888aa; }
  .manifest-url a:hover { color: #a8c0ff; }
  .info { color: #8888aa; font-size: 0.82rem; margin: 6px 0; }
  .divider {
    width: 60px;
    height: 1px;
    background: rgba(255,255,255,0.1);
    margin: 20px auto;
  }
  ul {
    list-style: none;
    padding: 0;
    margin: 0;
    text-align: left;
    max-width: 500px;
    width: 100%;
  }
  li {
    padding: 8px 0;
    border-bottom: 1px solid rgba(255,255,255,0.05);
    font-size: 0.85rem;
    color: #c0c0d8;
  }
  li:last-child { border-bottom: none; }
  li a { font-size: 0.75rem; }
  .note { font-size: 0.8rem; color: #6a6a88; }
`;

function renderPage(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function preview(origin, id, name, count) {
  return {
    id,
    type: 'series',
    name,
    poster: `${origin}/poster.svg`,
    posterShape: 'landscape',
    background: `${origin}/poster.svg`,
    description: `${count} videos`,
  };
}

// Every video is an episode of season 1, in playlist order. Stremio starts the next episode when
// one ends and keeps your place in Continue Watching.
function episode(id, title, index, thumbnail) {
  return { id, title, season: 1, episode: index + 1, thumbnail };
}

// The same bingeGroup on every episode is what lets Stremio auto-play the next one.
function stream(url, name, title, bingeGroup, webReady) {
  return { url, name, title, behaviorHints: { bingeGroup, notWebReady: !webReady } };
}

// Small per-isolate cache. Cloudflare may drop it at any time; it only saves repeated downloads.
const memory = new Map();
async function cached(key, ttlMs, load) {
  const hit = memory.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await load();
  if (memory.size >= 200) memory.delete(memory.keys().next().value);
  memory.set(key, { at: Date.now(), value });
  return value;
}

// Read a text body, refusing anything bigger than maxBytes.
async function readText(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error('File is too big to be a playlist');
    }
    chunks.push(value);
  }
  return new Blob(chunks).text();
}

async function discard(response) {
  try {
    await response.body?.cancel();
  } catch {
    // nothing to clean up
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

function htmlResponse(markup, status = 200, headers = {}) {
  return new Response(markup, { status, headers: { ...PAGE_HEADERS, ...headers } });
}

// Escape text before putting it in HTML (URLs and titles come from users and remote playlists).
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// Fallback title taken from the last path segment of a URL.
function nameFromUrl(url) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(last).replace(/\.\w{2,4}$/, '') || 'Video';
  } catch {
    return 'Video';
  }
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

// Keep ADDON_SECRET out of the logs.
function redact(pathname) {
  return pathname.replace(/^\/torbox\/[^/]+/, '/torbox/<secret>');
}
