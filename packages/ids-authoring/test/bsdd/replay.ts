/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Offline replay of recorded bSDD API responses (`recorded-responses.json`).
 * Tests never touch the network: a request with no recording fails the
 * test, and `offlineFetch` simulates a dead connection.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHttpBsddSource } from '../../src/bsdd/http-source.js';
import type { BsddSource } from '../../src/bsdd/types.js';

interface Recorded {
  path: string;
  query: Record<string, string>;
  status: number;
  body: unknown;
}

const FILE = fileURLToPath(new URL('./recorded-responses.json', import.meta.url));
const RECORDED: Recorded[] = (JSON.parse(readFileSync(FILE, 'utf8')) as { responses: Recorded[] }).responses;

export const DEMO = 'https://identifier.example.org/uri/ifc-lite-test/demo/1.0';
export const DEMO_V2 = 'https://identifier.example.org/uri/ifc-lite-test/demo/2.0';
export const demoClass = (code: string): string => `${DEMO}/class/${code}`;
export const demoProp = (code: string): string => `${DEMO}/prop/${code}`;

function sameQuery(a: URLSearchParams, b: Record<string, string>): boolean {
  const keys = new Set(a.keys());
  if (keys.size !== Object.keys(b).length) return false;
  return Object.entries(b).every(([k, v]) => a.getAll(k).length === 1 && a.get(k) === v);
}

export interface Replay {
  fetch: typeof fetch;
  /** Requests made, as `path?query`. */
  readonly requests: string[];
}

/** A `fetch` that answers from the recordings and throws on anything unrecorded. */
export function replayFetch(): Replay {
  const requests: string[] = [];
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://replay.invalid');
    const path = url.pathname.replace(/^\/api\/bsdd/, ''); // the viewer's same-origin proxy prefix
    requests.push(`${path}?${url.searchParams.toString()}`);
    const hit = RECORDED.find((r) => r.path === path && sameQuery(url.searchParams, r.query));
    if (!hit) throw new Error(`unrecorded bSDD request ${path}?${url.searchParams.toString()}`);
    return new Response(JSON.stringify(hit.body), { status: hit.status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch: impl, requests };
}

/** A `fetch` for a machine with no connection. */
export const offlineFetch: typeof fetch = async () => {
  throw new TypeError('fetch failed (offline)');
};

/** An HTTP source over the recordings (`apiBase` is irrelevant offline). */
export function demoSource(replay: Replay = replayFetch(), now = () => 1_700_000_000_000): BsddSource {
  return createHttpBsddSource({ apiBase: '/api/bsdd', fetch: replay.fetch, now });
}
