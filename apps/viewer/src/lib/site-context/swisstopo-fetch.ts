/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The only `fetch` the site-context client gets: requests go straight from
 * the browser to swisstopo's public services (no proxy), and only to those,
 * through `@ifc-lite/site-context`'s host allowlist. A URL on any other host
 * (a STAC asset that moved, a redirect) is refused before it leaves the
 * browser, so loading site context can never contact a third party. The
 * services send `Access-Control-Allow-Origin: *`, Range included (checked
 * 2026-11-15).
 */

import type { FetchLike } from '@ifc-lite/geodata-ch';
import { swisstopoOnlyFetch } from '@ifc-lite/site-context';

export interface CountingFetch {
  fetch: FetchLike;
  /** Requests sent over the network through this fetch (cache hits never reach here). */
  readonly requests: number;
  /** Bytes of response bodies received over the network. */
  readonly bytes: number;
}

/**
 * Wrap `inner` in `@ifc-lite/site-context`'s swisstopo allowlist (the same one
 * the CLI uses: other hosts refused before sending, redirects refused, no
 * credentials or referrer) and count requests and bytes received.
 */
export function swisstopoFetch(inner: FetchLike = (input, init) => globalThis.fetch(input, init)): CountingFetch {
  let bytes = 0;
  let requests = 0;
  const guarded = swisstopoOnlyFetch(async (input, init) => {
    requests += 1;
    return inner(input, init);
  });
  return {
    get bytes() { return bytes; },
    get requests() { return requests; },
    fetch: async (input, init) => {
      const response = await guarded(input, init);
      const body = await response.arrayBuffer();
      bytes += body.byteLength;
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    },
  };
}
