/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Minimal HTTP client helpers for the viewer server tests.
 *
 * Every socket these helpers open is registered in a module-level set and
 * every request carries its own deadline. That matters here: the server
 * under test holds SSE responses open forever, so a single leaked socket
 * keeps the `node:http` server handle alive and `server.close()` never
 * completes — the test run would hang instead of failing. `destroyAllSockets`
 * is the belt-and-braces cleanup that runs from an `after` hook even when an
 * assertion has already thrown.
 */

import { request as httpRequest, type IncomingMessage, type ClientRequest } from 'node:http';

/** Per-request deadline. Long enough for a slow CI box, short enough to fail fast. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** Deadline handed to `it(...)` for anything that touches a socket. */
export const TEST_TIMEOUT = { timeout: 30_000 } as const;

const openRequests = new Set<ClientRequest>();

export interface Res {
  status: number;
  headers: NodeJS.Dict<string | string[]>;
  body: Buffer;
}

export interface ReqOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Issue one request on its own socket (`agent: false`), so closing the
 * server actually releases the port instead of waiting on a pooled
 * keep-alive connection.
 */
export function req(port: number, path: string, opts: ReqOptions = {}): Promise<Res> {
  return new Promise((resolvePromise, reject) => {
    const r = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: opts.method ?? 'GET',
        headers: opts.headers,
        agent: false,
      },
      (resp: IncomingMessage) => {
        const chunks: Buffer[] = [];
        resp.on('data', (c: Buffer) => chunks.push(c));
        resp.on('end', () => {
          openRequests.delete(r);
          resolvePromise({
            status: resp.statusCode ?? 0,
            headers: resp.headers,
            body: Buffer.concat(chunks),
          });
        });
        resp.on('error', (e) => {
          openRequests.delete(r);
          reject(e);
        });
      },
    );
    openRequests.add(r);
    r.setTimeout(REQUEST_TIMEOUT_MS, () => {
      r.destroy(new Error(`request to ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });
    r.on('error', (e) => {
      openRequests.delete(r);
      reject(e);
    });
    if (opts.body !== undefined) r.write(opts.body);
    r.end();
  });
}

/** `req` plus a JSON-parsed body. */
export async function json(
  port: number,
  path: string,
  opts?: ReqOptions,
): Promise<{ status: number; headers: NodeJS.Dict<string | string[]>; json: any }> {
  const res = await req(port, path, opts);
  return { status: res.status, headers: res.headers, json: JSON.parse(res.body.toString()) };
}

/**
 * Open a streaming request (SSE) and resolve once the response head arrives.
 * The returned `close` MUST be called from a `finally` — see the module note.
 */
export function openStream(
  port: number,
  path: string,
): Promise<{ res: IncomingMessage; close: () => void }> {
  return new Promise((resolvePromise, reject) => {
    const r = httpRequest({ host: '127.0.0.1', port, path, agent: false }, (resp) => {
      resolvePromise({
        res: resp,
        close: () => {
          openRequests.delete(r);
          r.destroy();
          resp.destroy();
        },
      });
    });
    openRequests.add(r);
    r.setTimeout(REQUEST_TIMEOUT_MS, () => {
      r.destroy(new Error(`stream ${path} produced no response head in ${REQUEST_TIMEOUT_MS}ms`));
    });
    r.on('error', (e) => {
      openRequests.delete(r);
      reject(e);
    });
    r.end();
  });
}

/** Tear down anything still open. Safe to call more than once. */
export function destroyAllSockets(): void {
  for (const r of openRequests) r.destroy();
  openRequests.clear();
}

/** Poll `predicate` up to `ms`, then give up. Never throws. */
export async function poll(predicate: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
