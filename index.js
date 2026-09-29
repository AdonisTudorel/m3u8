const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const fetch = require('node-fetch');
const m3u8Parser = require('m3u8-parser');

// Initialize Express
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Store configuration (in-memory)
let config = { type: null, url: null, videos: [] };

// Helper to validate M3U
async function validateM3U(url) {
  try {
    const response = await fetch(url, { method: 'GET', timeout: 5000 });
    if (!response.ok) return { valid: false, error: `HTTP ${response.status}` };
    const text = await response.text();
    const parser = new m3u8Parser.Parser();
    parser.push(text);
    parser.end();
    const manifest = parser.manifest;
    if (manifest.segments?.length > 0 || manifest.playlists?.length > 0) {
      return { valid: true };
    }
    return { valid: false, error: 'Invalid M3U: no segments or playlists' };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

// Helper to validate direct video
async function validateDirect(url) {
  try {
    const response = await fetch(url, { method: 'HEAD', timeout: 5000 });
    if (!response.ok) return { valid: false, error: `HTTP ${response.status}` };
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('video') || contentType.includes('application/vnd.apple.mpegurl')) {
      return { valid: true };
    }
    return { valid: false, error: 'Not a video URL' };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

// Helper to parse M3U
async function parseM3U(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch M3U: ${response.status}`);
    const text = await response.text();
    const parser = new m3u8Parser.Parser();
    parser.push(text);
    parser.end();
    const manifest = parser.manifest;
    const videos = manifest.segments.length > 0
      ? manifest.segments.map((seg, i) => ({
          id: `m3u:${i + 1}`,
          title: seg.title || `Video ${i + 1}`,
          url: seg.uri,
        }))
      : manifest.playlists
        ? manifest.playlists.map((pl, i) => ({
            id: `m3u:${i + 1}`,
            title: pl.attributes?.NAME || `Stream ${i + 1}`,
            url: pl.uri,
          }))
        : [];
    console.log(`Parsed ${videos.length} videos from ${url}`);
    return videos;
  } catch (error) {
    console.error('M3U Parse Error:', error.message);
    return [];
  }
}

// Define addon
const builder = new addonBuilder({
  id: 'org.sidh.m3uaddon',
  version: '1.2.1',
  name: 'M3U & Direct Video Addon',
  description: 'Stremio addon for M3U playlists and direct video links',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie'],
  catalogs: [
    {
      type: 'movie',
      id: 'm3u-videos',
      name: config.type === 'direct' ? 'Direct Video' : 'M3U Videos',
    },
  ],
  behaviorHints: {
    configurable: false,
    configurationRequired: false,
  },
  background: 'https://raw.githubusercontent.com/sidh3369/m3u8/main/background.jpg',
});

// Define handlers
builder.defineCatalogHandler(async ({ type, id }) => {
  console.log(`Catalog request: type=${type}, id=${id}`);
  if (type === 'movie' && id === 'm3u-videos') {
    if (!config.url) {
      return { metas: [] };
    }
    if (config.type === 'm3u') {
      const videos = await parseM3U(config.url);
      config.videos = videos;
      return {
        metas: videos.map((video) => ({
          id: video.id,
          type: 'movie',
          name: video.title,
          poster: 'https://via.placeholder.com/150',
        })),
      };
    } else if (config.type === 'direct') {
      config.videos = [{ id: 'direct:1', title: 'Direct Video', url: config.url }];
      return {
        metas: [
          {
            id: 'direct:1',
            type: 'movie',
            name: 'Direct Video',
            poster: 'https://via.placeholder.com/150',
          },
        ],
      };
    }
  }
  return { metas: [] };
});

builder.defineMetaHandler(async ({ type, id }) => {
  console.log(`Meta request: id=${id}`);
  const video = config.videos.find((v) => v.id === id);
  if (video) {
    return {
      meta: {
        id: video.id,
        type: 'movie',
        name: video.title,
        poster: 'https://via.placeholder.com/150',
      },
    };
  }
  return { meta: {} };
});

builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`Stream request: id=${id}`);
  const video = config.videos.find((v) => v.id === id);
  if (video) {
    return {
      streams: [{ url: video.url, title: video.title }],
    };
  }
  return { streams: [] };
});

// Homepage with link styling
app.get('/', (req, res) => {
  console.log('Serving /');
  res.set('Access-Control-Allow-Origin', '*');
  res.send(`
    <html>
      <head>
        <style>
          body {
            background-image: url('https://raw.githubusercontent.com/sidh3369/m3u8/main/background.jpg');
            background-size: cover;
            background-position: center;
            background-repeat: no-repeat;
            color: white;
            font-family: Arial, sans-serif;
            text-align: center;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            margin: 0;
          }
          h1, h3 { 
            text-shadow: 2px 2px 4px rgba(0,0,0,0.9);
            background: rgba(0,0,0,0.7);
            padding: 10px 20px;
            border-radius: 5px;
          }
          form {
            background: rgba(0,0,0,0.8);
            padding: 20px;
            border-radius: 10px;
            box-shadow: 0 0 10px rgba(0,0,0,0.5);
          }
          input[type="url"] {
            width: 300px;
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
          p.error { 
            color: #ff4d4d; 
            background: rgba(0,0,0,0.7);
            padding: 10px;
            border-radius: 5px;
          }
          p.success { 
            color: #4dff4d; 
            background: rgba(0,0,0,0.7);
            padding: 10px;
            border-radius: 5px;
          }
          a {
            color: #4da8ff;
            text-decoration: none;
            margin-top: 10px;
            display: inline-block;
            background: rgba(0,0,0,0.7);
            padding: 5px 10px;
            border-radius: 5px;
            font-weight: bold;
          }
          a:hover { text-decoration: underline; }
        </style>
      </head>
      <body>
        <h1>Stremio M3U & Direct Video Addon</h1>
        <h3>Paste M3U Playlist or Direct Video URL</h3>
        <form action="/validate" method="POST">
          <input type="url" name="url" placeholder="Enter URL" required><br>
          <button type="submit">Validate Link</button>
        </form>
      </body>
    </html>
  `);
});

// Validate link endpoint
app.post('/validate', async (req, res) => {
  console.log('POST /validate:', req.body);
  res.set('Access-Control-Allow-Origin', '*');
  const { url } = req.body;
  if (!url) {
    return res.send(`
      <html>
        <head>
          <style>
            body {
              background-image: url('https://raw.githubusercontent.com/sidh3369/m3u8/main/background.jpg');
              background-size: cover;
              background-position: center;
              background-repeat: no-repeat;
              color: white;
              font-family: Arial, sans-serif;
              text-align: center;
              min-height: 100vh;
              display: flex;
              flex-direction: column;
              justify-content: center;
              align-items: center;
              margin: 0;
            }
            h1, h3 { 
              text-shadow: 2px 2px 4px rgba(0,0,0,0.9);
              background: rgba(0,0,0,0.7);
              padding: 10px 20px;
              border-radius: 5px;
            }
            form {
              background: rgba(0,0,0,0.8);
              padding: 20px;
              border-radius: 10px;
              box-shadow: 0 0 10px rgba(0,0,0,0.5);
            }
            input[type="url"] {
              width: 300px;
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
            p.error { 
              color: #ff4d4d; 
              background: rgba(0,0,0,0.7);
              padding: 10px;
              border-radius: 5px;
            }
            p.success { 
              color: #4dff4d; 
              background: rgba(0,0,0,0.7);
              padding: 10px;
              border-radius: 5px;
            }
            a {
              color: #4da8ff;
              text-decoration: none;
              margin-top: 10px;
              display: inline-block;
              background: rgba(0,0,0,0.7);
              padding: 5px 10px;
              border-radius: 5px;
              font-weight: bold;
            }
            a:hover { text-decoration: underline; }
          </style>
        </head>
        <body>
          <h1>Stremio M3U & Direct Video Addon</h1>
          <p class="error">Error: URL is required</p>
          <form action="/validate" method="POST">
            <input type="url" name="url" placeholder="Enter URL" required><br>
            <button type="submit">Validate Link</button>
          </form>
        </body>
      </html>
    `);
  }

  let result = await validateM3U(url);
  let type = 'm3u';
  if (!result.valid) {
    result = await validateDirect(url);
    type = 'direct';
  }

  if (result.valid) {
    config.type = type;
    config.url = url;
    if (type === 'm3u') {
      config.videos = await parseM3U(url);
    } else {
      config.videos = [{ id: 'direct:1', title: 'Direct Video', url }];
    }
    const encodedUrl = encodeURIComponent(url);
    const manifestUrl = `https://m3u-ce5x.onrender.com/addon/manifest.json?url=${encodedUrl}`;
    res.send(`
      <html>
        <head>
          <style>
            body {
              background-image: url('https://raw.githubusercontent.com/sidh3369/m3u8/main/background.jpg');
              background-size: cover;
              background-position: center;
              background-repeat: no-repeat;
              color: white;
              font-family: Arial, sans-serif;
              text-align: center;
              min-height: 100vh;
              display: flex;
              flex-direction: column;
              justify-content: center;
              align-items: center;
              margin: 0;
            }
            h1, h3 { 
              text-shadow: 2px 2px 4px rgba(0,0,0,0.9);
              background: rgba(0,0,0,0.7);
              padding: 10px 20px;
              border-radius: 5px;
            }
            form {
              background: rgba(0,0,0,0.8);
              padding: 20px;
              border-radius: 10px;
              box-shadow: 0 0 10px rgba(0,0,0,0.5);
            }
            input[type="url"] {
              width: 300px;
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
            p.error { 
              color: #ff4d4d; 
              background: rgba(0,0,0,0.7);
              padding: 10px;
              border-radius: 5px;
            }
            p.success { 
              color: #4dff4d; 
              background: rgba(0,0,0,0.7);
              padding: 10px;
              border-radius: 5px;
            }
            a {
              color: #4da8ff;
              text-decoration: none;
              margin-top: 10px;
              display: inline-block;
              background: rgba(0,0,0,0.7);
              padding: 5px 10px;
              border-radius: 5px;
              font-weight: bold;
            }
            a:hover { text-decoration: underline; }
          </style>
        </head>
        <body>
          <h1>Stremio M3U & Direct Video Addon</h1>
          <p class="success">Link is valid (${type === 'm3u' ? 'M3U Playlist' : 'Direct Video'})!</p>
          <p>URL: ${url}</p>
          <p>Copy this manifest URL and paste it into Stremio to install:</p>
          <p><a href="${manifestUrl}">${manifestUrl}</a></p>
          <br><a href="/dashboard">View Dashboard</a>
        </body>
      </html>
    `);
  } else {
    res.send(`
      <html>
        <head>
          <style>
            body {
              background-image: url('https://raw.githubusercontent.com/sidh3369/m3u8/main/background.jpg');
              background-size: cover;
              background-position: center;
              background-repeat: no-repeat;
              color: white;
              font-family: Arial, sans-serif;
              text-align: center;
              min-height: 100vh;
              display: flex;
              flex-direction: column;
              justify-content: center;
              align-items: center;
              margin: 0;
            }
            h1, h3 { 
              text-shadow: 2px 2px 4px rgba(0,0,0,0.9);
              background: rgba(0,0,0,0.7);
              padding: 10px 20px;
              border-radius: 5px;
            }
            form {
              background: rgba(0,0,0,0.8);
              padding: 20px;
              border-radius: 10px;
              box-shadow: 0 0 10px rgba(0,0,0,0.5);
            }
            input[type="url"] {
              width: 300px;
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
            p.error { 
              color: #ff4d4d; 
              background: rgba(0,0,0,0.7);
              padding: 10px;
              border-radius: 5px;
            }
            p.success { 
              color: #4dff4d; 
              background: rgba(0,0,0,0.7);
              padding: 10px;
              border-radius: 5px;
            }
            a {
              color: #4da8ff;
              text-decoration: none;
              margin-top: 10px;
              display: inline-block;
              background: rgba(0,0,0,0.7);
              padding: 5px 10px;
              border-radius: 5px;
              font-weight: bold;
            }
            a:hover { text-decoration: underline; }
          </style>
        </head>
        <body>
          <h1>Stremio M3U & Direct Video Addon</h1>
          <p class="error">Error: Invalid link - ${result.error}</p>
          <form action="/validate" method="POST">
            <input type="url" name="url" placeholder="Enter URL" required value="${url}"><br>
            <button type="submit">Validate Link</button>
          </form>
        </body>
      </html>
    `);
  }
});

// Dashboard endpoint
app.get('/dashboard', (req, res) => {
  console.log('Serving /dashboard');
  res.set('Access-Control-Allow-Origin', '*');
  const videoList = config.videos
    .map((v) => `<li>${v.title}: <a href="${v.url}">${v.url}</a></li>`)
    .join('');
  res.send(`
    <html>
      <head>
        <style>
          body {
            background-image: url('https://raw.githubusercontent.com/sidh3369/m3u8/main/background.jpg');
            background-size: cover;
            background-position: center;
            background-repeat: no-repeat;
            color: white;
            font-family: Arial, sans-serif;
            text-align: center;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            margin: 0;
          }
          h1, h2 { 
            text-shadow: 2px 2px 4px rgba(0,0,0,0.9);
            background: rgba(0,0,0,0.7);
            padding: 10px 20px;
            border-radius: 5px;
          }
          ul {
            background: rgba(0,0,0,0.8);
            padding: 20px;
            border-radius: 10px;
            box-shadow: 0 0 10px rgba(0,0,0,0.5);
            list-style: none;
            max-width: 600px;
          }
          li { margin: 10px 0; }
          a {
            color: #4da8ff;
            text-decoration: none;
            background: rgba(0,0,0,0.7);
            padding: 5px 10px;
            border-radius: 5px;
            font-weight: bold;
          }
          a:hover { text-decoration: underline; }
        </style>
      </head>
      <body>
        <h1>M3U/Direct Video Dashboard</h1>
        <p>Configured: ${config.type || 'None'} - ${config.url || 'No URL'}</p>
        <h2>Videos</h2>
        <ul>${videoList || '<li>No videos configured</li>'}</ul>
        <a href="/">Back to Home</a>
      </body>
    </html>
  `);
});

// Mount addon routes on the existing Express app.
// serveHTTP() starts its own server and returns a Promise, so it can't be used as middleware;
// getRouter() returns a router (with CORS enabled) that serves manifest/catalog/meta/stream.
app.use('/addon', getRouter(builder.getInterface()));

// Start server
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
  console.log(`Addon server running on port ${PORT}`);
  console.log(`Access home: http://localhost:${PORT}/`);
  console.log(`Access dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`Install in Stremio: http://localhost:${PORT}/addon/manifest.json`);
});
