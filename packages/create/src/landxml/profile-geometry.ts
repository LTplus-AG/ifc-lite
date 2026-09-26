/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A LandXML design profile → `IfcAlignmentVerticalSegment` parameters
 * (mapping spec §12.3–§12.5). Pure numbers: metres of distance along and of
 * height, gradients as rise/run.
 *
 * The profile is authored as PVIs — tangent intersections — with a vertical
 * curve at some of them. IFC wants the segments BETWEEN: grades, and the curves
 * that round the PVIs off. This module turns the one into the other and then
 * checks that the result passes through every authored point it should
 * (§12.5), which is where a sign or a half-length error shows.
 */

import { ALIGNMENT_POSITION_TOLERANCE_M } from './alignment-mapping.js';
import type { LandXmlIfcVerticalCurve } from './profile-record.js';

export type VerticalSegmentType = 'CONSTANTGRADIENT' | 'PARABOLICARC' | 'CIRCULARARC';

/** One `IfcAlignmentVerticalSegment`, in metres. */
export interface VerticalSegment {
  sourceId: string;
  type: VerticalSegmentType;
  startDistAlong: number;
  horizontalLength: number;
  startHeight: number;
  startGradient: number;
  endGradient: number;
  /** Signed: positive for a sag (counter-clockwise in distance/height), negative for a crest; `null` for a grade. */
  radiusOfCurvature: number | null;
}

/** A PVI in metres: distance along the horizontal, and height. */
export interface ProfileVertex {
  sourceId: string;
  distAlong: number;
  height: number;
}

export class ProfileRefusal extends Error {}

export function refuseProfile(message: string): never {
  throw new ProfileRefusal(message);
}

/** A grade or curve joins its neighbours to well under this; floating noise only. */
const JOIN_EPSILON_M = 1e-6;

/**
 * Height and gradient `x` metres into a segment (0 ≤ x ≤ horizontalLength).
 * The circle is evaluated from its centre, which sits `R` to the left of the
 * start tangent for a sag and to the right for a crest.
 */
export function evaluateVertical(segment: VerticalSegment, x: number): { height: number; gradient: number } {
  const { startHeight: h0, startGradient: g0, endGradient: g1, horizontalLength: L } = segment;
  if (segment.type === 'CONSTANTGRADIENT' || L === 0) return { height: h0 + g0 * x, gradient: g0 };
  if (segment.type === 'PARABOLICARC') {
    return { height: h0 + g0 * x + ((g1 - g0) * x * x) / (2 * L), gradient: g0 + ((g1 - g0) * x) / L };
  }
  const radius = Math.abs(segment.radiusOfCurvature ?? 0);
  const sag = g1 > g0;
  const theta = Math.atan(g0);
  const side = sag ? 1 : -1;
  const cx = -side * radius * Math.sin(theta);
  const cy = side * radius * Math.cos(theta);
  const dx = x - cx;
  const root = Math.sqrt(Math.max(0, radius * radius - dx * dx));
  return { height: h0 + cy - side * root, gradient: side * dx / root };
}

/** Height of the whole profile at a distance along, or `null` outside it. */
export function profileHeightAt(segments: readonly VerticalSegment[], distAlong: number): number | null {
  for (const segment of segments) {
    const x = distAlong - segment.startDistAlong;
    if (x >= -JOIN_EPSILON_M && x <= segment.horizontalLength + JOIN_EPSILON_M) {
      return evaluateVertical(segment, Math.min(Math.max(x, 0), segment.horizontalLength)).height;
    }
  }
  return null;
}

function positive(value: number | null, scale: number, what: string): number {
  if (value === null || !Number.isFinite(value) || value <= 0) refuseProfile(`${what} is missing or not positive`);
  return value * scale;
}

/**
 * A grade change at or below this is no change: two grades computed from PVIs
 * on one straight line differ by rounding (3.5e-17 for 0.001, #5930 review),
 * and a "curve" between them has no representable curvature.
 */
const GRADE_EPSILON = 1e-9;

/**
 * The segments that round off one PVI, in order — none for an equal-grade
 * parabola, whose curve is the grade itself (§12.4).
 */
export function curveSegments(
  curve: LandXmlIfcVerticalCurve, pvi: ProfileVertex, gradeIn: number, gradeOut: number,
  units: { linearScaleToMeters: number; elevationScaleToMeters: number }, label: string,
): VerticalSegment[] {
  const scale = units.linearScaleToMeters;
  const rawDelta = gradeOut - gradeIn;
  const delta = Math.abs(rawDelta) <= GRADE_EPSILON ? 0 : rawDelta;
  const { distAlong: d, height: h } = pvi;
  switch (curve.kind) {
    case 'parabolic': {
      const L = positive(curve.length, scale, `${label}'s length`);
      if (delta === 0) return [];
      return [{
        sourceId: curve.sourceId, type: 'PARABOLICARC', startDistAlong: d - L / 2, horizontalLength: L,
        startHeight: h - (gradeIn * L) / 2, startGradient: gradeIn, endGradient: gradeOut, radiusOfCurvature: L / delta,
      }];
    }
    case 'unsymmetrical_parabolic': {
      const lengthIn = positive(curve.lengthIn, scale, `${label}'s lengthIn`);
      const lengthOut = positive(curve.lengthOut, scale, `${label}'s lengthOut`);
      if (delta === 0) return [];
      // Two parabolas sharing height and gradient at the PVI station (§12.3).
      const middle = gradeIn + (delta * lengthOut) / (lengthIn + lengthOut);
      const startHeight = h - gradeIn * lengthIn;
      return [
        {
          sourceId: `${curve.sourceId}:in`, type: 'PARABOLICARC', startDistAlong: d - lengthIn,
          horizontalLength: lengthIn, startHeight, startGradient: gradeIn, endGradient: middle,
          radiusOfCurvature: lengthIn / (middle - gradeIn),
        },
        {
          sourceId: `${curve.sourceId}:out`, type: 'PARABOLICARC', startDistAlong: d, horizontalLength: lengthOut,
          startHeight: startHeight + ((gradeIn + middle) / 2) * lengthIn, startGradient: middle,
          endGradient: gradeOut, radiusOfCurvature: lengthOut / (gradeOut - middle),
        },
      ];
    }
    case 'circular': {
      if (units.linearScaleToMeters !== units.elevationScaleToMeters) {
        refuseProfile(`${label} is a circular curve in a file whose elevation unit differs from its linear unit, so its radius has no single unit`);
      }
      if (delta === 0) refuseProfile(`${label} is a circular curve between two equal grades`);
      // Some producers sign the radius, negative for a crest (§12.4). A sign
      // that contradicts the grades is refused rather than trusted either way.
      if (curve.radius !== null && curve.radius < 0 && delta > 0) {
        refuseProfile(`${label} declares a negative (crest) radius, but its grades make a sag`);
      }
      const radius = positive(curve.radius === null ? null : Math.abs(curve.radius), scale, `${label}'s radius`);
      const t1 = Math.atan(gradeIn);
      const t2 = Math.atan(gradeOut);
      const tangent = radius * Math.tan(Math.abs(t2 - t1) / 2);
      const horizontal = radius * Math.abs(Math.sin(t2) - Math.sin(t1));
      const arc = radius * Math.abs(t2 - t1);
      // Radius and grades fix the curve; the declared length only confirms
      // them. Producers differ on which length they mean (§12.4), so either
      // agreeing is agreement, and neither is a contradiction.
      const declared = positive(curve.length, scale, `${label}'s length`);
      if (Math.min(Math.abs(declared - horizontal), Math.abs(declared - arc)) > ALIGNMENT_POSITION_TOLERANCE_M) {
        refuseProfile(
          `${label} declares a length of ${declared.toFixed(3)} m, but its radius and grades give an arc length of `
          + `${arc.toFixed(3)} m (horizontal length ${horizontal.toFixed(3)} m)`,
        );
      }
      return [{
        sourceId: curve.sourceId, type: 'CIRCULARARC', startDistAlong: d - tangent * Math.cos(t1),
        horizontalLength: horizontal, startHeight: h - tangent * Math.sin(t1), startGradient: gradeIn,
        endGradient: gradeOut, radiusOfCurvature: Math.sign(delta) * radius,
      }];
    }
    default:
      return refuseProfile(`${label} has an unrecognised vertical curve type`);
  }
}

function grade(sourceId: string, from: number, to: number, a: ProfileVertex, b: ProfileVertex): VerticalSegment {
  const g = (b.height - a.height) / (b.distAlong - a.distAlong);
  return {
    sourceId, type: 'CONSTANTGRADIENT', startDistAlong: from, horizontalLength: to - from,
    startHeight: a.height + g * (from - a.distAlong), startGradient: g, endGradient: g, radiusOfCurvature: null,
  };
}

/**
 * Assemble grades and curves between the PVIs. `curves[i]` holds the
 * segments rounding off PVI `i` (empty for a bare grade break).
 */
export function assembleProfile(
  profileSourceId: string, vertices: readonly ProfileVertex[], curves: readonly VerticalSegment[][],
): VerticalSegment[] {
  const segments: VerticalSegment[] = [];
  let cursor = vertices[0].distAlong;
  const addGrade = (to: number, leg: number): void => {
    const length = to - cursor;
    if (length < -JOIN_EPSILON_M) {
      refuseProfile(`the vertical curve at PVI ${leg + 1} starts ${(-length).toFixed(3)} m before the previous one ends`);
    }
    if (length > JOIN_EPSILON_M) {
      segments.push(grade(`${profileSourceId}:grade:${segments.length}`, cursor, to, vertices[leg - 1], vertices[leg]));
    }
    cursor = Math.max(cursor, to);
  };
  for (let index = 1; index < vertices.length; index += 1) {
    const pieces = curves[index] ?? [];
    if (pieces.length === 0) {
      addGrade(vertices[index].distAlong, index);
      continue;
    }
    addGrade(pieces[0].startDistAlong, index);
    const last = pieces[pieces.length - 1];
    const end = last.startDistAlong + last.horizontalLength;
    if (end > vertices[index + 1].distAlong + JOIN_EPSILON_M) {
      refuseProfile(`the vertical curve at PVI ${index + 1} ends ${(end - vertices[index + 1].distAlong).toFixed(3)} m past PVI ${index + 2}`);
    }
    // A join closer than the epsilon is the same point: snap the curve onto
    // the cursor so no sub-micrometre gap reaches the written curve.
    if (Math.abs(pieces[0].startDistAlong - cursor) <= JOIN_EPSILON_M) pieces[0].startDistAlong = cursor;
    segments.push(...pieces);
    cursor = end;
  }
  return segments;
}

/** §12.5: joins are continuous, and the profile passes through what it must. */
export function checkProfile(
  segments: readonly VerticalSegment[], vertices: readonly ProfileVertex[], curves: readonly VerticalSegment[][],
): void {
  const tolerance = ALIGNMENT_POSITION_TOLERANCE_M;
  segments.slice(1).forEach((next, index) => {
    const previous = segments[index];
    const end = evaluateVertical(previous, previous.horizontalLength);
    const heightGap = Math.abs(end.height - next.startHeight);
    const gradeGap = Math.abs(end.gradient - next.startGradient);
    const distGap = Math.abs(previous.startDistAlong + previous.horizontalLength - next.startDistAlong);
    // Only a bare grade break (two grades meeting at a PVI) may change gradient.
    const gradeBreak = previous.type === 'CONSTANTGRADIENT' && next.type === 'CONSTANTGRADIENT';
    if (distGap > tolerance || heightGap > tolerance || (gradeGap > 1e-6 && !gradeBreak)) {
      refuseProfile(`vertical segment ${index + 2} does not continue segment ${index + 1} (height gap ${heightGap.toFixed(4)} m)`);
    }
  });
  vertices.forEach((vertex, index) => {
    const pieces = curves[index] ?? [];
    if (pieces.length === 0) {
      const height = profileHeightAt(segments, vertex.distAlong);
      if (height === null || Math.abs(height - vertex.height) > tolerance) {
        refuseProfile(`the profile misses PVI ${index + 1} (${height === null ? 'not reached' : `${Math.abs(height - vertex.height).toFixed(4)} m`})`);
      }
      return;
    }
    // A curve's PVI is a tangent intersection: both tangents, extended, meet it.
    const first = pieces[0];
    const last = pieces[pieces.length - 1];
    const lastEnd = evaluateVertical(last, last.horizontalLength);
    const back = first.startHeight + first.startGradient * (vertex.distAlong - first.startDistAlong);
    const ahead = lastEnd.height - last.endGradient * (last.startDistAlong + last.horizontalLength - vertex.distAlong);
    if (Math.abs(back - vertex.height) > tolerance || Math.abs(ahead - vertex.height) > tolerance) {
      refuseProfile(`the tangents of the vertical curve at PVI ${index + 1} do not meet at its authored point`);
    }
  });
}
