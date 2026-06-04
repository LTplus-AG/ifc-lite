/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Model length-unit → metres scale, memoised per `IfcDataStore`.
 *
 * The viewer's render + authoring space is **metres**: the geometry
 * pipeline bakes the file's length-unit scale into tessellated vertices,
 * raycast hit-points come back in metres, and `spatialHierarchy.
 * storeyElevations` are pre-scaled. But raw coordinate reads straight off
 * the STEP model — split footprints, placement chains — arrive in the
 * file's **native** units (e.g. millimetres). Multiply those by this
 * factor to bring them into the same metre space as everything else.
 *
 * Returns `1` when the scale can't be determined (already-metres models,
 * or bounded-geometry mode having released the source buffer) — the
 * safe identity that leaves native-unit reads untouched.
 */

import { extractLengthUnitScale, type IfcDataStore } from '@ifc-lite/parser';

const scaleCache = new WeakMap<IfcDataStore, number>();

export function getModelLengthUnitScale(dataStore: IfcDataStore | null | undefined): number {
  if (!dataStore) return 1;
  const cached = scaleCache.get(dataStore);
  if (cached !== undefined) return cached;

  // The columnar parser stashes the scale on the store; the wasm fast
  // path does not, so fall back to extracting it from the source bytes.
  let scale = typeof dataStore.lengthUnitScale === 'number' ? dataStore.lengthUnitScale : undefined;
  if (scale === undefined || !Number.isFinite(scale) || scale <= 0) {
    if (!dataStore.source?.length || !dataStore.entityIndex) return 1;
    scale = extractLengthUnitScale(dataStore.source, dataStore.entityIndex);
  }
  if (!Number.isFinite(scale) || scale <= 0) scale = 1;

  scaleCache.set(dataStore, scale);
  return scale;
}
