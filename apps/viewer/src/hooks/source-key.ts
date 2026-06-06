/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';

// Per-source-object memo so the full-content hash runs only once per loaded
// buffer (the same Uint8Array instance is reused across re-renders).
const SOURCE_KEY_CACHE = new WeakMap<Uint8Array, string>();

/**
 * Stable per-source cache key — a **full-content** FNV-1a hash (not sampled
 * byte windows), so two distinct IFC binaries can't collide and reuse the wrong
 * cache entry (which would render another model's overlay). The O(n) hash is
 * memoised per source object via a WeakMap, so it runs once per loaded buffer.
 *
 * Shared by the per-source overlay hooks (alignment + grid lines) so they stay
 * in lockstep — see #967 review (CodeRabbit aliasing finding applied to both).
 */
export function sourceKey(store: IfcDataStore | null | undefined): string | null {
  const source = store?.source;
  if (!source || source.byteLength === 0) return null;

  const cached = SOURCE_KEY_CACHE.get(source);
  if (cached) return cached;

  let h = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    h ^= source[i];
    h = Math.imul(h, 0x01000193);
  }
  const key = `b${source.byteLength}-${(h >>> 0).toString(16)}`;
  SOURCE_KEY_CACHE.set(source, key);
  return key;
}
