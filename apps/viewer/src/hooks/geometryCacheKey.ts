/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { FORMAT_VERSION } from '@ifc-lite/cache';

/**
 * Build the persisted geometry cache key for a loaded model.
 *
 * The key folds together everything that changes the *bytes* of the cached
 * geometry so a stale entry can never be served for a different input:
 *   - `byteLength` + `fingerprint`: identify the source file content for LOOKUP.
 *     The fingerprint is the spread-sampled hash from `computeSourceFingerprint`
 *     (head + tail + interior windows + exact length). It is a strong KEY, not a
 *     content validation: being O(1) it never reads the bytes between its sample
 *     windows, so a byte-length-preserving in-place edit in a gap keys the same
 *     entry. That is fine for the source-persisting tier (cached geometry + cached
 *     source are self-consistent); the source-decoupled (mesh-only) tier, which
 *     hydrates against the fresh buffer, validates a hit separately via the mtime
 *     guard + a full-file hash (see `sourceFingerprint.ts` and
 *     `cacheTier.decideMeshOnlyCacheHit`).
 *   - `FORMAT_VERSION`: a format bump invalidates incompatible entries
 *   - `mergeLayers`: the multi-layer-wall merge flag is a load-time WASM
 *     tessellation input (issue #540). It was previously absent from the key,
 *     so toggling it and reloading served geometry built with the *previous*
 *     flag — the toggle silently no-op'd until the model was re-imported
 *     (issue #1107). Including it makes a toggle+reload a cache miss that
 *     re-tessellates with the new flag.
 *   - `skipSmallCuts`: the on-screen load skips tiny detail boolean cuts
 *     (#1286), so its cached geometry differs from a full-cut build. It must
 *     discriminate the key or a skipped display cache would be served where a
 *     full-fidelity build is expected (and vice versa).
 *   - `tessellationTier`: the load-time vertex-density tier (auto-low for heavy
 *     models, or a `?geomTier=` override). A model meshed at `low` has different
 *     bytes than at `medium`, so the tier must discriminate the key or a coarse
 *     preview cache would be served where full density is expected (and vice
 *     versa).
 *
 * The `mergeLayers`, `skipSmallCuts`, and `tessellationTier` discriminators are
 * omitted at their defaults (`false` / `medium`) so pre-existing cache entries
 * stay valid — only the opt-in / non-default paths get a distinct key.
 *
 * The desktop (Tauri) cache backend only accepts `[A-Za-z0-9_-]`, so the key
 * stays filename-safe and independent of the original filename.
 */
export function buildGeometryCacheKey(
  byteLength: number,
  fingerprint: string,
  mergeLayers: boolean,
  formatVersion: number | string = FORMAT_VERSION,
  skipSmallCuts?: boolean,
  tessellationTier?: string
): string {
  const tier = tessellationTier && tessellationTier !== 'medium' ? `-t${tessellationTier}` : '';
  return `ifc-${byteLength}-${fingerprint}-v${formatVersion}${mergeLayers ? '-ml' : ''}${skipSmallCuts ? '-sc' : ''}${tier}`;
}
