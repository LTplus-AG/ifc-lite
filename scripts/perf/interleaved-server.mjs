/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { resolve, extname } from 'node:path';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2' };

export async function serveFrozen(root, files) {
  const allowed = new Map(files.map(file => [file.path, file]));
  const requests = [];
  const sockets = new Set();
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      let path = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (!path) path = 'index.html';
      const asset = allowed.get(path);
      if (!asset || !['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(404).end('Frozen asset absent'); return;
      }
      const absolute = resolve(root, path);
      if (!absolute.startsWith(`${resolve(root)}/`) || statSync(absolute).size !== asset.size) {
        throw new Error('Frozen asset path or size changed');
      }
      // Isolated origin preserves the production default SAB/sharded path.
      response.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream',
        'Content-Length': asset.size, 'Cache-Control': 'no-store',
        'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin' });
      requests.push({ path, status: 200, sha256: asset.sha256, at: Date.now() });
      if (request.method === 'HEAD') response.end();
      else createReadStream(absolute).on('error', error => { console.error(error); response.destroy(error); }).pipe(response);
    } catch (error) {
      console.error(error);
      requests.push({ status: 500, error: String(error), at: Date.now() });
      if (!response.headersSent) response.writeHead(500);
      response.end('Frozen asset refusal');
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolveReady, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveReady); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, requests, close: (timeoutMs = 30_000) => new Promise(resolveClosed => {
    let done = false;
    const finish = receipt => { if (!done) { done = true; clearTimeout(timer); resolveClosed(receipt); } };
    const timer = setTimeout(() => {
      const destroyedSockets = sockets.size;
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      finish({ status: 'refused', reason: 'Owned server close deadline', destroyedSockets,
        remainingSockets: [...sockets].filter(socket => !socket.destroyed).length });
    }, timeoutMs);
    server.close(error => finish({ status: error ? 'refused' : 'complete', reason: error ? String(error) : null,
      remainingSockets: [...sockets].filter(socket => !socket.destroyed).length }));
    server.closeIdleConnections();
  }) };
}
