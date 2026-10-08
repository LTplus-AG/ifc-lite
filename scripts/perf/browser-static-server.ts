/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Static server for a production viewer build (`apps/viewer/dist`), shared by
 * the browser perf harnesses (browser-cold-ab, frame-gpu-rig). It sends the
 * same cross-origin-isolation headers `vite preview` does, `no-store` so a
 * swapped root is never served from cache, and reads the root through a
 * getter so base and branch builds alternate without a restart.
 *
 * `extra` maps exact request paths to files outside the root: a model served
 * same-origin for `?model=/<path>` without symlinking it into a build.
 */

import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { browserStaticPath } from './browser-cold-server-path.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

export interface StaticServerOptions {
  /** 0 lets the OS pick; read it back from `server.address()`. */
  port: number;
  /** Interface to bind; omit for all (the historical browser-cold-ab behaviour). */
  host?: string;
  root: () => string;
  extra?: ReadonlyMap<string, string>;
}

export async function startStaticServer({ port, host, root, extra }: StaticServerOptions): Promise<Server> {
  const server = createServer((req, res) => {
    const pathname = (req.url ?? '/').split('?')[0];
    const filePath = extra?.get(pathname) ?? browserStaticPath(root(), req.url ?? '/');
    if (filePath === null) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    });
    createReadStream(filePath).pipe(res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    if (host) server.listen(port, host, resolve);
    else server.listen(port, resolve);
  });
  return server;
}
