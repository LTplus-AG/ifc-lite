/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';

/**
 * Stable per-source cache key.
 *
 * This used to be a full-content FNV-1a walk over the whole buffer, memoised
 * in a WeakMap keyed on the source object. `IfcSourceBytes.contentKey` is that
 * same hash, computed lazily and cached on the source itself, so the walk and
 * the memo both live in one place now (#2183) — and a compressed source can
 * carry the key forward across the swap instead of having every consumer
 * recompute it from bytes it no longer holds contiguously.
 *
 * Still full-content rather than sampled: two distinct IFC binaries must not
 * collide and reuse each other's cache entry, which would render another
 * model's overlay.
 *
 * Shared by the per-source overlay hooks (alignment + grid lines) so they stay
 * in lockstep — see #967 review.
 */
export function sourceKey(store: IfcDataStore | null | undefined): string | null {
  return store?.source.contentKey ?? null;
}
