/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Prism to analytical line or mid-plane, the geometric half of the rules in
 * `structural-derive-types.ts`. Pure: world metres in, world metres out, or
 * the reason the prism cannot be idealised.
 */

import { vecCross as cross, vecLen as length } from '../ifc-creator-math.js';
import type { PrismFact, Vec3 } from './structural-derive-types.js';

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Twice the area of a planar polygon, along its normal (counter-clockwise positive). */
export function areaVector(polygon: readonly Vec3[]): Vec3 {
  let area: Vec3 = [0, 0, 0];
  for (let i = 1; i + 1 < polygon.length; i++) area = add(area, cross(sub(polygon[i], polygon[0]), sub(polygon[i + 1], polygon[0])));
  return area;
}

/** Below this |cos| between extrusion and outline normal the prism is oblique (about 2.6 degrees). */
const PERPENDICULAR_COS = 0.999;
/** A profile filling at least this share of its bounds counts as a rectangle (mitred wall ends pass). */
const NEAR_RECTANGLE = 0.9;

interface PrismFrame {
  /** Long and short in-plane directions of the profile bounds. */
  u: Vec3;
  v: Vec3;
  /** Centre of the profile bounds, on the base plane. */
  centre: Vec3;
  /** Extents along u (long) and v (short). */
  long: number;
  short: number;
  depth: number;
  oblique: boolean;
  nearRectangle: boolean;
}

function prismFrame(prism: PrismFact): PrismFrame | string {
  const { outline, extrusion } = prism;
  if (outline.length < 3) return 'profile outline has fewer than three points';
  const origin = outline[0];
  const area = areaVector(outline);
  const areaSize = length(area) / 2;
  const depth = length(extrusion);
  if (!(areaSize > 1e-12) || !(depth > 1e-9)) return 'degenerate prism (zero profile area or depth)';
  const n = scale(area, 1 / (2 * areaSize));
  // Long side: the longest outline edge, projected into the profile plane.
  let edge: Vec3 = [0, 0, 0];
  for (let i = 0; i < outline.length; i++) {
    const e = sub(outline[(i + 1) % outline.length], outline[i]);
    if (length(e) > length(edge)) edge = e;
  }
  const inPlane = sub(edge, scale(n, dot(edge, n)));
  let u = scale(inPlane, 1 / length(inPlane));
  let v = cross(n, u);
  const span = (axis: Vec3) => {
    const values = outline.map((p) => dot(sub(p, origin), axis));
    return [Math.min(...values), Math.max(...values)] as const;
  };
  let [uMin, uMax] = span(u);
  let [vMin, vMax] = span(v);
  if (vMax - vMin > uMax - uMin) {
    [u, v] = [v, scale(u, -1)];
    [[uMin, uMax], [vMin, vMax]] = [span(u), span(v)];
  }
  const long = uMax - uMin;
  const short = vMax - vMin;
  return {
    u, v, long, short, depth,
    centre: add(origin, add(scale(u, (uMin + uMax) / 2), scale(v, (vMin + vMax) / 2))),
    oblique: Math.abs(dot(extrusion, n)) / depth < PERPENDICULAR_COS,
    nearRectangle: prism.outlineExact && areaSize >= NEAR_RECTANGLE * long * short,
  };
}

type LineIdealisation = { start: Vec3; end: Vec3; source: 'extrusion' | 'profile' } | { issue: string };

/** The prism's axis: along the extrusion when that is its longest side, else along a near-rectangular profile's long side. */
export function idealiseLine(prism: PrismFact): LineIdealisation {
  const f = prismFrame(prism);
  if (typeof f === 'string') return { issue: f };
  if (f.depth >= f.long) return { start: f.centre, end: add(f.centre, prism.extrusion), source: 'extrusion' };
  if (f.nearRectangle && !f.oblique) {
    const mid = add(f.centre, scale(prism.extrusion, 0.5));
    const half = scale(f.u, f.long / 2);
    return { start: sub(mid, half), end: add(mid, half), source: 'profile' };
  }
  return { issue: 'the prism is longest across its profile, and the profile is not a near-rectangle' };
}

type PlateIdealisation = { boundary: Vec3[]; thickness: number } | { issue: string };

/** The prism's mid-plane across its thinnest side, with that side as thickness. */
export function idealisePlate(prism: PrismFact): PlateIdealisation {
  const f = prismFrame(prism);
  if (typeof f === 'string') return { issue: f };
  if (f.oblique) return { issue: 'the extrusion is oblique to its profile' };
  if (f.depth <= f.short) {
    if (!prism.outlineExact) return { issue: 'the profile outline is known only as bounds' };
    const half = scale(prism.extrusion, 0.5);
    return { boundary: prism.outline.map((p) => add(p, half)), thickness: f.depth };
  }
  if (!f.nearRectangle) return { issue: 'the profile is thinner than the extrusion but not a near-rectangle' };
  const half = scale(f.u, f.long / 2);
  const a = sub(f.centre, half);
  const b = add(f.centre, half);
  return { boundary: [a, b, add(b, prism.extrusion), add(a, prism.extrusion)], thickness: f.short };
}
