/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The query string every parse-family request carries.
 *
 * Its own module because it encodes a SAFETY contract, not just formatting.
 * `flatLayout` opts this client in to the server's shared-shape flat Parquet
 * layout (issue #3888): the server produces the older layout unless asked,
 * because the shared one renders wrong on a decoder that ignores its
 * `rot0..rot8` columns and the flat wire has no version marker such a decoder
 * could reject. This version's decoder applies them, so it opts in.
 *
 * The two layouts are cached under separate server-side keys, which is why the
 * signal has to go on EVERY endpoint touching that cache — both parse routes,
 * the cache check and the cached-geometry fetch. One that forgets it asks about
 * the other entry. Pinned by `parquet-layout-signal.test.ts`.
 */

import type { ParseRequestOptions } from './client.js';

export function parseQuery(options?: ParseRequestOptions, flatLayout = false): string {
  const params = new URLSearchParams();
  if (options?.tessellationQuality && options.tessellationQuality !== 'medium') {
    params.set('tessellation_quality', options.tessellationQuality);
  }
  if (flatLayout) {
    params.set('parquet_layout', 'shared-shapes');
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}
