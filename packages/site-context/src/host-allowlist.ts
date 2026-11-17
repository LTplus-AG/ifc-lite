/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The only hosts site context may contact: swisstopo's public services. A URL
 * on any other host is refused before anything is sent. That covers a moved
 * STAC asset, a tileset whose content URIs point elsewhere, or a link in a
 * response body. Redirects are not followed at all (`redirect: 'error'`), so
 * a response cannot move the request to another host either. The CLI and the
 * viewer both fetch through this.
 */

import type { FetchLike } from '@ifc-lite/geodata-ch';

/**
 * api3 (search, parcels, ÖREB register), data (STAC + COG tiles), wms and wmts
 * (imagery), and 3d (swissBUILDINGS3D 3D Tiles: the root tileset, its
 * sub-tilesets and b3dm content all live there).
 */
export const SWISSTOPO_HOSTS: readonly string[] = [
  'api3.geo.admin.ch', 'data.geo.admin.ch', 'wms.geo.admin.ch', 'wmts.geo.admin.ch', '3d.geo.admin.ch',
];

export class SiteContextHostRefused extends Error {
  constructor(readonly url: string) {
    super(`Site context only contacts swisstopo's services (geo.admin.ch); refused ${url}`);
    this.name = 'SiteContextHostRefused';
  }
}

/** True for an https URL, on the default port, on a swisstopo host site context may contact. */
export function isAllowedSwisstopoUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    console.warn('[site-context] unparsable URL refused:', url, error);
    return false;
  }
  return parsed.protocol === 'https:' && parsed.port === '' && SWISSTOPO_HOSTS.includes(parsed.hostname);
}

/**
 * Wrap `inner` so it refuses every URL off the swisstopo hosts and never
 * follows a redirect. No credentials or referrer are sent. The result fits
 * both `@ifc-lite/geodata-ch`'s and `@ifc-lite/tiles3d`'s fetch option.
 */
export function swisstopoOnlyFetch(inner: FetchLike = (input, init) => globalThis.fetch(input, init)): FetchLike {
  return async (input, init) => {
    if (!isAllowedSwisstopoUrl(input)) throw new SiteContextHostRefused(input);
    return inner(input, { ...init, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' });
  };
}
