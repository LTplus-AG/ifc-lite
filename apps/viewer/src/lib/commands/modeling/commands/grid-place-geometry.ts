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
 * last bay may be the short one. A dragged side just past a whole bay ends on
 * that bay instead (#9095): a pointer is not that exact. A typed side is, so it
 * always closes on the value typed.
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
/** A dragged closing bay narrower than this share of the spacing is a sliver: no axis closes it. */
const MIN_DRAGGED_BAY = 0.1;
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

/**
 * The whole bays across `extent`, and whether an axis closes a shorter one after them.
 * `dragged`: the extent came from the pointer, so a sliver is dropped; a rectangle
 * narrower than one bay still closes, since a family needs its far side.
 */
function bayLayout(extent: number, spacing: number, dragged: boolean): { bays: number; closes: boolean } {
  const bays = Math.floor(extent / spacing + 1e-9);
  const rest = extent - bays * spacing;
  return { bays, closes: rest > 1e-6 && (!dragged || bays === 0 || rest >= spacing * MIN_DRAGGED_BAY) };
}

/** How many axes `axisOffsets(extent, spacing, dragged)` makes, without making them. */
export function axisCount(extent: number, spacing: number, dragged = false): number {
  const { bays, closes } = bayLayout(extent, spacing, dragged);
  return bays + (closes ? 2 : 1);
}

/** Axis offsets across `extent` at `spacing`, closing on the far side (see `bayLayout`). */
export function axisOffsets(extent: number, spacing: number, dragged = false): number[] {
  const { bays, closes } = bayLayout(extent, spacing, dragged);
  const offsets = Array.from({ length: bays + 1 }, (_, i) => i * spacing);
  if (closes) offsets.push(extent);
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
  // Shift squares a side to the other's typed value, so that side is typed too.
  const dragU = g.width === null && !(g.square && g.depth !== null);
  const dragV = g.depth === null && !(g.square && g.width !== null);
  if (axisCount(rect.width, g.spacingU, dragU) + axisCount(rect.depth, g.spacingV, dragV) > MAX_GRID_AXES) return { ok: false, reason: 'tooManyAxes' };
  const UOffsets = axisOffsets(rect.width, g.spacingU, dragU);
  const VOffsets = axisOffsets(rect.depth, g.spacingV, dragV);
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
