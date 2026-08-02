// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Minimal static server with COOP/COEP so the page is crossOriginIsolated
// (required for SharedArrayBuffer + wasm threads). Mirrors the production
// vercel.json header pair, but uses require-corp (all assets are same-origin).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, normalize, resolve, sep } from 'node:path';

const ROOT = resolve(new URL('.', import.meta.url).pathname);
const PORT = Number(process.env.PORT || 8099);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.json': 'application/json',
};

createServer(async (req, res) => {
  // COOP/COEP on EVERY response → crossOriginIsolated === true.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    // Strip leading slashes so the path resolves RELATIVE to ROOT, then confirm
    // the resolved file stays inside ROOT — defeats `..`/absolute path traversal
    // (e.g. `/../../etc/passwd`).
    const rel = normalize(urlPath === '/' ? 'index.html' : urlPath).replace(/^[/\\]+/, '');
    const file = resolve(ROOT, rel);
    if (file !== ROOT && !file.startsWith(ROOT + sep)) {
      res.statusCode = 403;
      res.end('forbidden');
      return;
    }
    const body = await readFile(file);
    res.setHeader('Content-Type', TYPES[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch (e) {
    res.statusCode = 404;
    res.end('not found: ' + e.message);
  }
}).listen(PORT, () => console.log(`serving ${ROOT} on http://localhost:${PORT} (COOP/COEP on)`));
