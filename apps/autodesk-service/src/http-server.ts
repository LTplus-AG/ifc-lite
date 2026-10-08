/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createServer } from 'node:http';
import { once } from 'node:events';

export function autodeskHttpServer(origin: string, handler: (request: Request) => Promise<Response>) {
return createServer(async (incoming, outgoing) => {
  const abort = new AbortController();
  outgoing.on('close', () => { if (!outgoing.writableEnded) abort.abort(); });
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (typeof value === 'string') headers.set(key, value);
      else if (value) headers.set(key, value.join(', '));
    }
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of incoming) {
      const bytes: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > 64_000) { outgoing.writeHead(413); outgoing.end('Request too large'); return; }
      chunks.push(bytes);
    }
    const request = new Request(new URL(incoming.url ?? '/', origin), {
      method: incoming.method, headers, signal: abort.signal,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    const response = await handler(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (!outgoing.write(chunk.value)) await once(outgoing, 'drain', { signal: abort.signal });
        }
        outgoing.end();
      } finally { await reader.cancel(); reader.releaseLock(); }
    } else outgoing.end();
  } catch (error) {
    console.error('Autodesk HTTP adapter failed', error instanceof Error ? error.name : 'Unknown error');
    if (!outgoing.headersSent) outgoing.writeHead(500, { 'Cache-Control': 'no-store' });
    outgoing.end();
  }
});
}
