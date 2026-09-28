/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure view maths for the Model workspace's plan (charter #6232, M2 §1.5):
 * framing, the construction grid and the click pick. The screen transform is
 * Space Sketch's `Fit` (`lib/space-sketch-geometry.ts`, y flipped), so the
 * plan and the sketch zoom, pan and clamp by the same rules; the plan's own
 * frame is workplane-local metres, the frame a command's `SnapResult.local`
 * is in.
 */

import { computeFitFromPoints, pointInPoly, polyArea, wX, wY, type Fit, type Pt } from '@/lib/space-sketch-geometry';
import type { Vec2 } from '@/lib/snap/types';
import type { WallAxis } from '@/lib/snap/sources/semantic';
import type { PlanCutPolygon, PlanCutLine } from './usePlanCut';

/** Below this many pixels per metre the 1 m grid is not drawn (it would be noise). */
export const GRID_MIN_PX_PER_M = 8;
/** At and above this the grid is fully visible; between the two it fades in. */
const GRID_FULL_PX_PER_M = 24;
/** More lines than this per axis and the grid steps up by 10×. */
const GRID_MAX_LINES = 400;
/** A storey with nothing to frame shows a 10 m square round its origin. */
const EMPTY_HALF_M = 5;

/** The workplane-local point under a canvas-relative screen point. */
export function screenToLocal(fit: Fit, sx: number, sy: number): Vec2 {
  return [wX(fit, sx), wY(fit, sy)];
}

/** Frame everything the plan draws in a `w`×`h` canvas. */
export function fitPlan(polygons: readonly PlanCutPolygon[], lines: readonly PlanCutLine[], axes: readonly WallAxis[], w: number, h: number): Fit {
  const pts: Pt[] = [];
  for (const p of polygons) for (const v of p.outer) pts.push([v[0], v[1]]);
  for (const l of lines) pts.push([l.a[0], l.a[1]], [l.b[0], l.b[1]]);
  for (const a of axes) pts.push([a.a[0], a.a[1]], [a.b[0], a.b[1]]);
  if (pts.length === 0) pts.push([-EMPTY_HALF_M, -EMPTY_HALF_M], [EMPTY_HALF_M, EMPTY_HALF_M]);
  return computeFitFromPoints(pts, w, h);
}

export interface PlanGrid {
  /** Node spacing, metres. */
  spacing: number;
  /** 0..1: fades in between `GRID_MIN_PX_PER_M` and `GRID_FULL_PX_PER_M`. */
  opacity: number;
  /** Screen x of each vertical line, screen y of each horizontal one. */
  xs: number[];
  ys: number[];
}

/** The grid lines visible in a `w`×`h` canvas, or null when zoomed out past the grid. */
export function planGrid(fit: Fit, w: number, h: number): PlanGrid | null {
  if (!(fit.scale >= GRID_MIN_PX_PER_M) || w <= 0 || h <= 0) return null;
  let spacing = 1;
  while ((w + h) / (fit.scale * spacing) > GRID_MAX_LINES) spacing *= 10;
  const opacity = Math.min(1, (fit.scale - GRID_MIN_PX_PER_M) / (GRID_FULL_PX_PER_M - GRID_MIN_PX_PER_M));
  const xs: number[] = [];
  const ys: number[] = [];
  for (let x = Math.ceil(wX(fit, 0) / spacing) * spacing; x <= wX(fit, w); x += spacing) xs.push(fit.offX + x * fit.scale);
  for (let y = Math.ceil(wY(fit, h) / spacing) * spacing; y <= wY(fit, 0); y += spacing) ys.push(fit.offY - y * fit.scale);
  return { spacing, opacity, xs, ys };
}

function inside(p: Vec2, polygon: PlanCutPolygon): boolean {
  if (!pointInPoly(p[0], p[1], polygon.outer as Pt[])) return false;
  return !polygon.holes.some((hole) => pointInPoly(p[0], p[1], hole as Pt[]));
}

/**
 * The element a plan click at `p` picks: the cut polygon containing it, the
 * smallest by area when several do (a door inside its wall's outline, a
 * column inside a slab), else null.
 */
export function pickPlanEntity(polygons: readonly PlanCutPolygon[], p: Vec2): number | null {
  let best: { id: number; area: number } | null = null;
  for (const polygon of polygons) {
    if (!inside(p, polygon)) continue;
    const area = polyArea(polygon.outer as Pt[]);
    if (!best || area < best.area) best = { id: polygon.entityId, area };
  }
  return best?.id ?? null;
}
