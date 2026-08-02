/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure oriented-box (OBB) math for zones. A zone only rotates about the
 * vertical (Y) axis, so every test below decomposes into an independent 1-D
 * check on Y (a plain interval overlap) plus a 2-D check in the X/Z
 * footprint plane (a rotated rectangle vs. either a point or an
 * axis-aligned rectangle) — there is never a need for full 3-D OBB/OBB
 * separating-axis machinery.
 */

import type { ElementAABB, Zone } from './types.js';

export interface Vec3Like {
  0: number;
  1: number;
  2: number;
}

/** Rotate `(x, z)` by `-rotationY` (world → zone-local) around the origin. */
function rotateIntoLocal(x: number, z: number, rotationY: number): [number, number] {
  // Rotating world coordinates INTO the zone's local frame undoes the
  // zone's own rotation, hence the negated angle.
  const cos = Math.cos(-rotationY);
  const sin = Math.sin(-rotationY);
  return [x * cos - z * sin, x * sin + z * cos];
}

/** World-space point → zone-local coordinates (still metres, just
 *  re-centred on the zone and with the footprint un-rotated). */
export function worldToZoneLocal(point: Vec3Like, zone: Zone): [number, number, number] {
  const dx = point[0] - zone.center[0];
  const dy = point[1] - zone.center[1];
  const dz = point[2] - zone.center[2];
  const [lx, lz] = rotateIntoLocal(dx, dz, zone.rotationY);
  return [lx, dy, lz];
}

/**
 * Is `point` inside `zone` (inclusive of the boundary, +`eps` metres of
 * slack so exact-boundary floating point doesn't flip-flop)?
 */
export function isPointInZone(point: Vec3Like, zone: Zone, eps = 1e-6): boolean {
  return isPointInCompiledZone(point[0], point[1], point[2], compileZone(zone), eps);
}

/** Centroid of an axis-aligned world-space AABB. */
export function aabbCentroid(box: { min: Vec3Like; max: Vec3Like }): [number, number, number] {
  return [
    (box.min[0] + box.max[0]) / 2,
    (box.min[1] + box.max[1]) / 2,
    (box.min[2] + box.max[2]) / 2,
  ];
}

/**
 * Does the world-space AABB `[min, max]` overlap `zone`'s oriented box?
 *
 * Decomposes into:
 *  - a 1-D interval-overlap test on Y (the never-rotated vertical axis), and
 *  - a 2-D separating-axis test in the X/Z plane between the AABB's
 *    footprint (an axis-aligned rectangle) and the zone's footprint (a
 *    rectangle rotated by `rotationY`). Two convex rectangles overlap iff
 *    neither rectangle's two unique edge normals separates them, so testing
 *    the world X/Z axes plus the zone's two local axes is exact (standard
 *    2-D SAT for boxes) — no false positives or negatives.
 *
 * This is a thin per-call wrapper (compiles `zone` fresh every time) kept
 * for API convenience and tests; the assignment engine's hot loop uses
 * {@link compileZone} + {@link zoneOverlapsAABBCompiled} directly so it
 * isn't re-deriving `cos`/`sin`/half-extents for the same zone on every one
 * of the `elements × zones` checks.
 */
export function zoneOverlapsAABB(
  min: Vec3Like,
  max: Vec3Like,
  zone: Zone,
  eps = 1e-6,
): boolean {
  return zoneOverlapsAABBCompiled(min[0], min[1], min[2], max[0], max[1], max[2], compileZone(zone), eps);
}

// ============================================================================
// Compiled zone — precomputed per-zone constants for the assignment hot
// loop. Trig + half-extents are derived once per zone (not once per element
// × zone check), and every projection below is closed-form arithmetic (the
// standard "radius" trick for box/box SAT) rather than building corner
// arrays and looping — this is the difference between the assignment engine
// running in the tens of milliseconds vs. multiple seconds over 100k
// elements (see the PR description for measured numbers).
// ============================================================================

export interface CompiledZone {
  id: string;
  name: string;
  cx: number;
  cy: number;
  cz: number;
  hx: number;
  hy: number;
  hz: number;
  cos: number;
  sin: number;
  minY: number;
  maxY: number;
}

/** Precompute a zone's trig + half-extents once, for reuse across every
 *  element checked against it. */
export function compileZone(zone: Zone): CompiledZone {
  const cos = Math.cos(zone.rotationY);
  const sin = Math.sin(zone.rotationY);
  const hx = zone.size[0] / 2;
  const hy = zone.size[1] / 2;
  const hz = zone.size[2] / 2;
  const cy = zone.center[1];
  return {
    id: zone.id,
    name: zone.name,
    cx: zone.center[0],
    cy,
    cz: zone.center[2],
    hx,
    hy,
    hz,
    cos,
    sin,
    minY: cy - hy,
    maxY: cy + hy,
  };
}

/** Point-in-box test against a precompiled zone — no trig, no allocation. */
export function isPointInCompiledZone(
  x: number,
  y: number,
  z: number,
  zone: CompiledZone,
  eps = 1e-6,
): boolean {
  if (y < zone.minY - eps || y > zone.maxY + eps) return false;
  const dx = x - zone.cx;
  const dz = z - zone.cz;
  // World -> zone-local rotation by -rotationY: cos(-t)=cos(t), sin(-t)=-sin(t).
  const lx = dx * zone.cos + dz * zone.sin;
  const lz = -dx * zone.sin + dz * zone.cos;
  return Math.abs(lx) <= zone.hx + eps && Math.abs(lz) <= zone.hz + eps;
}

/**
 * AABB/OBB overlap against a precompiled zone via the closed-form
 * projection-radius SAT (no corner arrays): for each of the 4 candidate
 * axes (world X, world Z, the zone's two local footprint axes) the AABB's
 * projected half-width is `hx*|axis.x| + hz*|axis.z|` and, projected onto
 * one of ITS OWN axes, the zone's half-width is simply its own half-extent
 * — both closed forms of the standard box/box separating-axis test.
 *
 * `eps` is slack added to the "not separated" threshold on every axis (and
 * the Y interval check), so its SIGN controls what "overlap" means:
 *  - positive (the default, 1e-6) — INCLUSIVE: two boxes that merely touch
 *    (zero-depth contact, e.g. floating-point-exact shared edges) still
 *    count as overlapping. Right for "does this box touch the zone at
 *    all" queries.
 *  - negative — a MINIMUM-PENETRATION requirement: a separating axis is
 *    found (boxes do NOT overlap) unless the true overlap depth on every
 *    axis exceeds `-eps`. Passing `eps = -d` demands at least `d` metres of
 *    real penetration, which is exactly what distinguishes "elements that
 *    end at a shared zone-set boundary" (zero penetration, common when
 *    zone sets tile a building) from "elements that actually straddle
 *    into the next zone" — see `assignment.ts`'s `STRADDLE_PENETRATION_M`.
 */
export function zoneOverlapsAABBCompiled(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  zone: CompiledZone,
  eps = 1e-6,
): boolean {
  if (maxY < zone.minY - eps || minY > zone.maxY + eps) return false;

  const acx = (minX + maxX) / 2;
  const acz = (minZ + maxZ) / 2;
  const ahx = (maxX - minX) / 2;
  const ahz = (maxZ - minZ) / 2;
  const dcx = acx - zone.cx;
  const dcz = acz - zone.cz;
  const absCos = Math.abs(zone.cos);
  const absSin = Math.abs(zone.sin);

  // World X axis (1, 0).
  if (Math.abs(dcx) > ahx + zone.hx * absCos + zone.hz * absSin + eps) return false;
  // World Z axis (0, 1).
  if (Math.abs(dcz) > ahz + zone.hx * absSin + zone.hz * absCos + eps) return false;
  // Zone local U axis (cos, sin).
  if (Math.abs(dcx * zone.cos + dcz * zone.sin) > zone.hx + ahx * absCos + ahz * absSin + eps) return false;
  // Zone local V axis (-sin, cos).
  if (Math.abs(-dcx * zone.sin + dcz * zone.cos) > zone.hz + ahx * absSin + ahz * absCos + eps) return false;

  return true;
}

/** World-space corners of a zone's box (for rendering a wireframe/translucent
 *  hull). Order: bottom face (0-3) then top face (4-7), each CCW looking
 *  down -Y, matching the common "box corner index" convention used by
 *  `AddElementOverlay`'s box-hull projection. */
export function zoneWorldCorners(zone: Zone): Array<[number, number, number]> {
  const hx = zone.size[0] / 2;
  const hy = zone.size[1] / 2;
  const hz = zone.size[2] / 2;
  const cos = Math.cos(zone.rotationY);
  const sin = Math.sin(zone.rotationY);
  const toWorld = (lx: number, ly: number, lz: number): [number, number, number] => [
    zone.center[0] + lx * cos - lz * sin,
    zone.center[1] + ly,
    zone.center[2] + (lx * sin + lz * cos),
  ];
  return [
    toWorld(-hx, -hy, -hz),
    toWorld(hx, -hy, -hz),
    toWorld(hx, -hy, hz),
    toWorld(-hx, -hy, hz),
    toWorld(-hx, hy, -hz),
    toWorld(hx, hy, -hz),
    toWorld(hx, hy, hz),
    toWorld(-hx, hy, hz),
  ];
}

/** World-space axis-aligned bounds of a zone's (possibly rotated) box — a
 *  cheap conservative bound, e.g. for a quick broad-phase reject before the
 *  exact SAT test, or for framing a zone in the viewport. */
export function zoneWorldAABB(zone: Zone): { min: [number, number, number]; max: [number, number, number] } {
  const corners = zoneWorldCorners(zone);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const [x, y, z] of corners) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/** Re-exported for callers that want the element-AABB shape without pulling
 *  in the whole assignment module. */
export type { ElementAABB };
