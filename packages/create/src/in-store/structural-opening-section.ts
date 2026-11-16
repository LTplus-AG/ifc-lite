/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { vecCross, vecLen } from '../ifc-creator-math.js';
import { add, sub, scale, dot, areaVector } from './structural-derive-idealise.js';
import type { PrismFact, Vec3 } from './structural-derive-types.js';

/** Intersect the profile polygon with a plane; retain disjoint intervals explicitly. */
function profileIntervals(outline: Vec3[], origin: Vec3, normal: Vec3, offset: number): [Vec3, Vec3][] {
  const axis = vecCross(normal, areaVector(outline));
  const u = scale(axis, 1 / vecLen(axis));
  const coordinates = outline.map(p => [dot(sub(p, origin), u), dot(sub(p, origin), normal) - offset]);
  const hits: number[] = [];
  const epsilon = 1e-9;
  for (let i = 0; i < coordinates.length; i++) {
    const [a, b] = [coordinates[i], coordinates[(i + 1) % coordinates.length]];
    if (Math.abs(a[1]) <= epsilon) hits.push(a[0]);
    if ((a[1] < 0) !== (b[1] < 0)) hits.push(a[0] + (b[0] - a[0]) * a[1] / (a[1] - b[1]));
  }
  const sorted = hits.sort((a, b) => a - b).filter((v, i, a) => !i || v - a[i - 1] > epsilon);
  const intervals: [number, number][] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const mid = (sorted[i] + sorted[i + 1]) / 2;
    let inside = false;
    let onEdge = false;
    for (let j = 0; j < coordinates.length; j++) {
      const [a, b] = [coordinates[j], coordinates[(j + 1) % coordinates.length]];
      if (Math.abs(a[1]) <= epsilon && Math.abs(b[1]) <= epsilon && mid >= Math.min(a[0], b[0]) && mid <= Math.max(a[0], b[0])) onEdge = true;
      if ((a[1] > 0) !== (b[1] > 0) && mid < a[0] - a[1] * (b[0] - a[0]) / (b[1] - a[1])) inside = !inside;
    }
    if (!inside && !onEdge) continue;
    const last = intervals[intervals.length - 1];
    if (last && Math.abs(last[1] - sorted[i]) <= epsilon) last[1] = sorted[i + 1];
    else intervals.push([sorted[i], sorted[i + 1]]);
  }
  // normal projected into the profile plane locates its intersection line.
  const n = areaVector(outline);
  const profileNormal = scale(n, 1 / vecLen(n));
  const across = sub(normal, scale(profileNormal, dot(normal, profileNormal)));
  const base = add(outline[0], scale(across, (offset - dot(sub(outline[0], origin), normal)) / dot(across, normal)));
  return intervals.map(([a, b]) => [add(base, scale(u, a - dot(sub(base, origin), u))), add(base, scale(u, b - dot(sub(base, origin), u)))]);
}

/** Only normal and in-plane sweeps have the supported section construction. */
export function openingSection(prism: PrismFact, origin: Vec3, normal: Vec3, thickness: number, tolerance: number): Vec3[] | string {
  const depth = vecLen(prism.extrusion);
  const along = dot(prism.extrusion, normal);
  const cosine = Math.abs(along) / depth;
  const parallel = cosine >= Math.cos(Math.PI / 180);
  if (!(depth > 0) || (!parallel && cosine > Math.sin(Math.PI / 180))) return 'opening extrusion is oblique to the plate normal (more than 1 degree)';
  if (!parallel && vecLen(vecCross(normal, areaVector(prism.outline))) < 1e-12) return 'profile plane does not intersect the plate mid-plane in a line';
  const section = (offset: number): Vec3[] | string => {
    if (parallel) {
      const parameters = prism.outline.map(p => (offset - dot(sub(p, origin), normal)) / along);
      if (parameters.some(t => t < -1e-6 || t > 1 + 1e-6)) return 'opening does not span the plate thickness (not through)';
      return prism.outline.map((p, i) => add(p, scale(prism.extrusion, parameters[i])));
    }
    const base = profileIntervals(prism.outline, origin, normal, offset);
    const top = profileIntervals(prism.outline, origin, normal, offset - along);
    if (base.length !== 1 || top.length !== 1) return `opening profile section gives ${base.length !== 1 ? base.length : top.length} intervals (not through or not a single interval)`;
    return [base[0][0], base[0][1], add(top[0][1], prism.extrusion), add(top[0][0], prism.extrusion)];
  };
  const cut = section(0);
  if (typeof cut === 'string') return cut;
  const middle = parallel ? prism.outline.map(p => sub(p, scale(normal, dot(sub(p, origin), normal)))) : cut;
  for (const offset of [-thickness / 2, thickness / 2]) {
    const face = section(offset);
    if (typeof face === 'string') return face;
    if (face.some((p, i) => vecLen(sub(sub(p, scale(normal, offset)), middle[i])) > tolerance)) return 'opening section changes across plate faces (recess or tapered cut, not through)';
  }
  return middle;
}
