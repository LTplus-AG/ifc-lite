/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ADAPTED from BIMvoice/ifc-sheet `apps/viewer/src/drafting/types.ts`
 * (see provenance.json): trimmed to the types `curves.ts`, `intersect.ts`
 * and `snaps.ts` use. Owned here; not byte-pinned.
 *
 * Coordinates are drawing coordinates in metres, the same (x, y) space
 * `@ifc-lite/drawing-2d` emits its lines in. Angles are radians,
 * counter-clockwise (x right, y up). An arc runs counter-clockwise from
 * `start` to `end`.
 */

export interface Pt {
  x: number;
  y: number;
}

export type DraftShape =
  | { type: 'line'; a: Pt; b: Pt }
  | { type: 'polyline'; pts: Pt[]; closed: boolean }
  | { type: 'circle'; c: Pt; r: number }
  | { type: 'arc'; c: Pt; r: number; start: number; end: number };

export type SnapMode = 'endpoint' | 'midpoint' | 'center' | 'quadrant' | 'intersection' | 'perpendicular' | 'nearest';

export interface SnapHit {
  mode: SnapMode;
  point: Pt;
}
