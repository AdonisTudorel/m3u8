/**
 * Stremio addon running on Cloudflare Workers.
 *
 * Two playlists, both shown in Stremio as a series. Every video is an episode and every stream
 * carries the same bingeGroup, so Stremio plays the next video when one ends and keeps your
 * progress in Continue Watching.
 *
 *   /addon/<config>/manifest.json          An M3U playlist or a single video link.
 *                                          <config> is the URL-encoded JSON {"url": "..."}.
 *   /torbox/<ADDON_SECRET>/manifest.json   Your TorBox torrents, oldest first. Download links
 *                                          are requested from TorBox when you press play.
 *
 * Secrets (Worker > Settings > Variables and Secrets, type "Secret"):
 *   TORBOX_API_KEY  TorBox API key. Only ever sent to the TorBox API.
 *   ADDON_SECRET    Long random password (16+ characters) that protects the TorBox routes.
 * TORBOX_API_BASE can override the TorBox API URL for local testing.
 */

const TORBOX_API = 'https://api.torbox.app/v1/api';
const TORBOX_PAGE_SIZE = 1000;
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
    background: `${origin}/background.jpg`,
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
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(url));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return M3U_PREFIX + hex.slice(0, 12);
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
    if (!parsed.items.length) throw new Error('No video links found');
    console.log(`Loaded ${parsed.items.length} videos from ${url}`);
    return { kind: 'm3u', name: parsed.name || 'M3U Playlist', items: parsed.items };
  });
}

// Parse an M3U playlist: each video is an optional "#EXTINF:<duration> <key="value">...,<title>"
// line followed by the video URL. Relative URLs are resolved against the playlist URL.
function parseM3U(text, playlistUrl) {
  const items = [];
  let name = null;
  let info = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#PLAYLIST:')) {
      name = line.slice('#PLAYLIST:'.length).trim() || null;
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
        items.push({ title: (info && info.title) || nameFromUrl(url.href), url: url.href, logo: info && info.logo });
      }
      info = null;
    }
  }
  return { name, items };
}

// ---------------------------------------------------------------------------------------------
// TorBox addon
// ---------------------------------------------------------------------------------------------

function torboxManifest(origin) {
  return {
    id: 'org.sidh.m3uaddon.torbox',
    version: '1.0.0',
    name: TORBOX_NAME,
    description: 'Your TorBox torrents as one playlist, in the order you added them. Videos play one after another and Stremio keeps your progress',
    resources: ['catalog', 'meta', 'stream'],
    types: ['series'],
    idPrefixes: [TORBOX_PREFIX],
    catalogs: [{ type: 'series', id: TORBOX_CATALOG, name: TORBOX_NAME }],
    background: `${origin}/background.jpg`,
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

  let match = rest.match(/^\/play\/(\d+)\/(\d+)$/);
  if (match) return torboxPlay(request, env, match[1], match[2]);

  match = rest.match(/^\/(catalog|meta|stream)\/([^/]+)\/([^/]+?)(?:\/[^/]+)?\.json$/);
  const id = match && safeDecode(match[3]);
  if (!match || id === null) return json({ err: 'not found' }, 404);
  const resource = match[1];
  console.log(`TorBox ${resource} ${id}`);

  if (resource === 'catalog') {
    if (id !== TORBOX_CATALOG) return json({ metas: [] });
    try {
      const items = await torboxLibrary(env);
      return json({ metas: items.length ? [preview(origin, TORBOX_META_ID, TORBOX_NAME, items.length)] : [] });
    } catch (error) {
      console.error(`TorBox catalog: ${error.message}`);
      return json({ metas: [] });
    }
  }
  if (resource === 'meta') {
    if (id !== TORBOX_META_ID) return json({ err: 'not found' }, 404);
    const items = await torboxLibrary(env);
    const videos = items.map((item, i) => episode(torboxVideoId(item), item.title, i));
    return json({ meta: { ...preview(origin, TORBOX_META_ID, TORBOX_NAME, videos.length), videos } });
  }
  const item = (await torboxLibrary(env)).find((entry) => torboxVideoId(entry) === id);
  if (!item) return json({ streams: [] });
  // The stream points back to this Worker, which asks TorBox for a fresh link at play time. That keeps
  // Continue Watching working long after a saved TorBox link would have expired.
  const playUrl = `${origin}/torbox/${encodeURIComponent(secret)}/play/${item.torrentId}/${item.fileId}`;
  return json({ streams: [stream(playUrl, 'TorBox', item.title, TORBOX_META_ID, item.webReady)] });
}

function torboxVideoId(item) {
  return `${TORBOX_PREFIX}${item.torrentId}:${item.fileId}`;
}

// Redirect the player to a fresh TorBox download link.
async function torboxPlay(request, env, torrentId, fileId) {
  console.log(`TorBox play ${torrentId}/${fileId}`);
  const link = await cached(`torbox-link:${torrentId}:${fileId}`, LINK_TTL_MS, async () => {
    const params = new URLSearchParams({
      token: env.TORBOX_API_KEY,
      torrent_id: torrentId,
      file_id: fileId,
      zip_link: 'false',
      redirect: 'false',
    });
    // Lets TorBox pick the CDN server closest to the viewer.
    const ip = request.headers.get('CF-Connecting-IP');
    if (ip) params.set('user_ip', ip);
    const data = await torboxApi(env, `/torrents/requestdl?${params}`);
    if (typeof data !== 'string' || !/^https?:\/\//.test(data)) throw new Error('TorBox did not return a download link');
    return data;
  });
  return new Response(null, { status: 302, headers: { Location: link, 'Cache-Control': 'no-store', ...CORS } });
}

// All finished video files in the TorBox account: oldest torrent first (the order you added them),
// files inside a torrent in natural name order.
function torboxLibrary(env) {
  return cached('torbox-library', PLAYLIST_TTL_MS, async () => {
    const torrents = new Map();
    // mylist is paginated. Stop at a page that isn't full or adds nothing new (20 pages at most).
    for (let page = 0; page < 20; page += 1) {
      const data = await torboxApi(env, `/torrents/mylist?offset=${page * TORBOX_PAGE_SIZE}&limit=${TORBOX_PAGE_SIZE}`);
      const list = Array.isArray(data) ? data : [];
      const before = torrents.size;
      for (const torrent of list) if (torrent && torrent.id != null) torrents.set(torrent.id, torrent);
      if (list.length < TORBOX_PAGE_SIZE || torrents.size === before) break;
    }
    const items = buildTorboxPlaylist([...torrents.values()]);
    console.log(`TorBox library: ${torrents.size} torrents, ${items.length} videos`);
    return items;
  });
}

function buildTorboxPlaylist(torrents) {
  // Torrents without a date go last; ties are broken by id (TorBox ids grow as you add torrents).
  const addedAt = (torrent) => {
    const time = Date.parse(torrent.created_at);
    return Number.isNaN(time) ? Infinity : time;
  };
  const ready = torrents
    // Skip torrents that are still downloading or whose files are gone.
    .filter((t) => Array.isArray(t.files) && t.download_present !== false && t.download_finished !== false)
    .sort((a, b) => (addedAt(a) - addedAt(b)) || Number(a.id) - Number(b.id));
  const items = [];
  for (const torrent of ready) {
    const videos = torrent.files.filter((file) => file && file.id != null && isVideoFile(file));
    const withoutSamples = videos.filter((file) => !/\bsample\b/i.test(torboxFileName(file)));
    const files = (withoutSamples.length ? withoutSamples : videos).sort((a, b) =>
      torboxFileName(a).localeCompare(torboxFileName(b), undefined, { numeric: true, sensitivity: 'base' }));
    for (const file of files) {
      const title = torboxFileName(file).replace(/\.\w{2,4}$/, '');
      items.push({
        torrentId: torrent.id,
        fileId: file.id,
        title: files.length > 1 ? `${torrent.name} - ${title}` : title,
        webReady: WEB_READY_FILE.test(torboxFileName(file)),
      });
    }
  }
  return items;
}

function torboxFileName(file) {
  return String(file.short_name || String(file.name || '').split('/').pop() || '');
}

function isVideoFile(file) {
  return String(file.mimetype || '').startsWith('video/') || VIDEO_FILE.test(torboxFileName(file));
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

function homePage(env, { m3uError = '', url = '', torboxError = '' } = {}) {
  const torbox = torboxEnabled(env)
    ? `<h3>TorBox Playlist</h3>
      ${torboxError ? `<p class="error">Error: ${escapeHtml(torboxError)}</p>` : ''}
      <form action="/torbox" method="POST">
        <input type="password" name="secret" placeholder="Your ADDON_SECRET" aria-label="Addon secret" autocomplete="current-password" required><br>
        <button type="submit">Get TorBox Install Link</button>
      </form>`
    : `<p>TorBox playlist is off. Add the secrets TORBOX_API_KEY and ADDON_SECRET (at least ${MIN_SECRET_LENGTH} characters) to this Worker to turn it on.</p>`;
  return renderPage('Stremio M3U & TorBox Addon', `
    <h1>Stremio M3U & Direct Video Addon</h1>
    <h3>Paste M3U Playlist or Direct Video URL</h3>
    ${m3uError ? `<p class="error">Error: ${escapeHtml(m3uError)}</p>` : ''}
    <form action="/validate" method="POST">
      <input type="url" name="url" placeholder="Enter URL" aria-label="Playlist or video URL" value="${escapeHtml(url)}" required><br>
      <button type="submit">Validate Link</button>
    </form>
    ${torbox}`);
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
  let items;
  try {
    items = await torboxLibrary(env);
  } catch (error) {
    return htmlResponse(homePage(env, { torboxError: error.message }), 502, noStore);
  }
  return htmlResponse(installPage({
    summary: `TorBox connected: ${items.length} videos, oldest first.`,
    manifestUrl: `${origin}/torbox/${encodeURIComponent(secret)}/manifest.json`,
    playlistName: TORBOX_NAME,
    extra: '<p>Keep this link private: anyone who has it can play your TorBox files.</p>',
  }), 200, noStore);
}

function installPage({ summary, manifestUrl, playlistName, extra }) {
  const installUrl = manifestUrl.replace(/^https?:\/\//, 'stremio://');
  return renderPage('Install in Stremio', `
    <h1>Stremio M3U & Direct Video Addon</h1>
    <p class="success">${escapeHtml(summary)}</p>
    <p><a href="${escapeHtml(installUrl)}">Install in Stremio</a></p>
    <p>Or copy this manifest URL and paste it into Stremio's addon search to install:</p>
    <p><a href="${escapeHtml(manifestUrl)}">${escapeHtml(manifestUrl)}</a></p>
    <p>In Stremio, open "${escapeHtml(playlistName)}" from the home screen and play the first episode.<br>
    The next video starts automatically when one ends, and your progress shows up in Continue Watching.</p>
    ${extra}
    <a href="/">Back to Home</a>`);
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
    <h1>M3U/Direct Video Dashboard</h1>
    <p>Configured: ${playlist ? `${escapeHtml(playlist.kind)} - ${escapeHtml(playlistUrl)}` : 'None - No URL'}</p>
    ${error ? `<p class="error">Error: ${escapeHtml(error)}</p>` : ''}
    <h2>Videos</h2>
    <ul>${videoList || '<li>No videos configured</li>'}</ul>
    <a href="/">Back to Home</a>`));
}

function notFound() {
  return htmlResponse(renderPage('Not found', '<h1>Not found</h1><a href="/">Back to Home</a>'), 404);
}

const STYLE = `
  body {
    background: #111 url('/background.jpg') center / cover no-repeat fixed;
    color: white;
    font-family: Arial, sans-serif;
    text-align: center;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    margin: 0;
    padding: 20px;
    box-sizing: border-box;
  }
  h1, h2, h3 {
    text-shadow: 2px 2px 4px rgba(0,0,0,0.9);
    background: rgba(0,0,0,0.7);
    padding: 10px 20px;
    border-radius: 5px;
  }
  form, ul {
    background: rgba(0,0,0,0.8);
    padding: 20px;
    border-radius: 10px;
    box-shadow: 0 0 10px rgba(0,0,0,0.5);
  }
  ul { list-style: none; max-width: 600px; }
  li { margin: 10px 0; }
  p { background: rgba(0,0,0,0.6); padding: 8px 12px; border-radius: 5px; max-width: 90vw; overflow-wrap: anywhere; }
  input[type="url"], input[type="password"] {
    width: 300px;
    max-width: 80vw;
    padding: 10px;
    margin: 10px 0;
    border: none;
    border-radius: 5px;
    background: #fff;
    color: #000;
  }
  button {
    padding: 10px 20px;
    background: #007bff;
    color: white;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    font-weight: bold;
  }
  button:hover { background: #0056b3; }
  p.error { color: #ff4d4d; background: rgba(0,0,0,0.7); padding: 10px; }
  p.success { color: #4dff4d; background: rgba(0,0,0,0.7); padding: 10px; }
  a {
    color: #4da8ff;
    text-decoration: none;
    margin-top: 10px;
    display: inline-block;
    background: rgba(0,0,0,0.7);
    padding: 5px 10px;
    border-radius: 5px;
    font-weight: bold;
    overflow-wrap: anywhere;
  }
  a:hover { text-decoration: underline; }
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
    poster: `${origin}/background.jpg`,
    posterShape: 'landscape',
    background: `${origin}/background.jpg`,
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
