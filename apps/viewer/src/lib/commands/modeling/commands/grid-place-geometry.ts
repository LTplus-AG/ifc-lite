/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `grid.place`'s gesture and the rules that turn it into builder parameters
 * and a ghost (charter #6232, D3). Its own module so the command's HUD layers
 * can read it without importing the command.
 *
 * The extent is a rectangle, drawn corner to corner or typed (Width / Depth
 * lock a side, Shift squares it: the slab tool's rectangle). U axes are the
 * lines x = const along the rectangle, V axes y = const; each family runs at
 * its spacing from the first corner's side and closes on the far side, so the
 * grid always spans the rectangle and its last bay may be the short one.
 */

import { rectangularGridAxes, type GridInStoreParams } from '@ifc-lite/create';
import type { MeshData } from '@ifc-lite/geometry';
import type { Vec2 } from '@/lib/snap/types';
import { mergeGhostMeshes, prismGhostMesh, segmentOutline } from '../ghost-shapes.js';
import type { Workplane } from '../types.js';
import { initSlabGesture, rectangleExtent, type SlabPlaceGesture } from './slab-place-geometry.js';

export type GridTagScheme = 'numbers' | 'letters';

/** More axes than this is a typo (a 0.01 m spacing), not a grid. */
export const MAX_GRID_AXES = 200;
const AXIS_STRIP_WIDTH = 0.06;
const AXIS_STRIP_HEIGHT = 0.04;
const GRID_COLOR: [number, number, number, number] = [0.25, 0.6, 1, 0.7];

export interface GridPlaceGesture extends SlabPlaceGesture {
  readonly mode: 'rectangle';
  /** Metres between U axes (x = const) and between V axes (y = const). */
  readonly spacingU: number;
  readonly spacingV: number;
  readonly tags: GridTagScheme;
}

interface Settings { spacingU: number; spacingV: number; tags: GridTagScheme }
const FACTORY: Settings = { spacingU: 6, spacingV: 6, tags: 'numbers' };

/** What the user last set; it outlives a gesture (a commit, Escape) but not the page. `resetGridSettings` is for tests. */
let kept: Settings = FACTORY;

export function resetGridSettings(): void {
  kept = FACTORY;
}

export function withGridSettings(g: GridPlaceGesture, patch: Partial<Settings>): GridPlaceGesture {
  const next = { ...g, ...patch };
  kept = { spacingU: next.spacingU, spacingV: next.spacingV, tags: next.tags };
  return next;
}

export const initGrid = (): GridPlaceGesture => ({ ...initSlabGesture('rectangle'), mode: 'rectangle', ...kept });

/** Spreadsheet-style letters: 0 -> A, 25 -> Z, 26 -> AA (the builder's own default V tags). */
function letters(index: number): string {
  let out = '';
  for (let i = index + 1; i > 0; i = Math.floor((i - 1) / 26)) out = String.fromCharCode(65 + ((i - 1) % 26)) + out;
  return out;
}

/** How many axes `axisOffsets(extent, spacing)` makes, without making them. */
export function axisCount(extent: number, spacing: number): number {
  const count = Math.floor(extent / spacing + 1e-9) + 1;
  return extent - (count - 1) * spacing > 1e-6 ? count + 1 : count;
}

/** Axis offsets across `extent` at `spacing`, closing on the far side. */
export function axisOffsets(extent: number, spacing: number): number[] {
  const count = Math.floor(extent / spacing + 1e-9);
  const offsets = Array.from({ length: count + 1 }, (_, i) => i * spacing);
  if (extent - offsets[offsets.length - 1] > 1e-6) offsets.push(extent);
  return offsets;
}

export type GridPlan =
  | { ok: true; params: GridInStoreParams; min: Vec2; width: number; depth: number; uAxes: number; vAxes: number }
  | { ok: false; reason: 'noArea' | 'tooManyAxes' };

/** The builder parameters for the gesture, at storey-local elevation `z` (the workplane's). */
export function planGrid(g: GridPlaceGesture, z: number): GridPlan {
  const rect = rectangleExtent(g);
  if (!rect) return { ok: false, reason: 'noArea' };
  // Count before allocating: a spacing of 1e-12 must be refused, not enumerated.
  if (axisCount(rect.width, g.spacingU) + axisCount(rect.depth, g.spacingV) > MAX_GRID_AXES) return { ok: false, reason: 'tooManyAxes' };
  const UOffsets = axisOffsets(rect.width, g.spacingU);
  const VOffsets = axisOffsets(rect.depth, g.spacingV);
  const tag = (i: number, scheme: 'number' | 'letter') => (scheme === 'number' ? String(i + 1) : letters(i));
  // Numbers run along the U axes (the lines across the top of a plan), letters down the side.
  const [uScheme, vScheme] = g.tags === 'numbers' ? (['number', 'letter'] as const) : (['letter', 'number'] as const);
  const axes = rectangularGridAxes({
    UOffsets,
    VOffsets,
    UTags: UOffsets.map((_, i) => tag(i, uScheme)),
    VTags: VOffsets.map((_, i) => tag(i, vScheme)),
  });
  return {
    ok: true,
    ...rect,
    uAxes: UOffsets.length,
    vAxes: VOffsets.length,
    params: { Position: [rect.min[0], rect.min[1], z], Direction: 0, ...axes, PredefinedType: 'RECTANGULAR', Name: 'Grid' },
  };
}

/** One axis in workplane-local metres (the grid is placed at its min corner, unrotated). */
export interface PlacedAxis { tag: string; family: 'U' | 'V'; a: Vec2; b: Vec2 }

export function placedAxes(plan: Extract<GridPlan, { ok: true }>): PlacedAxis[] {
  const [ox, oy] = plan.min;
  const shift = (p: readonly [number, number]): Vec2 => [ox + p[0], oy + p[1]];
  return [
    ...plan.params.UAxes.map((a) => ({ tag: a.Tag, family: 'U' as const, a: shift(a.Start), b: shift(a.End) })),
    ...plan.params.VAxes.map((a) => ({ tag: a.Tag, family: 'V' as const, a: shift(a.Start), b: shift(a.End) })),
  ];
}

/** The axes as thin strips on the workplane: one ghost mesh however many axes there are. */
export function gridGhost(plane: Workplane, plan: Extract<GridPlan, { ok: true }>, id: number): MeshData[] {
  return gridAxesGhost(plane, placedAxes(plan), 0, id);
}

/** Shared native axis-strip constructor; callers provide canonical placed axes. */
export function gridAxesGhost(plane: Workplane, axes: readonly Pick<PlacedAxis, 'a' | 'b'>[], elevation: number, id: number): MeshData[] {
  const strips = axes
    .map((axis) => prismGhostMesh(plane, segmentOutline(axis.a, axis.b, AXIS_STRIP_WIDTH), elevation + 0.005, elevation + AXIS_STRIP_HEIGHT, id))
    .filter((m): m is MeshData => m !== null);
  const merged = mergeGhostMeshes(strips, id, GRID_COLOR);
  return merged ? [merged] : [];
}
