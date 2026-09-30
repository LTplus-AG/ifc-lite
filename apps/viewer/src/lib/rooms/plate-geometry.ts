/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure 2D geometry + view-transform helpers for the Room tool's plan and layout editing.
 *
 * No React, no module state.
 */

export type Pt = [number, number];

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

/** Zoom by `factor` about screen point `(ax, ay)` (keeps it fixed). */
export function zoomFit(f: Fit, factor: number, ax: number, ay: number): Fit {
  return { scale: f.scale * factor, offX: ax - (ax - f.offX) * factor, offY: ay + (f.offY - ay) * factor };
}

export const sX = (f: Fit, x: number) => f.offX + x * f.scale;
export const sY = (f: Fit, y: number) => f.offY - y * f.scale;
export const wX = (f: Fit, sx: number) => (sx - f.offX) / f.scale;
export const wY = (f: Fit, sy: number) => (f.offY - sy) / f.scale;
