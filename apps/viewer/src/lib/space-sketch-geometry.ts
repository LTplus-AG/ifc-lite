/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure 2D geometry + view-transform helpers for the Space Sketch editor.
 *
 * Extracted from the overlay component so they're testable and reusable across
 * the (interaction / renderer / panel) split — no React, no module state.
 */

import type { Room } from './space-plate-session';

export type Pt = [number, number];

/** Canvas inner margin (px) used when framing rooms to the view. */
export const PAD = 36;

/** Absolute polygon area (shoelace), m². */
export function polyArea(pts: Pt[]): number {
  let a = 0;
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k], q = pts[(k + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/** Ray-cast point-in-polygon test. */
export function pointInPoly(x: number, y: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function centroid(pts: Pt[]): Pt {
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; }
  return [cx / pts.length, cy / pts.length];
}

/** Distinct vertices across all room outlines (deduped by 4-decimal key). */
export function uniqueVerts(rooms: Room[]): Pt[] {
  const seen = new Set<string>();
  const out: Pt[] = [];
  for (const r of rooms) for (const p of r.outline) {
    const k = `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
    if (!seen.has(k)) { seen.add(k); out.push(p); }
  }
  return out;
}

/** Distance from point `(px,py)` to segment `a→b` (clamped to the segment). */
export function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1e-9;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Closest point on segment `a→b` to `p` (clamped to the segment). */
export function projectOnSeg(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy || 1e-9;
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return [a[0] + t * dx, a[1] + t * dy];
}

/** Screen transform as a pure affine: `screen = off + world * scale` (Y
 *  flipped). Decoupling from canvas size + a fixed origin lets one struct carry
 *  fit-to-bounds, wheel-zoom, and drag-pan. */
export interface Fit { scale: number; offX: number; offY: number }

/** Frame the rooms centred within a `w`×`h` canvas (PAD margin) as an affine. */
export function computeFit(rooms: Room[], w: number, h: number): Fit {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rooms) for (const [x, y] of r.outline) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  if (!isFinite(minX)) return { scale: 1, offX: PAD, offY: h - PAD };
  const scale = Math.min((w - 2 * PAD) / Math.max(maxX - minX, 1e-6), (h - 2 * PAD) / Math.max(maxY - minY, 1e-6));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  return { scale, offX: w / 2 - cx * scale, offY: h / 2 + cy * scale };
}

/** Zoom by `factor` about screen point `(ax, ay)` (keeps it fixed). */
export function zoomFit(f: Fit, factor: number, ax: number, ay: number): Fit {
  return { scale: f.scale * factor, offX: ax - (ax - f.offX) * factor, offY: ay + (f.offY - ay) * factor };
}

export const sX = (f: Fit, x: number) => f.offX + x * f.scale;
export const sY = (f: Fit, y: number) => f.offY - y * f.scale;
export const wX = (f: Fit, sx: number) => (sx - f.offX) / f.scale;
export const wY = (f: Fit, sy: number) => (f.offY - sy) / f.scale;
