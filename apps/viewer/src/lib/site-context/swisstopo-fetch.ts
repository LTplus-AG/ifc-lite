/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The only `fetch` the site-context client gets: requests go straight from
 * the browser to swisstopo's public services (owner's decision: no proxy),
 * and only to those. A URL on any other host (a STAC asset that moved, a
 * redirect in a response body) is refused before it leaves the browser, so
 * loading site context can never contact a third party. The services send
 * `Access-Control-Allow-Origin: *`, Range included (checked 2026-11-15).
 */

import type { FetchLike } from '@ifc-lite/geodata-ch';

/** api3 (search, parcels, ÖREB register), data (STAC + COG tiles), wms and wmts (imagery). */
const ALLOWED_HOSTS = new Set(['api3.geo.admin.ch', 'data.geo.admin.ch', 'wms.geo.admin.ch', 'wmts.geo.admin.ch']);

export class SiteContextHostRefused extends Error {
  constructor(readonly url: string) {
    super(`Site context only contacts swisstopo's services (geo.admin.ch); refused ${url}`);
    this.name = 'SiteContextHostRefused';
  }
}

/** True for an https URL on a swisstopo host the site context may contact. */
export function isAllowedSwisstopoUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    console.warn('[site-context] unparsable URL refused:', url, error);
    return false;
  }
  return parsed.protocol === 'https:' && parsed.port === '' && ALLOWED_HOSTS.has(parsed.hostname);
}

export interface CountingFetch {
  fetch: FetchLike;
  /** Bytes of response bodies received over the network (cache hits never reach here). */
  readonly bytes: number;
}

/**
 * Wrap `inner` so it refuses non-swisstopo URLs and counts bytes received. A
 * redirect is not followed to another host either: `redirect: 'error'` makes
 * the browser fail it rather than follow it silently.
 */
export function swisstopoFetch(inner: FetchLike = (input, init) => globalThis.fetch(input, init)): CountingFetch {
  let bytes = 0;
  return {
    get bytes() { return bytes; },
    fetch: async (input, init) => {
      if (!isAllowedSwisstopoUrl(input)) throw new SiteContextHostRefused(input);
      const response = await inner(input, { ...init, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' });
      const body = await response.arrayBuffer();
      bytes += body.byteLength;
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    },
  };
}
