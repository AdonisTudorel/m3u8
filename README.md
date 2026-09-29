# Stremio M3U & TorBox Playlist Addon

A Stremio addon, running on Cloudflare Workers, that shows a playlist as a series. Videos play one after another (Stremio's auto-play of the next episode) and Stremio keeps your progress in Continue Watching.

Two playlist sources:

- An M3U playlist (for example a GitHub gist) or a single video link.
- Your TorBox torrents, in the order you added them. Download links are requested from TorBox when you press play, so they don't go stale.

## Deploy to Cloudflare Workers

1. In the Cloudflare dashboard, go to Workers & Pages → Create → Import a repository and pick this repo. Name the Worker `stremio-m3u-addon`: it must match `name` in `wrangler.jsonc`. Every push to `main` redeploys.
   From a terminal instead: `npm install`, `npx wrangler login`, `npm run deploy`.
2. For TorBox, add two secrets in Worker → Settings → Variables and Secrets, with type "Secret" (or run `npx wrangler secret put <NAME>`):
   - `TORBOX_API_KEY`: your API key from the TorBox settings page.
   - `ADDON_SECRET`: a long random password, at least 16 characters, for example the output of `openssl rand -hex 16`.
3. Open `https://stremio-m3u-addon.<your-subdomain>.workers.dev`, then either paste an M3U URL and click "Validate Link", or enter your `ADDON_SECRET` under "TorBox Playlist". Click "Install in Stremio".
4. In Stremio, open the playlist from the home screen and play the first episode.

Keep the TorBox install link private: anyone who has it can play your TorBox files.

## Local development

Create `.dev.vars` (ignored by git) with `TORBOX_API_KEY=...` and `ADDON_SECRET=...`, then run `npm install` and `npm run dev`.
