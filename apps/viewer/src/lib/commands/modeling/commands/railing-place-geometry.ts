/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `railing.place`'s gesture and the path it draws (charter #6232, D1). Its own
 * module so the command's bar and ghost can read it without importing the
 * command.
 *
 * The path is a polyline of clicked points, drawn like a wall chain (typed
 * Length and Angle lock the next segment). Each point carries the height above
 * the workplane it was snapped at: a vertex or edge of a slab or stair lifts
 * the point to that surface, a free point stays level with the one before, so a
 * railing follows a stair's side up and runs flat along a slab's edge.
 */

import { dist } from '@/lib/snap/constraints';
import type { SnapCandidate, SnapResult } from '@/lib/snap/types';
import type { Vec3 } from '../types.js';
import { endPoint, type WallPlaceGesture } from './wall-place-geometry.js';

export interface RailingPlaceGesture extends WallPlaceGesture {
  /** Height above the workplane each placed point snapped to, metres; null for a point that snapped to no surface. */
  rise: (number | null)[];
  /** Height at the cursor: the surface it snapped to, or null when it snapped to none. */
  cursorRise: number | null;
}

export const initRailingGesture = (): RailingPlaceGesture => ({
  chain: [], cursor: null, length: null, angle: null, rise: [], cursorRise: null,
});

/** Segments shorter than this are not placed (metres): a double-click's second click must not add one. */
export const MIN_RAILING_SEGMENT = 0.05;

/** Mesh targets whose height means something: a corner, an edge or its middle, not a face under the cursor. */
const SURFACE_KINDS: ReadonlySet<SnapCandidate['kind']> = new Set(['endpoint', 'vertex', 'midpoint', 'edge']);
/**
 * A snap further below the plane than this, or above it than this, is another
 * storey's or the ground's edge seen through the view, not an edge the railing
 * sits on (metres): a stair side climbs at most a storey.
 */
const MIN_RISE = -0.5;
const MAX_RISE = 6;

/** The height a snap puts the point at, or null when it snapped to no surface edge. */
export function riseOf(s: Pick<SnapResult, 'winner'>): number | null {
  const w = s.winner;
  if (!w || w.source !== 'mesh' || w.elevation === undefined || !SURFACE_KINDS.has(w.kind)) return null;
  return Number.isFinite(w.elevation) && w.elevation >= MIN_RISE && w.elevation <= MAX_RISE ? Math.round(w.elevation * 1000) / 1000 : null;
}

/**
 * Heights for every point: a snapped point keeps its own, a free one stays
 * level with the point before it, and the free points before the first snap
 * take that snap's height (so a path that reaches its first slab corner at the
 * third click is level from the start, not sloped up to it).
 */
function levels(rises: readonly (number | null)[]): number[] {
  const first = rises.find((r): r is number => r !== null) ?? 0;
  let level = first;
  return rises.map((r) => (level = r ?? level));
}

/** The path as drawn: the placed points and, when the rubber band is long enough, where it ends. Workplane-local. */
export function pathOf(g: RailingPlaceGesture): Vec3[] {
  const last = g.chain[g.chain.length - 1];
  const end = endPoint(g);
  const grows = last && end && dist(last, end) >= MIN_RAILING_SEGMENT;
  const heights = levels(grows ? [...g.rise, g.cursorRise] : g.rise);
  const points = grows ? [...g.chain, end] : g.chain;
  return points.map((p, i) => [p[0], p[1], heights[i]] as Vec3);
}

/** Plan length of the path, metres (the bar shows it). */
export function pathLength(path: readonly Vec3[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  return total;
}

