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

import { pointInPoly, polyArea, wX, wY, type Fit, type Pt } from '@/lib/space-sketch-geometry';
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
/** Fit margin: a small share of the pane, never less than this many px (room for the outline strokes). */
const FIT_MARGIN_MIN_PX = 12;
const FIT_MARGIN_SHARE = 0.03;

/** The workplane-local point under a canvas-relative screen point. */
export function screenToLocal(fit: Fit, sx: number, sy: number): Vec2 {
  return [wX(fit, sx), wY(fit, sy)];
}

/**
 * Frame everything the plan draws in a `w`×`h` canvas: centred, as large as
 * fits with a small margin (Space Sketch's fixed 36 px pad left a narrow
 * plan pane a quarter empty).
 */
export function fitPlan(polygons: readonly PlanCutPolygon[], lines: readonly PlanCutLine[], axes: readonly WallAxis[], w: number, h: number): Fit {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (p: Vec2) => {
    minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]);
  };
  for (const p of polygons) for (const v of p.outer) add(v);
  for (const l of lines) { add(l.a); add(l.b); }
  for (const a of axes) { add(a.a); add(a.b); }
  if (!Number.isFinite(minX)) { add([-EMPTY_HALF_M, -EMPTY_HALF_M]); add([EMPTY_HALF_M, EMPTY_HALF_M]); }
  const margin = Math.max(FIT_MARGIN_MIN_PX, FIT_MARGIN_SHARE * Math.min(w, h));
  const scale = Math.min((w - 2 * margin) / Math.max(maxX - minX, 1e-6), (h - 2 * margin) / Math.max(maxY - minY, 1e-6));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  return { scale, offX: w / 2 - cx * scale, offY: h / 2 + cy * scale };
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
