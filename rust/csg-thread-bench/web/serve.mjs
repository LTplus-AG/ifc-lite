// Minimal static server with COOP/COEP so the page is crossOriginIsolated
// (required for SharedArrayBuffer + wasm threads). Mirrors the production
// vercel.json header pair, but uses require-corp (all assets are same-origin).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('.', import.meta.url).pathname;
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
    const urlPath = decodeURIComponent(new URL(req.url, `http://localhost`).pathname);
    const rel = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^(\.\.[/\\])+/, '');
    const file = join(ROOT, rel);
    const body = await readFile(file);
    res.setHeader('Content-Type', TYPES[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch (e) {
    res.statusCode = 404;
    res.end('not found: ' + e.message);
  }
}).listen(PORT, () => console.log(`serving ${ROOT} on http://localhost:${PORT} (COOP/COEP on)`));
