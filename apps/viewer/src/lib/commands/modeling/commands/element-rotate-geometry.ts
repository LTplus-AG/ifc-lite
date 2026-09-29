/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `element.rotate`'s gesture and the one rule for the angle it turns by
 * (charter #6232, C2). Its own module so the ring layers (3D and plan) read
 * the same angle the commit writes, without importing the command.
 */

import type { Vec2 } from '@/lib/snap/types';
import type { TransformSelection } from './element-transform-shared.js';

/** The ring's angle snap, degrees. */
export const ROTATE_SNAP_STEP = 15;

export interface ElementRotateGesture {
  readonly selection: TransformSelection | null;
  /** The pivot, session-workplane local; the selection's centre until one is picked. */
  readonly pivot: Vec2 | null;
  /** The ring's radius round the pivot, metres. */
  readonly radius: number;
  /** The next click picks the pivot (P). */
  readonly pickingPivot: boolean;
  /** Direction of the start ray from the pivot, degrees (0 = +x, CCW); null before the first click. */
  readonly start: number | null;
  readonly cursor: Vec2 | null;
  /** The cursor's angle snaps to `ROTATE_SNAP_STEP` (off with Alt or snapping off). */
  readonly snapAngle: boolean;
  /** A typed angle, degrees CCW; wins over the cursor. */
  readonly typed: number | null;
}

/** Direction of `p` seen from `from`, degrees in [0, 360); null when they coincide. */
export function directionDeg(from: Vec2, p: Vec2): number | null {
  const dx = p[0] - from[0], dy = p[1] - from[1];
  if (Math.hypot(dx, dy) < 1e-9) return null;
  return ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
}

/** Wrap to (-180, 180]. */
export function wrapDeg(deg: number): number {
  const r = ((deg % 360) + 360) % 360;
  return r > 180 ? r - 360 : r;
}

/** The turn the gesture stands at, degrees CCW (null: none yet). */
export function rotationDeg(g: ElementRotateGesture): number | null {
  if (g.typed !== null) return g.typed;
  if (g.start === null || !g.pivot || !g.cursor) return null;
  const now = directionDeg(g.pivot, g.cursor);
  if (now === null) return null;
  const raw = wrapDeg(now - g.start);
  return g.snapAngle ? wrapDeg(Math.round(raw / ROTATE_SNAP_STEP) * ROTATE_SNAP_STEP) : raw;
}

/** P: the next click picks the pivot (again: back to turning). */
export function togglePivotPick(g: ElementRotateGesture): ElementRotateGesture {
  return { ...g, pickingPivot: !g.pickingPivot, start: null };
}

export interface RingGeometry {
  /** The ring, closed. */
  readonly circle: Vec2[];
  /** A tick every snap step: inner → outer point, and whether it is a quarter. */
  readonly ticks: { from: Vec2; to: Vec2; major: boolean }[];
  /** Pivot → ring along the start ray, and along the current one. */
  readonly startRay: [Vec2, Vec2] | null;
  readonly nowRay: [Vec2, Vec2] | null;
  /** The swept arc, start → current, inside the ring. */
  readonly arc: Vec2[];
  readonly deg: number | null;
  /** Where the angle label sits. */
  readonly labelAt: Vec2 | null;
}

const at = (c: Vec2, r: number, deg: number): Vec2 => {
  const a = (deg * Math.PI) / 180;
  return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
};

/**
 * The ring the 3D and plan layers draw, workplane-local. Null without a
 * pivot. `radius` overrides the gesture's (a layer keeps the ring grabbable
 * when zoomed out); the angle does not depend on it.
 */
export function ringGeometry(g: ElementRotateGesture, radius = g.radius): RingGeometry | null {
  const c = g.pivot;
  if (!c) return null;
  const r = radius;
  const circle = Array.from({ length: 73 }, (_, i) => at(c, r, i * 5));
  const ticks = Array.from({ length: 360 / ROTATE_SNAP_STEP }, (_, i) => {
    const deg = i * ROTATE_SNAP_STEP;
    const major = deg % 90 === 0;
    return { from: at(c, r * (major ? 0.86 : 0.92), deg), to: at(c, r, deg), major };
  });
  const deg = rotationDeg(g);
  const start = g.start ?? (g.typed !== null ? 0 : null);
  const startRay: [Vec2, Vec2] | null = start === null ? null : [c, at(c, r, start)];
  const nowRay: [Vec2, Vec2] | null = start === null || deg === null ? null : [c, at(c, r, start + deg)];
  const steps = deg === null ? 0 : Math.max(1, Math.ceil(Math.abs(deg) / 5));
  const arc = start === null || deg === null ? [] : Array.from({ length: steps + 1 }, (_, i) => at(c, r * 0.55, start + (deg * i) / steps));
  const labelAt = start === null || deg === null ? null : at(c, r * 0.7, start + deg / 2);
  return { circle, ticks, startRay, nowRay, arc, deg, labelAt };
}
