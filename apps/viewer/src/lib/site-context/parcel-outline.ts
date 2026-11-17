/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How the viewer draws a parcel boundary: wider than the core's ribbon,
 * scaled with the site, and cased in a dark edge so it reads on bright roofs
 * and dark forest alike. Presentation only: the boundary itself (the core
 * ribbon's centre line) does not move, and picking still selects the parcel.
 *
 * The core's ribbon (`packages/site-context/src/parcel-mesh.ts`) is 0.3 m wide
 * and 0.1 m above the terrain: honest as data, but sub-pixel once a whole site
 * is in view, and partly buried where the terrain grid undulates. Its
 * vertices come in (left, right) pairs across the boundary and every quad is
 * the index run `a+1, b+1, b, a+1, b, a` between pairs `a` and `b`.
 */

/** The core ribbon's own width, in metres. */
const CORE_RIBBON_WIDTH = 0.3;
/** Lift above the core's drape, in metres: clears the bilinear terrain between grid nodes. */
export const PARCEL_DISPLAY_LIFT = 0.25;
/** Drawn width per metre of site radius: about three pixels from a top view that frames the site. */
const WIDTH_PER_RADIUS = 0.0066;
const MIN_WIDTH = 0.6;
const MAX_WIDTH = 3.5;

/** The drawn width of the orange line for a site of `radius` metres: 0.66 m at 100 m, 2 m at 300 m, 3.3 m at 500 m. */
export function parcelDisplayWidth(radius: number): number {
  if (!Number.isFinite(radius) || radius <= 0) return 2;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, radius * WIDTH_PER_RADIUS));
}

/** The dark casing on each side of the line: a third of its width, at least 0.25 m. */
export function parcelCasingWidth(width: number): number {
  return Math.max(0.25, width / 3);
}

/** A pair's point at signed offset `t` from its midpoint, in units of the core half-width, plus `lift` up. */
function along(positions: Float32Array, pair: number, t: number, lift: number, out: number[]): void {
  const l = pair * 6;
  for (let axis = 0; axis < 3; axis++) {
    const left = positions[l + axis], right = positions[l + 3 + axis];
    const mid = (left + right) / 2;
    out.push(mid + (left - mid) * t + (axis === 2 ? lift : 0));
  }
}

/**
 * Widen the core ribbon about its centre line to `width`. Heights are
 * extrapolated along the pair's own cross-slope, so the wider ribbon still
 * follows the terrain it was draped on. Same vertex order and indices.
 */
export function widenParcelRibbon(positions: Float32Array, width: number, lift = PARCEL_DISPLAY_LIFT): Float32Array {
  const out: number[] = [];
  const t = width / CORE_RIBBON_WIDTH;
  for (let pair = 0; pair * 6 + 5 < positions.length; pair++) {
    along(positions, pair, t, lift, out);
    along(positions, pair, -t, lift, out);
  }
  return Float32Array.from(out);
}

/** The pairs every quad of the core ribbon joins, read from its index runs. */
function quadPairs(indices: Uint32Array): Array<[number, number]> {
  const quads: Array<[number, number]> = [];
  for (let k = 0; k + 5 < indices.length; k += 6) quads.push([indices[k + 5] / 2, indices[k + 2] / 2]);
  return quads;
}

/**
 * The dark casing: two strips just outside the widened line, one per side,
 * on the same draped surface and not overlapping it (no z-fighting). Four
 * vertices per pair: outer-left, inner-left, inner-right, outer-right.
 */
export function parcelCasing(
  positions: Float32Array, indices: Uint32Array, width: number, casing = parcelCasingWidth(width), lift = PARCEL_DISPLAY_LIFT,
): { positions: Float32Array; normals: Float32Array; indices: Uint32Array } {
  const inner = width / CORE_RIBBON_WIDTH;
  const outer = (width + 2 * casing) / CORE_RIBBON_WIDTH;
  const pos: number[] = [];
  for (let pair = 0; pair * 6 + 5 < positions.length; pair++) {
    along(positions, pair, outer, lift, pos);
    along(positions, pair, inner, lift, pos);
    along(positions, pair, -inner, lift, pos);
    along(positions, pair, -outer, lift, pos);
  }
  const idx: number[] = [];
  for (const [a, b] of quadPairs(indices)) {
    const p = a * 4, q = b * 4;
    idx.push(p, q, q + 1, p, q + 1, p + 1);           // left strip: outer → inner
    idx.push(p + 2, q + 2, q + 3, p + 2, q + 3, p + 3); // right strip: inner → outer
  }
  const normals = new Float32Array(pos.length);
  for (let i = 2; i < normals.length; i += 3) normals[i] = 1; // site frame: z up
  return { positions: Float32Array.from(pos), normals, indices: Uint32Array.from(idx) };
}
