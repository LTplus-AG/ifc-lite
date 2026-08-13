/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure bake planning for Space Sketch: what a storey's draft rooms become when
 * the user confirms, decided without React, wasm, or the viewer store.
 *
 * The bake half of the overlay reads the plate and never mutates it, and its
 * failure stories are all decisions rather than plumbing: a room emitted on top
 * of an authored space (duplicate rooms in the file), a floor-to-floor taken
 * from a storey list that is unsorted or has a nonsense gap (spaces a hundred
 * metres tall, or the wall band the derive reads collapsing to nothing), and
 * gross floor area measured off the wrong outline (the display boundary rather
 * than the centreline, which would make the quantity describe the wall face).
 * Those are the decisions this module owns; `useSpaceBake` owns the emitting.
 */

import { centroid, pointInPoly, polyArea, type Pt } from '@/lib/space-sketch-geometry';

/** Floor-to-floor used when the storey list offers no usable one. */
export const BAKE_HEIGHT = 3;
/** A storey gap outside this range is a data artefact, not a floor height. */
const MIN_FLOOR_TO_FLOOR = 0.1;
const MAX_FLOOR_TO_FLOOR = 50;

/** The subset of the overlay's storey list this module needs. */
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

/**
 * One drafted room as the bake sees it: the topology outline (always the wall
 * centreline) and the display/emit boundary at the user's chosen boundary mode.
 */
export interface DraftRoom {
  outline: Pt[];
  boundary: Pt[];
}

/** An IfcSpace footprint the caller is cleared to create. */
export interface PlannedSpace {
  /** The emitted profile — the net/gross/centre boundary the user picked. */
  OuterCurve: Pt[];
  Height: number;
  /** Measured on the CENTRELINE outline, so the quantity is the room. */
  grossFloorArea: number;
}

/**
 * Decide which of a storey's draft rooms become IfcSpace.
 *
 * A room whose centroid falls inside an already-authored space footprint is
 * skipped: the tool derives rooms from walls, so on a model that already has
 * spaces every one of them would otherwise be emitted a second time.
 */
export function planStoreySpaces(
  rooms: DraftRoom[],
  authored: Pt[][],
  height: number,
): { planned: PlannedSpace[]; skipped: number } {
  const planned: PlannedSpace[] = [];
  let skipped = 0;
  for (const room of rooms) {
    const [cx, cy] = centroid(room.outline);
    if (authored.some((fp) => pointInPoly(cx, cy, fp))) {
      skipped++;
      continue;
    }
    planned.push({
      OuterCurve: room.boundary,
      Height: height,
      grossFloorArea: polyArea(room.outline),
    });
  }
  return { planned, skipped };
}
