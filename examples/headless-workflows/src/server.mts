/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createServer } from 'node:http';
import { queryDoors } from './worker-client.mjs';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_REQUESTS = 2;
let activeRequests = 0;
let activeWorkers = 0;
const server = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json');
  if (request.method === 'GET' && request.url === '/health') {
    response.end(JSON.stringify({ activeRequests, activeWorkers }));
    return;
  }
  if (request.method !== 'POST' || request.url !== '/doors') {
    response.writeHead(404).end(JSON.stringify({ error: 'Use POST /doors with IFC bytes' }));
    return;
  }
  if (activeRequests >= MAX_REQUESTS) {
    request.resume();
    response.writeHead(503).end(JSON.stringify({ error: 'The worker budget is full' }));
    return;
  }
  activeRequests++;
  const disconnect = new AbortController();
  const aborted = () => disconnect.abort(new DOMException('Client disconnected', 'AbortError'));
  request.once('aborted', aborted);
  response.once('close', () => { if (!response.writableEnded) aborted(); });
  const signal = AbortSignal.any([disconnect.signal, AbortSignal.timeout(30000)]);
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      signal.throwIfAborted();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > MAX_BYTES) {
        response.writeHead(413).end(JSON.stringify({ error: 'Input exceeds 16 MiB' }));
        request.resume();
        return;
      }
      chunks.push(bytes);
    }
    const result = await queryDoors(Buffer.concat(chunks, total), signal, delta => { activeWorkers += delta; });
    if (!response.destroyed) response.writeHead(result.ok ? 200 : 400).end(JSON.stringify(result));
  } catch (error) {
    if (!signal.aborted) console.error(error);
    if (!response.destroyed) response.writeHead(signal.aborted ? 504 : 500).end(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }));
  } finally {
    request.off('aborted', aborted);
    activeRequests--;
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.listen(Number(process.env.PORT ?? 3001), '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP listener address');
  console.log(`http://127.0.0.1:${address.port}`);
});
