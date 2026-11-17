#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Local rehearsal host for a build-retained-preview.mjs output: serves
// `<dir>/public` with the headers and rewrites of `<dir>/vercel.json` (file
// first, then rewrites, else 404; header rules apply to every response,
// errors included). It lets smoke-retained-preview.mjs prove the exact
// artifact and config locally before anything is published; it is not the
// hosted platform, so the URL smoke still has to run against the real preview.
//
//   node scripts/serve-retained-preview.mjs --dir /abs/preview [--port 4380] [--host 127.0.0.1]
//
// --production serves a production-shaped checkout instead (#7955): `--dir` is the
// repository root, so its own vercel.json and `outputDirectory` (apps/viewer/dist)
// apply. Rewrites that proxy to other hosts or use named parameters (/api/*) are
// skipped, and files with no Content-Type rule get the type a static host infers.

import { createServer } from 'node:http';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { isMainEntry } from './lib/is-main-entry.mjs';
import { headersFor, rewriteFor } from './lib/retained-preview.mjs';

/** What a static host infers when no header rule sets a type (only consulted with `production`). */
const INFERRED_TYPES = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };

export function createPreviewServer(dir, { production = false } = {}) {
  let config = JSON.parse(readFileSync(join(dir, 'vercel.json'), 'utf8'));
  if (production) {
    config = { ...config, rewrites: (config.rewrites ?? []).filter(rule => !/:[A-Za-z]/.test(rule.source) && rule.destination.startsWith('/')) };
  }
  const root = realpathSync(join(dir, config.outputDirectory));
  const fileFor = pathname => {
    const candidate = join(root, pathname);
    try {
      const real = realpathSync(candidate), delta = relative(root, real);
      if (delta.startsWith('..') || isAbsolute(delta) || !statSync(real).isFile()) return null;
      return real;
    } catch { return null; }
  };
  return createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname); }
    catch { res.statusCode = 400; res.end(); return; }
    for (const [key, value] of Object.entries(headersFor(config, pathname))) res.setHeader(key, value);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; res.end(); return; }
    let file = pathname.split('/').some(p => p === '..') ? null : fileFor(pathname === '/' ? '/index.html' : pathname);
    if (!file) {
      const destination = rewriteFor(config, pathname);
      file = destination ? fileFor(destination) : null;
      // A rewritten response takes the destination's headers on top (as the host does for the served file).
      if (file) for (const [key, value] of Object.entries(headersFor(config, destination))) res.setHeader(key, value);
    }
    if (!file) { res.statusCode = 404; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end('Not found\n'); return; }
    const inferred = production ? INFERRED_TYPES[file.slice(file.lastIndexOf('.'))] : undefined;
    if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : inferred ?? 'application/octet-stream');
    const bytes = readFileSync(file);
    res.setHeader('Content-Length', bytes.byteLength);
    res.end(req.method === 'HEAD' ? undefined : bytes);
  });
}

if (isMainEntry(import.meta.url)) {
  const args = process.argv.slice(2), get = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
  const dir = get('--dir');
  if (!dir || !isAbsolute(dir)) { console.error('Usage: node scripts/serve-retained-preview.mjs --dir ABS [--port 4380] [--host 127.0.0.1] [--production]'); process.exit(1); }
  const port = Number(get('--port', 4380)), host = get('--host', '127.0.0.1');
  const production = args.includes('--production');
  createPreviewServer(dir, { production }).listen(port, host, () => console.log(`retained ${production ? 'production-shaped' : 'preview'} host at http://${host}:${port}/`));
}
