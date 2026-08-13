/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Zones that are not boxes (issue #2508 item 4): a vertical PRISM over a convex
 * footprint.
 *
 * A box tiling covers most takt and section planning, which is why v1 shipped
 * only boxes. What it does not cover is a plan drawn around the building rather
 * than across it: an L-shaped pour, a wing, a crane radius. Those arrive as a
 * polygon, and forcing them into an axis box either includes a neighbour's work
 * or excludes your own.
 *
 * ## Why the same divergence trick still works, and how
 *
 * `apportionment-clip.ts` integrates the BOX's indicator function over the
 * element's own boundary, which is what lets it produce an exact clipped volume
 * with no cut, no cap and no boolean. The field it uses,
 * `f = X_y * X_z * (clamp(x, x0, x1) - x0)`, is specific to a box only because
 * `x0` and `x1` are constants there.
 *
 * Decompose the convex footprint into TRAPEZOIDS between consecutive vertex z
 * values (a standard trapezoidal sweep). Inside one trapezoid the footprint's
 * x-chord is bounded by two LINES, `lo(z) = aLo + bLo*z` and
 * `hi(z) = aHi + bHi*z`, so the same field works with the constants replaced by
 * those linear functions:
 *
 *     f = X_[y0,y1](y) * X_[z0,z1](z) * (clamp(x, lo(z), hi(z)) - lo(z))
 *     div F = X_(trapezoidal prism)
 *
 * and the prism's volume is the sum over trapezoids, which tile the footprint
 * with disjoint interiors. Two properties make this exact rather than
 * approximate:
 *
 * - `f` is CONTINUOUS across the two slanted planes (it reaches 0 at `lo` and
 *   `hi - lo` at `hi` from both sides), so those interfaces contribute nothing.
 *   Across the y and z planes `f` does jump, but there `n` is perpendicular to
 *   x and `F . n = 0`, exactly as in the box case.
 * - Within each clipped region `f` is LINEAR in `(x, z)`, so its integral over a
 *   polygon is the polygon's area times its value at the centroid. No
 *   quadrature, no subdivision beyond the plane clips.
 *
 * The cost is `O(triangles x trapezoids)`, and a takt polygon has three to six
 * trapezoids, so a prism zone costs a few times a box zone rather than a
 * different order.
 *
 * ## Why the clip here is a general plane and the box's is not
 *
 * The two slanted planes are not axis-aligned, so this module carries its own
 * `clipPlane`. It is deliberately NOT used to replace the box path's
 * axis-aligned `clipHalfSpace`: that path is measured (44 to 52 us per element
 * over 241 real straddlers) and every zone set that exists today goes through
 * it. Generalising the hot loop to earn a shared function would trade a
 * measured number for a tidier one.
 */

/** A point of a footprint: world `[x, z]` metres. Y is the extrusion axis. */
export type FootprintPoint = readonly [x: number, z: number];

/**
 * One strip of the trapezoidal decomposition: between `z0` and `z1` the
 * footprint spans `x` from `aLo + bLo*z` to `aHi + bHi*z`.
 */
export interface Trapezoid {
  z0: number;
  z1: number;
  aLo: number;
  bLo: number;
  aHi: number;
  bHi: number;
}

/** A prism ready to integrate against. */
export interface CompiledPrism {
  minY: number;
  maxY: number;
  traps: Trapezoid[];
  /** World bounds, for the same cheap reject the box path does first. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Strips thinner than this contribute nothing and are skipped: they are the
 *  degenerate output of two vertices at the same z, not real area. */
const MIN_STRIP_M = 1e-12;

/**
 * Is `poly` convex and non-self-intersecting, walked in one consistent turn
 * direction?
 *
 * Everything below (the chord being a single interval, exactly two edges
 * crossing each strip, the SAT overlap test) is true for convex polygons and
 * silently wrong for others, so this is a gate rather than a nicety. Collinear
 * vertices are allowed: they are common in a polygon traced off a plan and they
 * break nothing.
 */
export function isConvexFootprint(poly: readonly FootprintPoint[]): boolean {
  if (poly.length < 3) return false;
  if (!poly.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))) return false;
  let sign = 0;
  let turn = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const c = poly[(i + 2) % poly.length];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    const dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
    turn += Math.atan2(cross, dot);
    if (Math.abs(cross) < 1e-12) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  // `sign !== 0`: all cross products vanished, so the "polygon" is a line, which
  // has no area and cannot contain anything.
  //
  // The TURNING NUMBER is what makes this a self-intersection test rather than
  // only a convexity test. A star polygon (a pentagram traced point to point)
  // turns the same way at every vertex, so the sign check alone accepts it,
  // and `trapezoidsOfFootprint` then finds more than two spanning edges in a
  // strip and silently reports the volume of the HULL. A simple polygon turns
  // exactly once; a star turns twice or more.
  return sign !== 0 && Math.abs(Math.abs(turn) - 2 * Math.PI) < 1e-6;
}

/** Axis-aligned bounds of a footprint, `[minX, minZ, maxX, maxZ]`. */
export function footprintBounds(poly: readonly FootprintPoint[]): [number, number, number, number] {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of poly) {
    if (x < minX) minX = x;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (z > maxZ) maxZ = z;
  }
  return [minX, minZ, maxX, maxZ];
}

/**
 * Decompose a convex footprint into trapezoidal strips between consecutive
 * vertex z values.
 *
 * Exactly two edges cross the interior of each strip in a convex polygon (one
 * per chain), so each strip's chord is bounded by two lines. They are
 * identified by evaluating every spanning edge at the strip's MIDPOINT rather
 * than by chain-walking: the midpoint is strictly inside the strip, so the
 * comparison cannot be decided by a shared endpoint.
 */
export function trapezoidsOfFootprint(poly: readonly FootprintPoint[]): Trapezoid[] {
  const zs = [...new Set(poly.map((p) => p[1]))].sort((a, b) => a - b);
  const traps: Trapezoid[] = [];
  for (let i = 0; i + 1 < zs.length; i++) {
    const z0 = zs[i];
    const z1 = zs[i + 1];
    if (z1 - z0 <= MIN_STRIP_M) continue;
    const mid = (z0 + z1) / 2;
    let lo: { a: number; b: number; x: number } | null = null;
    let hi: { a: number; b: number; x: number } | null = null;
    for (let e = 0; e < poly.length; e++) {
      const [x1, za] = poly[e];
      const [x2, zb] = poly[(e + 1) % poly.length];
      if (za === zb) continue;
      if (mid <= Math.min(za, zb) || mid >= Math.max(za, zb)) continue;
      const b = (x2 - x1) / (zb - za);
      const a = x1 - b * za;
      const x = a + b * mid;
      if (!lo || x < lo.x) lo = { a, b, x };
      if (!hi || x > hi.x) hi = { a, b, x };
    }
    if (!lo || !hi || lo === hi) continue;
    traps.push({ z0, z1, aLo: lo.a, bLo: lo.b, aHi: hi.a, bHi: hi.b });
  }
  return traps;
}

/**
 * The single place a prism zone's box fields are derived from its footprint.
 *
 * `Zone.center` / `Zone.size` stay the footprint's bounding box (see the type's
 * doc) so every bounds consumer keeps working. Deriving that in one function
 * rather than at each entry point is what makes the invariant true rather than
 * hoped for: an importer, a future drawing tool and a test would otherwise each
 * compute it, and one of them would drift.
 */
export function normalizePrismBounds<T extends {
  center: [number, number, number];
  size: [number, number, number];
  rotationY: number;
  footprint?: ReadonlyArray<FootprintPoint>;
}>(zone: T): T {
  if (!zone.footprint) return zone;
  const [minX, minZ, maxX, maxZ] = footprintBounds(zone.footprint);
  return {
    ...zone,
    center: [(minX + maxX) / 2, zone.center[1], (minZ + maxZ) / 2],
    size: [maxX - minX, zone.size[1], maxZ - minZ],
    // Not a stored orientation: the footprint is already in world coordinates,
    // so leaving a stale angle here would let a box-path consumer rotate a
    // bounding box that is not rotated.
    rotationY: 0,
  };
}

/** Compile a prism zone for repeated integration. */
export function compilePrism(
  poly: readonly FootprintPoint[],
  minY: number,
  maxY: number,
): CompiledPrism {
  const [minX, minZ, maxX, maxZ] = footprintBounds(poly);
  return { minY, maxY, traps: trapezoidsOfFootprint(poly), minX, maxX, minZ, maxZ };
}

/** Is `[x, z]` inside the convex footprint, within `eps` metres? */
export function isPointInFootprint(x: number, z: number, poly: readonly FootprintPoint[], eps = 1e-6): boolean {
  let positive = false;
  let negative = false;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0];
    const ez = b[1] - a[1];
    const len = Math.hypot(ex, ez);
    if (len === 0) continue;
    // Signed distance to the edge line, so `eps` is metres rather than an
    // area-scaled cross product that means something different per polygon.
    const d = ((x - a[0]) * ez - (z - a[1]) * ex) / len;
    if (d > eps) positive = true;
    if (d < -eps) negative = true;
  }
  return !(positive && negative);
}

/**
 * Does the world AABB `[minX, minZ] .. [maxX, maxZ]` overlap the footprint?
 *
 * 2D separating-axis test between two convex polygons: the rectangle's two axes
 * plus the footprint's edge normals. `eps`'s sign means what it means in
 * `zoneOverlapsAABBCompiled`: positive is inclusive (touching counts), negative
 * demands that much real penetration, which is how v1 keeps a tiling zone set
 * from flagging every boundary-abutting element as a straddler.
 */
export function footprintOverlapsRect(
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  poly: readonly FootprintPoint[],
  eps = 1e-6,
): boolean {
  const [pMinX, pMinZ, pMaxX, pMaxZ] = footprintBounds(poly);
  if (pMinX > maxX + eps || pMaxX < minX - eps) return false;
  if (pMinZ > maxZ + eps || pMaxZ < minZ - eps) return false;

  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0];
    const ez = b[1] - a[1];
    const len = Math.hypot(ex, ez);
    if (len === 0) continue;
    const nx = ez / len;
    const nz = -ex / len;
    let polyMin = Infinity;
    let polyMax = -Infinity;
    for (const [px, pz] of poly) {
      const p = px * nx + pz * nz;
      if (p < polyMin) polyMin = p;
      if (p > polyMax) polyMax = p;
    }
    // The rectangle's extent on this axis, in closed form.
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const hx = (maxX - minX) / 2;
    const hz = (maxZ - minZ) / 2;
    const centre = cx * nx + cz * nz;
    const radius = Math.abs(nx) * hx + Math.abs(nz) * hz;
    if (centre - radius > polyMax + eps || centre + radius < polyMin - eps) return false;
  }
  return true;
}

// The integrator lives in `./prism-clip.js` (the same seam `apportionment.ts`
// has with `apportionment-clip.ts`). Re-exported so a caller asks this module
// for "the volume of an element inside a prism" without needing to know which
// half of the pair computes it.
export { clippedVolumeForPrism } from './prism-clip.js';
