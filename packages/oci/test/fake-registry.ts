/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A real HTTP registry for the tests: `node:http` servers on 127.0.0.1:0.
// Each records what it received, so tests assert on the wire (which headers
// reached which origin), not on the client's internals.

import { createHash } from 'node:crypto';
import * as http from 'node:http';

export interface Recorded {
  method: string;
  /** Path plus query, as received. */
  url: string;
  authorization?: string;
  accept?: string;
  contentType?: string;
}

export interface FakeServer {
  origin: string;
  /** `127.0.0.1:<port>`. */
  host: string;
  requests: Recorded[];
  close(): Promise<void>;
}

export type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>;

const open: FakeServer[] = [];

export function startServer(handler: Handler): Promise<FakeServer> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const record: Recorded = { method: req.method ?? '', url: req.url ?? '' };
    if (typeof req.headers.authorization === 'string') record.authorization = req.headers.authorization;
    if (typeof req.headers.accept === 'string') record.accept = req.headers.accept;
    if (typeof req.headers['content-type'] === 'string') record.contentType = req.headers['content-type'];
    requests.push(record);
    Promise.resolve(handler(req, res)).catch((err: unknown) => {
      res.destroy(err instanceof Error ? err : new Error(String(err)));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      const fake: FakeServer = {
        origin: `http://127.0.0.1:${port}`,
        host: `127.0.0.1:${port}`,
        requests,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      };
      open.push(fake);
      resolve(fake);
    });
  });
}

/** Closes every server started since the last call (use in `afterEach`). */
export async function closeAll(): Promise<void> {
  const all = open.splice(0);
  await Promise.all(all.map((s) => s.close()));
}

export interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

export function send(res: http.ServerResponse, reply: Reply): void {
  const body = reply.body ?? '';
  const bytes = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
  res.writeHead(reply.status ?? 200, { 'content-length': String(bytes.length), ...reply.headers });
  res.end(bytes);
}

/**
 * A registry: requests whose `Authorization` fails `accept` get a 401 with
 * `challenge` (or a 403 when `accept` returns 'deny'); the rest are routed by
 * path (query stripped unless the route key contains `?`).
 */
export function registry(options: {
  challenge?: string;
  accept?: (authorization: string | undefined) => boolean | 'deny';
  routes: Record<string, Reply | ((req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>)>;
}): Handler {
  return async (req, res) => {
    const auth = req.headers.authorization;
    if (options.accept) {
      const verdict = options.accept(auth);
      if (verdict === 'deny') return send(res, { status: 403, body: '{"errors":[{"code":"DENIED"}]}' });
      if (!verdict) {
        return send(res, {
          status: 401,
          headers: options.challenge ? { 'www-authenticate': options.challenge } : {},
          body: '{"errors":[{"code":"UNAUTHORIZED"}]}',
        });
      }
    }
    const url = req.url ?? '';
    const route = options.routes[url] ?? options.routes[url.split('?')[0]];
    if (!route) return send(res, { status: 404, body: '{"errors":[{"code":"NAME_UNKNOWN"}]}' });
    if (typeof route === 'function') return route(req, res);
    return send(res, route);
  };
}

/** A token realm that answers every request with `reply` as JSON. */
export function tokenRealm(reply: Record<string, unknown> | ((req: http.IncomingMessage) => Record<string, unknown>)): Handler {
  return (req, res) => {
    const body = typeof reply === 'function' ? reply(req) : reply;
    send(res, { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  };
}

export function sha256(bytes: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

/** Query parameters of a recorded request. */
export function query(record: Recorded): URLSearchParams {
  return new URL(record.url, 'http://x').searchParams;
}
