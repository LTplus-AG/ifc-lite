/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Floor-to-floor height for a storey, for the Room tool's derive band.
 * Pure: no React, wasm, or viewer store.
 */

/** Floor-to-floor used when the storey list offers no usable one. */
export const BAKE_HEIGHT = 3;
/** A storey gap outside this range is a data artefact, not a floor height. */
const MIN_FLOOR_TO_FLOOR = 0.1;
const MAX_FLOOR_TO_FLOOR = 50;

/** A storey id with its elevation (metres). */
export interface StoreyElevation {
  id: number;
  elev: number;
}

/**
 * Floor-to-floor for storey `sid`: the elevation gap to the storey above it in
 * `storeys`, which the caller keeps sorted low → high.
 *
 * Falls back to {@link BAKE_HEIGHT} for the top storey, an unknown storey, and
 * for a gap that cannot be a storey height. That guard is not cosmetic: this
 * height is also the band `wallRectsFromMeshes` slices to find the storey's
 * walls, so a zero/negative gap (two storeys at the same elevation, a common
 * export artefact) would find no walls at all, and a 500 m gap (a storey
 * elevation left in millimetres) would sweep the whole building into one plan.
 */
export function floorToFloorHeight(storeys: StoreyElevation[], sid: number): number {
  const idx = storeys.findIndex((s) => s.id === sid);
  if (idx < 0) return BAKE_HEIGHT;
  const next = storeys[idx + 1];
  const ff = next ? next.elev - storeys[idx].elev : BAKE_HEIGHT;
  return ff > MIN_FLOOR_TO_FLOOR && ff < MAX_FLOOR_TO_FLOOR ? ff : BAKE_HEIGHT;
}
