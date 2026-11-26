/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { vecCross, vecLen } from '../ifc-creator-math.js';
import { add, sub, scale, dot, areaVector } from './structural-derive-idealise.js';
import type { PhysicalElementFact, SkippedOpening, PrismFact, Vec3 } from './structural-derive-types.js';
import { OPENING_TYPES } from './hosted-fill-read.js';
import { pointInPolygon } from './polygon-2d.js';
import { checkOpening, type prepareStructuralFace } from './_structural-face.js';

const ANGLE_TOLERANCE = Math.PI / 180;

interface ProfileFrame {
  u: Vec3;
  across: Vec3;
  coordinates: [number, number][];
}

/** Intersect the profile polygon with a plane; retain disjoint intervals explicitly. */
function profileIntervals(outline: Vec3[], origin: Vec3, normal: Vec3, offset: number, frame: ProfileFrame, tolerance: number): [Vec3, Vec3][] {
  const { u, across } = frame;
  const coordinates = frame.coordinates.map(([x, y]): [number, number] => [x, y - offset]);
  const hits: number[] = [];
  const epsilon = 1e-9;
  for (let i = 0; i < coordinates.length; i++) {
    const [a, b] = [coordinates[i], coordinates[(i + 1) % coordinates.length]];
    if (Math.abs(a[1]) <= tolerance) hits.push(a[0]);
    if ((a[1] < 0) !== (b[1] < 0)) hits.push(a[0] + (b[0] - a[0]) * a[1] / (a[1] - b[1]));
  }
  const sorted = hits.sort((a, b) => a - b).filter((v, i, a) => !i || v - a[i - 1] > epsilon);
  const intervals: [number, number][] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const mid = (sorted[i] + sorted[i + 1]) / 2;
    const inside = pointInPolygon(mid, 0, coordinates);
    let onEdge = false;
    for (let j = 0; j < coordinates.length; j++) {
      const [a, b] = [coordinates[j], coordinates[(j + 1) % coordinates.length]];
      if (Math.abs(a[1]) <= tolerance && Math.abs(b[1]) <= tolerance && mid >= Math.min(a[0], b[0]) && mid <= Math.max(a[0], b[0])) onEdge = true;
    }
    if (!inside && !onEdge) continue;
    const last = intervals[intervals.length - 1];
    if (last && Math.abs(last[1] - sorted[i]) <= epsilon) last[1] = sorted[i + 1];
    else intervals.push([sorted[i], sorted[i + 1]]);
  }
  // normal projected into the profile plane locates its intersection line.
  const base = add(outline[0], scale(across, (offset - dot(sub(outline[0], origin), normal)) / dot(across, normal)));
  return intervals.map(([a, b]) => [add(base, scale(u, a - dot(sub(base, origin), u))), add(base, scale(u, b - dot(sub(base, origin), u)))]);
}

/** Only normal and in-plane sweeps have the supported section construction. */
export function openingSection(prism: PrismFact, origin: Vec3, normal: Vec3, thickness: number, tolerance: number): Vec3[] | string {
  const depth = vecLen(prism.extrusion);
  if (!(depth > 0)) return 'opening extrusion is degenerate (zero length)';
  const along = dot(prism.extrusion, normal);
  const cosine = Math.abs(along) / depth;
  const parallel = cosine >= Math.cos(ANGLE_TOLERANCE);
  if (!parallel && cosine > Math.sin(ANGLE_TOLERANCE)) return 'opening extrusion is oblique to the plate normal (more than 1 degree)';
  const area = areaVector(prism.outline);
  const axis = vecCross(normal, area);
  if (!parallel && vecLen(axis) < 1e-12) return 'profile plane does not intersect the plate mid-plane in a line';
  let frame: ProfileFrame | undefined;
  if (!parallel) {
    const profileNormal = scale(area, 1 / vecLen(area));
    const u = scale(axis, 1 / vecLen(axis));
    frame = {
      u, across: sub(normal, scale(profileNormal, dot(normal, profileNormal))),
      coordinates: prism.outline.map(p => [dot(sub(p, origin), u), dot(sub(p, origin), normal)]),
    };
  }
  const section = (offset: number): Vec3[] | string => {
    if (!frame) {
      const parameters = prism.outline.map(p => (offset - dot(sub(p, origin), normal)) / along);
      if (parameters.some(t => t < -tolerance / Math.abs(along) || t > 1 + tolerance / Math.abs(along))) return 'opening does not span the plate thickness (not through)';
      return prism.outline.map((p, i) => add(p, scale(prism.extrusion, parameters[i])));
    }
    const base = profileIntervals(prism.outline, origin, normal, offset, frame, tolerance);
    const top = profileIntervals(prism.outline, origin, normal, offset - along, frame, tolerance);
    if (base.length !== 1 || top.length !== 1) return `opening profile section gives ${base.length !== 1 ? base.length : top.length} intervals (not through or not a single interval)`;
    return [base[0][0], base[0][1], add(top[0][1], prism.extrusion), add(top[0][0], prism.extrusion)];
  };
  const middle = section(0);
  if (typeof middle === 'string') return middle;
  for (const offset of [-thickness / 2, thickness / 2]) {
    const face = section(offset);
    if (typeof face === 'string') return face;
    // A near-normal sweep translates each section along its own in-plane direction.
    const drift = parallel ? scale(prism.extrusion, offset / along) : scale(normal, offset);
    if (face.some((p, i) => vecLen(sub(sub(p, drift), middle[i])) > tolerance)) return 'opening section changes across plate faces (recess or tapered cut, not through)';
  }
  return middle;
}

/** Through-openings only; report the opening id rather than hiding it on its host. */
export function plateOpenings(element: PhysicalElementFact, plate: { boundary: Vec3[]; thickness: number }, face: ReturnType<typeof prepareStructuralFace>, tolerance: number, skipped: SkippedOpening[]): Vec3[][] {
  if (!element.openings?.length) return [];
  const normal = face.axis;
  const carried: Vec3[][] = [];
  const accepted: Vec3[][] = [];
  for (const [index, opening] of element.openings.entries()) {
    const reject = (reason: SkippedOpening['reason'], detail: string) => skipped.push({ openingId: opening.expressId, hostId: element.expressId, name: opening.name, reason, detail });
    if (opening.type && !OPENING_TYPES.has(opening.type.toUpperCase())) { reject('unsupported-voiding-type', opening.shapeIssue ?? `unsupported voiding type ${opening.type}`); continue; }
    const prism = opening.prism;
    if (!prism) { reject('unreadable-opening', opening.shapeIssue ?? 'unreadable body'); continue; }
    if (prism.profileHasVoids) { reject('opening-profile-has-voids', 'opening profile has inner voids'); continue; }
    // A hole larger than the physical cut would remove material the element keeps.
    if (prism.outlineRounded) { reject('unsupported-opening-section', 'rounded profile corners are not carried'); continue; }
    if (!prism.outlineExact) { reject('unsupported-opening-section', 'profile outline is known only as bounds'); continue; }
    const ring = openingSection(prism, plate.boundary[0], normal, plate.thickness, tolerance);
    if (typeof ring === 'string') { reject('unsupported-opening-section', ring); continue; }
    try { accepted.push(checkOpening(face, ring, accepted, { clearance: tolerance, index })); }
    catch (error) { reject('invalid-opening-ring', error instanceof Error ? error.message : String(error)); continue; }
    carried.push(ring);
  }
  return carried;
}
