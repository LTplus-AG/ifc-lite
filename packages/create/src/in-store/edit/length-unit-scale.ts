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
 * Bounded geometry without retained source uses identity when no validated
 * scale is cached. Retained source uses the builders' validated extraction;
 * an unreliable extraction refuses the edit rather than guessing units.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { safeLengthUnitScale } from '../length-unit-scale.js';
import { fromNativeLength, toNativeLength } from '../anchor.js';

type Vec3 = [number, number, number];

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
    const extracted = safeLengthUnitScale(dataStore.source, dataStore.entityIndex,
      'getModelLengthUnitScale', dataStore.spatialHierarchy?.project?.expressId);
    if (extracted === null) throw new Error('Cannot edit geometry without a reliable model length unit scale');
    scale = extracted;
  }

  scaleCache.set(dataStore, scale);
  return scale;
}

/** A native-unit STEP point in metres (#6233). Rounded like `fromNativeLength`. */
export function pointToMetres(dataStore: IfcDataStore, point: readonly number[]): Vec3 {
  const unit = { lengthUnitScale: getModelLengthUnitScale(dataStore) };
  return [fromNativeLength(unit, point[0]), fromNativeLength(unit, point[1]), fromNativeLength(unit, point[2])];
}

/** A metre point in the model's native unit, ready to write to STEP (#6233). */
export function pointToNative(dataStore: IfcDataStore, point: readonly number[]): Vec3 {
  const unit = { lengthUnitScale: getModelLengthUnitScale(dataStore) };
  return [toNativeLength(unit, point[0]), toNativeLength(unit, point[1]), toNativeLength(unit, point[2])];
}
