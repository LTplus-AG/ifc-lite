/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import type { Connect, Plugin } from 'vite';
import { validateEngine } from '../../../packages/cli/src/retained/engine';

export interface RetainedEngineOptions {
  enabled: boolean;
  directory?: string;
  vercel?: string;
}
const mime: Record<string, string> = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm',
  '.json': 'application/json', '.md': 'text/plain; charset=utf-8',
};

async function middleware(directory?: string): Promise<Connect.NextHandleFunction> {
  const engine = await validateEngine(directory);
  const manifest = JSON.parse(await readFile(join(engine.directory, 'engine-manifest.json'), 'utf8')) as {
    assets: { path: string }[];
  };
  const allowed = new Set(['engine-manifest.json', ...manifest.assets.map(({ path }) => path)]);
  const etag = `"${engine.manifestSha256}"`;
  return async (req, res, next) => {
    const raw = (req.url ?? '').split('?')[0];
    if (!raw.startsWith('/smlib/') && !raw.startsWith('/retained-engine/')) return next();
    // Mirror the app's cross-origin isolation headers (as cesium-assets.ts
    // does) on EVERY response here, errors included: Vite only injects
    // server.headers on its own responses, a module Worker served without COEP
    // is blocked under isolation (net::ERR_BLOCKED_BY_RESPONSE on
    // /smlib/worker.mjs), and a header-less 404 would hide behind that error.
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    try {
      const decoded = decodeURIComponent(raw);
      if (decoded.includes('\\') || decoded.split('/').some(p => p === '.' || p === '..')) {
        res.statusCode = 403; res.end(); return;
      }
      const path = decoded.startsWith('/smlib/') ? decoded.slice(1) : decoded.slice('/retained-engine/'.length);
      if (!allowed.has(path) || (!decoded.startsWith('/smlib/') &&
          !/^(pkg-retained\/|LICENSES\/|engine-manifest\.json$)/.test(path))) {
        res.statusCode = 404; res.end(); return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405; res.setHeader('Allow', 'GET, HEAD'); res.end(); return;
      }
      const file = await realpath(join(engine.directory, path));
      if (relative(engine.directory, file).startsWith('..') || !(await stat(file)).isFile()) {
        res.statusCode = 403; res.end(); return;
      }
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('ETag', etag);
      res.setHeader('Content-Type', mime[extname(file)] ?? 'text/plain; charset=utf-8');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (req.headers['if-none-match']?.split(',').some(value => ['*', etag, `W/${etag}`].includes(value.trim()))) {
        res.statusCode = 304; res.end(); return;
      }
      const bytes = await readFile(file);
      res.setHeader('Content-Length', bytes.byteLength);
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (error instanceof URIError) { res.statusCode = 400; res.end(); return; }
      next(error);
    }
  };
}

/** Local serving only: no copy plugin, emitted assets, service worker or cache. */
export function retainedEngine(options: RetainedEngineOptions): Plugin | false {
  if (!options.enabled) return false;
  if (options.vercel !== undefined) throw new Error('Retained geometry is forbidden in Vercel builds');
  // Validate in configResolved, which Vite awaits BEFORE it creates the
  // watcher, HTTP and WebSocket servers. Throwing from configureServer left
  // those running: a refused `vite dev` printed the error and never exited.
  let serve: Connect.NextHandleFunction | undefined;
  const use = (server: { middlewares: Connect.Server }) => {
    if (!serve) throw new Error('Retained engine middleware was not prepared');
    server.middlewares.use(serve);
  };
  return {
    name: 'viewer-retained-engine',
    enforce: 'pre',
    async configResolved(config) {
      if (config.command === 'serve') serve = await middleware(options.directory);
    },
    configureServer: use,
    configurePreviewServer: use,
    transform(source, id) {
      if (!id.replaceAll('\\', '/').endsWith('/packages/wasm/retained.js')) return;
      // Vite otherwise treats the shared loader's default URL as an asset,
      // including when our call supplies moduleUrl. Keep the shared loader,
      // but make its unused default point to the same HTTP-only engine.
      const original = "new URL('./pkg-retained/ifc-lite.js', import.meta.url)";
      if (!source.includes(original)) throw new Error('Retained loader default URL changed; review asset isolation');
      return { code: source.replace(original, "new URL('/retained-engine/pkg-retained/ifc-lite.js', self.location.origin)"), map: null };
    },
  };
}
