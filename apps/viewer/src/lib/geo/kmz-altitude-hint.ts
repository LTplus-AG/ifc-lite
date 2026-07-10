/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * KMZ altitude-mode hint (#1427 follow-up).
 *
 * The default KMZ placement (clampToGround) pins the model ORIGIN (project
 * zero) to the terrain. Some models bake their vertical datum into geometry Z
 * as absolute MSL elevations (e.g. Swiss LN02 sites around 500 m) while
 * `IfcMapConversion.OrthogonalHeight` stays ~0 - clamping the origin then
 * floats the whole building above the ground by that baked Z. Silently
 * rebasing Z was rejected (it would surface basements and break the
 * documented project-zero-on-terrain behaviour), so the export dialog instead
 * HINTS that the existing "True elevation (MSL)" mode places such models
 * correctly. This module holds the pure heuristic behind that hint.
 */

import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import { getMapUnitScale } from './cesium-placement';

/**
 * Minimum geometry Z (metres, IFC world frame) at or above which the model's
 * lowest point is implausibly high for a local "project zero" datum and reads
 * as a baked-in absolute elevation instead. 100 m clears local-datum models
 * (with the origin at project zero, even a tall building's LOWEST point stays
 * near 0) while catching typical baked-MSL sites (e.g. Swiss LN02 ~400-800 m).
 * Low-lying coastal sites slip through, but for those the float is small.
 */
export const BAKED_MIN_Z_THRESHOLD_METERS = 100;

/**
 * OrthogonalHeight magnitudes (metres) below this count as "the conversion
 * carries no elevation" - i.e. the vertical datum is NOT in the georef, so a
 * high geometry Z must be baked in.
 */
export const NEAR_ZERO_ORTHOGONAL_HEIGHT_METERS = 1;

/**
 * Lowest geometry Z of the model in metres, in the IFC world frame.
 *
 * `coordinateInfo.originalBounds` is in the renderer's Y-up frame (vertical =
 * `y`) and has the origin shift and the wasm RTC offset subtracted, so both
 * are folded back in - the exact reconstruction `computeModelCenterInIfcMeters`
 * (reproject.ts) uses for the KMZ placement itself. The RTC offset is stored
 * in IFC Z-up, so its `z` component is the vertical one.
 */
export function modelMinZMeters(coordinateInfo: CoordinateInfo | undefined): number | null {
  const minY = coordinateInfo?.originalBounds?.min?.y;
  if (minY === undefined || !Number.isFinite(minY)) return null;
  const shiftY = coordinateInfo?.originShift?.y ?? 0;
  const rtcYupY = coordinateInfo?.wasmRtcOffset?.z ?? 0;
  const minZ = minY + shiftY + rtcYupY;
  return Number.isFinite(minZ) ? minZ : null;
}

/**
 * Whether the KMZ export dialog should recommend "True elevation (MSL)"
 * (absolute) over the clampToGround default.
 *
 * Fires when the model's minimum Z is implausibly high for a local datum
 * (>= {@link BAKED_MIN_Z_THRESHOLD_METERS}) AND the map conversion carries
 * (near-)no elevation (|OrthogonalHeight| < {@link NEAR_ZERO_ORTHOGONAL_HEIGHT_METERS}):
 * the elevation is baked into geometry, so clamping the origin to terrain
 * would float the building by that Z. Both inputs are metres.
 */
export function shouldSuggestAbsoluteAltitude(
  minZMeters: number | null | undefined,
  orthogonalHeightMeters: number,
): boolean {
  if (minZMeters === null || minZMeters === undefined || !Number.isFinite(minZMeters)) return false;
  if (!Number.isFinite(orthogonalHeightMeters)) return false;
  return (
    minZMeters >= BAKED_MIN_Z_THRESHOLD_METERS &&
    Math.abs(orthogonalHeightMeters) < NEAR_ZERO_ORTHOGONAL_HEIGHT_METERS
  );
}

/**
 * {@link shouldSuggestAbsoluteAltitude} over a model's raw georef pieces:
 * scales `OrthogonalHeight` from map units to metres with the same
 * `getMapUnitScale` the placement math uses, and derives min Z from
 * `coordinateInfo` via {@link modelMinZMeters}.
 */
export function suggestAbsoluteAltitudeForKmz(
  coordinateInfo: CoordinateInfo | undefined,
  conversion: Pick<MapConversion, 'orthogonalHeight'> | undefined,
  projectedCRS: Pick<ProjectedCRS, 'mapUnitScale'> | undefined,
  lengthUnitScale: number,
): boolean {
  if (!conversion) return false;
  const orthogonalHeightMeters =
    (conversion.orthogonalHeight ?? 0) * getMapUnitScale(projectedCRS, lengthUnitScale);
  return shouldSuggestAbsoluteAltitude(modelMinZMeters(coordinateInfo), orthogonalHeightMeters);
}
