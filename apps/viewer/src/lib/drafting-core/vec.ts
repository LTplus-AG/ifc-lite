/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ADAPTED from BIMvoice/ifc-sheet `apps/viewer/src/drafting/vec.ts`
 * (see provenance.json): trimmed to the helpers `curves.ts`, `intersect.ts`
 * and `snaps.ts` use. Owned here; not byte-pinned.
 *
 * 2D vector helpers for the drafting kernel. Points and vectors share the
 * `Pt` shape; every helper is pure and allocates a fresh result.
 */

import type { Pt } from './types';

/** Numerical tolerance for math comparisons. */
export const EPS = 1e-9;
/** Points closer than this (metres) are treated as coincident. */
export const COINCIDENT = 1e-6;
export const TAU = Math.PI * 2;

export function add(a: Pt, b: Pt): Pt {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Pt, b: Pt): Pt {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a: Pt, k: number): Pt {
  return { x: a.x * k, y: a.y * k };
}

export function dot(a: Pt, b: Pt): number {
  return a.x * b.x + a.y * b.y;
}

/** z-component of the 3D cross product (positive when b is CCW of a). */
export function cross(a: Pt, b: Pt): number {
  return a.x * b.y - a.y * b.x;
}

export function len(a: Pt): number {
  return Math.hypot(a.x, a.y);
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function angleOf(v: Pt): number {
  return Math.atan2(v.y, v.x);
}

/** Normalise an angle into [0, 2π). */
export function normAngle(a: number): number {
  const r = a % TAU;
  const n = r < 0 ? r + TAU : r;
  return n >= TAU ? 0 : n;
}

/** CCW sweep from `start` to `end`, in (0, 2π]. Equal angles mean a full turn. */
export function sweepOf(start: number, end: number): number {
  const s = normAngle(end - start);
  return s < EPS ? TAU : s;
}

/** True when `angle` lies on the CCW sweep from `start` to `end` (inclusive). */
export function angleInArc(angle: number, start: number, end: number, tol = EPS): boolean {
  const sw = sweepOf(start, end);
  const off = normAngle(angle - start);
  if (off <= sw + tol) return true;
  // Wrap-around tolerance just before `start`.
  return TAU - off <= tol;
}

/** Point on a circle at a given angle. */
export function polar(c: Pt, r: number, a: number): Pt {
  return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
}
