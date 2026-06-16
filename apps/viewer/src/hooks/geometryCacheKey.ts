/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { FORMAT_VERSION } from '@ifc-lite/cache';

/**
 * Build the persisted geometry cache key for a loaded model.
 *
 * The key folds together everything that changes the *bytes* of the cached
 * geometry so a stale entry can never be served for a different input:
 *   - `byteLength` + `fingerprint`: identify the source file content
 *   - `FORMAT_VERSION`: a format bump invalidates incompatible entries
 *   - `mergeLayers`: the multi-layer-wall merge flag is a load-time WASM
 *     tessellation input (issue #540). It was previously absent from the key,
 *     so toggling it and reloading served geometry built with the *previous*
 *     flag — the toggle silently no-op'd until the model was re-imported
 *     (issue #1107). Including it makes a toggle+reload a cache miss that
 *     re-tessellates with the new flag.
 *
 * The `mergeLayers` discriminator is omitted when false so pre-existing
 * cache entries (the default is off) stay valid — only the opt-in `true`
 * path gets a distinct key.
 *
 * The desktop (Tauri) cache backend only accepts `[A-Za-z0-9_-]`, so the key
 * stays filename-safe and independent of the original filename.
 */
export function buildGeometryCacheKey(
  byteLength: number,
  fingerprint: string,
  mergeLayers: boolean,
  formatVersion: number | string = FORMAT_VERSION
): string {
  return `ifc-${byteLength}-${fingerprint}-v${formatVersion}${mergeLayers ? '-ml' : ''}`;
}
