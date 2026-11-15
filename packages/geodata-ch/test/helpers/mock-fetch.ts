/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { HttpClient } from '../../src/http.js';

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8')) as T;
}

export type Route = (url: URL, init: RequestInit | undefined) => Response | undefined;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Serve `bytes=a-b` ranges of a buffer the way a COG host does. */
export function rangeResponse(buf: ArrayBuffer, init: RequestInit | undefined): Response {
  const range = (init?.headers as Record<string, string> | undefined)?.Range;
  const m = range ? /bytes=(\d+)-(\d+)?/.exec(range) : null;
  if (!m) return new Response(buf, { status: 200, headers: { 'content-length': String(buf.byteLength) } });
  const start = Number(m[1]);
  const end = Math.min(m[2] !== undefined ? Number(m[2]) : buf.byteLength - 1, buf.byteLength - 1);
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: { 'content-range': `bytes ${start}-${end}/${buf.byteLength}` },
  });
}

/** A fetch that answers from routes and records every URL; unrouted URLs fail the test loudly. */
export function mockFetch(...routes: Route[]): { fetch: (u: string, i?: RequestInit) => Promise<Response>; calls: URL[] } {
  const calls: URL[] = [];
  return {
    calls,
    fetch: async (u: string, init?: RequestInit) => {
      const url = new URL(u);
      calls.push(url);
      for (const r of routes) {
        const res = r(url, init);
        if (res) return res;
      }
      throw new Error(`unrouted request in test: ${u}`);
    },
  };
}

/** An HttpClient with no real waiting. */
export function testClient(fetchImpl: (u: string, i?: RequestInit) => Promise<Response>): HttpClient {
  return new HttpClient({ fetch: fetchImpl, sleep: async () => {}, random: () => 0 });
}
