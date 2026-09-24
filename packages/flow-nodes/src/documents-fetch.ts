/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `fetchFn` every `documents.*` node hands `DocumentsApiClient`: it
 * routes each request through `@ifc-lite/sandbox`'s `coreNetworkRequest`,
 * so the https-only / exact-host-grant / no-redirect / byte-cap policy is
 * the same one `http.request` and `bim.network.fetch` run, checked against
 * `ctx.host.networkGrants` BEFORE `ctx.host.networkTransport` is called.
 * The client never sees a bare `fetch`.
 *
 * The body always comes back as bytes (`responseType: 'bytes'`), so a
 * binary download is not mangled by a UTF-8 decode; a JSON answer is
 * decoded by the client's own `response.json()`. A body that hit the byte
 * cap is an error, never a silently short file or a truncated JSON.
 */

import type { FetchLike } from '@ifc-lite/documents-api';
import { coreNetworkRequest, NetworkDeniedError } from '@ifc-lite/sandbox';
import type { Ctx } from './host.js';

export interface GatedFetchOptions {
  readonly timeoutMs: number;
  readonly maxBytes: number;
  /** Node type, prefixed to a denial so the run log says which node was refused. */
  readonly label: string;
}

/** Statuses whose `Response` may not carry a body (the constructor throws otherwise). */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export function gatedFetch(ctx: Ctx, options: GatedFetchOptions): FetchLike {
  return async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') throw new Error(`${options.label}: ${method} requests are not supported`);
    if (init?.body !== undefined && init.body !== null && typeof init.body !== 'string') {
      throw new Error(`${options.label}: only text request bodies are supported`);
    }
    let res;
    try {
      res = await coreNetworkRequest(
        {
          url,
          method,
          headers: headerRecord(init?.headers),
          body: init?.body ?? undefined,
          timeoutMs: options.timeoutMs,
          maxBytes: options.maxBytes,
          signal: ctx.signal,
          responseType: 'bytes',
        },
        ctx.host.networkGrants ?? [],
        ctx.host.networkTransport,
      );
    } catch (err) {
      if (err instanceof NetworkDeniedError) throw new Error(`${options.label}: ${err.message}`);
      throw err;
    }
    if (res.truncated) {
      throw new Error(`${options.label}: the response from ${url} exceeded maxBytes (${options.maxBytes}); raise maxBytes to accept it`);
    }
    const body = NULL_BODY_STATUSES.has(res.status) ? null : (res.bytes ?? new Uint8Array(0));
    return new Response(body, { status: res.status, headers: res.headers });
  };
}
