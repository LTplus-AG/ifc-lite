/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Node HTTPS adapter. Semantic relay policy itself remains shared in server.ts. */
import { createServer, type ServerOptions, type Server } from 'node:https';
import { Readable } from 'node:stream';
import { createSemanticRelay, type RelayOptions } from './server.js';
export function createSemanticRelayServer(options: RelayOptions, tls: Pick<ServerOptions, 'cert' | 'key'>): Server {
  if (!tls.cert || !tls.key) throw new Error('Relay requires a TLS certificate and private key');
  const handle = createSemanticRelay(options);
  const server = createServer(tls, async (incoming, outgoing) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    incoming.once('aborted', abort); outgoing.once('close', abort);
    try {
      const headers = new Headers();
      for (const [name, values] of Object.entries(incoming.headers)) {
        for (const value of Array.isArray(values) ? values : values === undefined ? [] : [values]) headers.append(name, value);
      }
      const init: RequestInit & { duplex?: 'half' } = { method: incoming.method, headers, signal: controller.signal };
      if (!['GET', 'HEAD'].includes(incoming.method ?? 'GET')) {
        init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>; init.duplex = 'half';
      }
      const response = await handle(new Request(new URL(incoming.url ?? '/', 'https://relay.invalid'), init));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      outgoing.end('{"error":"Relay request failed"}');
    } finally { incoming.removeListener('aborted', abort); outgoing.removeListener('close', abort); }
  });
  server.requestTimeout = (options.timeoutMs ?? 15000) + 1000;
  server.headersTimeout = Math.min(server.requestTimeout, 10000);
  return server;
}
