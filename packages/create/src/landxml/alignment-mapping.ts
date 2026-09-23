/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * LandXML horizontal alignment → `IfcAlignmentHorizontalSegment` parameters
 * (mapping spec §11).
 *
 * Pure numbers in, pure numbers out: no STEP is written here, so the export
 * dialog can run the same mapping as a cheap pre-flight and the refusal it
 * shows is the refusal the export would give.
 *
 * Conventions (§11.3), each of which is a place a sign error hides:
 * - points are `(easting, northing)` in metres — LandXML authors them
 *   northing-first, and `planPoint` is the one place that swaps them;
 * - directions are radians, counter-clockwise from +X (east);
 * - radii are POSITIVE for a counter-clockwise (left) turn, negative for
 *   clockwise, and `0` for infinite.
 *
 * And the check that catches a sign error (§11.4): every segment is integrated
 * to its end and compared with the AUTHORED end. A curve written the wrong way
 * round lands somewhere else, and the refusal says where.
 */

import type {
  LandXmlIfcAlignment, LandXmlIfcAlignmentPrimitive, LandXmlIfcLocation, LandXmlIfcRadius,
  LandXmlIfcRotation, LandXmlIfcUnits,
} from './source-types.js';

export type HorizontalSegmentType = 'LINE' | 'CIRCULARARC' | 'CLOTHOID';

/** One `IfcAlignmentHorizontalSegment`, in metres and radians. */
export interface HorizontalSegment {
  sourceId: string;
  type: HorizontalSegmentType;
  start: readonly [number, number];
  /** `StartDirection`: radians, counter-clockwise from +X. */
  direction: number;
  /** Signed: positive = counter-clockwise; 0 = infinite. */
  startRadius: number;
  endRadius: number;
  length: number;
  /** Evaluated end state — for the transition code and the terminating segment. */
  end: readonly [number, number];
  endDirection: number;
  /** Signed curvature at start and end (1/R, 0 for infinite). */
  startCurvature: number;
  endCurvature: number;
}

export interface MappedAlignment {
  sourceId: string;
  name: string;
  /** Station at distance 0, in metres. */
  startStation: number;
  segments: HorizontalSegment[];
}

export interface RefusedAlignment {
  sourceId: string;
  name: string;
  reason: string;
}

export interface AlignmentMapping {
  mapped: MappedAlignment[];
  refused: RefusedAlignment[];
}

/**
 * Position tolerance for §11.4, in metres. LandXML coordinates are routinely
 * authored to the millimetre and lengths/radii rounded independently of them,
 * so a correctly-signed segment reproduces its authored end to within a few
 * millimetres. A sign error misses by metres. One centimetre separates the two
 * with a wide margin on both sides.
 */
export const ALIGNMENT_POSITION_TOLERANCE_M = 0.01;

/** Resolves a `pntRef` to authored coordinates, or `null`. */
export type PointResolver = (pntRef: string) => { northing: number; easting: number } | null;

class Refusal extends Error {}

function refuse(message: string): never {
  throw new Refusal(message);
}

/** Authored northing-first → `(easting, northing)` metres; the one swap for alignments. */
function planPoint(
  location: LandXmlIfcLocation, units: LandXmlIfcUnits, swap: boolean, resolve: PointResolver, what: string,
): [number, number] {
  let point: { northing: number; easting: number } | null;
  if (location.kind === 'coordinates') {
    point = location.point;
  } else {
    point = resolve(location.pntRef);
    if (!point) refuse(`${what} references point '${location.pntRef}', which the file does not define uniquely`);
  }
  if (!Number.isFinite(point.northing) || !Number.isFinite(point.easting)) refuse(`${what} has a non-finite coordinate`);
  const scale = units.linearScaleToMeters;
  // `swap` is the operator's confirmed override for an easting-first producer
  // (§2.2); it reverses this function's own swap.
  return swap
    ? [point.northing * scale, point.easting * scale]
    : [point.easting * scale, point.northing * scale];
}

function distance(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** Normalise to (-π, π]. */
function wrap(angle: number): number {
  let a = angle % (2 * Math.PI);
  if (a <= -Math.PI) a += 2 * Math.PI;
  if (a > Math.PI) a -= 2 * Math.PI;
  return a;
}

function signFor(rotation: LandXmlIfcRotation): 1 | -1 {
  return rotation === 'counter_clockwise' ? 1 : -1;
}

function curvatureOf(radius: number): number {
  return radius === 0 ? 0 : 1 / radius;
}

/**
 * Integrate position along a segment with linearly varying curvature — exact
 * for a line, arc and clothoid, which is every type v1.1 writes. Composite
 * Simpson on the heading `θ(s) = θ0 + κ0·s + (κ1 − κ0)·s² / (2L)`.
 */
export function evaluateSegment(
  start: readonly [number, number], direction: number, startCurvature: number, endCurvature: number,
  length: number, at: number = length,
): { point: [number, number]; direction: number } {
  const heading = (s: number): number =>
    direction + startCurvature * s + (length === 0 ? 0 : ((endCurvature - startCurvature) * s * s) / (2 * length));
  if (at === 0) return { point: [start[0], start[1]], direction };
  const steps = Math.min(4096, Math.max(64, 2 * Math.ceil(at)));
  const h = at / steps;
  let x = 0;
  let y = 0;
  for (let i = 0; i <= steps; i += 1) {
    const weight = i === 0 || i === steps ? 1 : i % 2 === 1 ? 4 : 2;
    const theta = heading(i * h);
    x += weight * Math.cos(theta);
    y += weight * Math.sin(theta);
  }
  return { point: [start[0] + (x * h) / 3, start[1] + (y * h) / 3], direction: heading(at) };
}

function radiusValue(radius: LandXmlIfcRadius | undefined, units: LandXmlIfcUnits, what: string): number {
  if (radius === undefined) refuse(`${what} declares no radius`);
  if (radius === 'infinite') return 0;
  if (!Number.isFinite(radius) || radius <= 0) refuse(`${what} has an invalid radius (${String(radius)})`);
  return radius * units.linearScaleToMeters;
}

function mapPrimitive(
  primitive: LandXmlIfcAlignmentPrimitive, sourceId: string, units: LandXmlIfcUnits, swap: boolean,
  resolve: PointResolver, label: string,
): { segment: Omit<HorizontalSegment, 'end' | 'endDirection'>; authoredEnd: [number, number] } {
  const point = (location: LandXmlIfcLocation, role: string): [number, number] =>
    planPoint(location, units, swap, resolve, `${label} ${role}`);

  switch (primitive.kind) {
    case 'line': {
      const start = point(primitive.start, 'start');
      const end = point(primitive.end, 'end');
      const length = distance(start, end);
      if (length === 0) refuse(`${label} is a zero-length line`);
      return {
        segment: {
          sourceId, type: 'LINE', start, direction: Math.atan2(end[1] - start[1], end[0] - start[0]),
          startRadius: 0, endRadius: 0, length, startCurvature: 0, endCurvature: 0,
        },
        authoredEnd: end,
      };
    }
    case 'curve': {
      const start = point(primitive.start, 'start');
      const center = point(primitive.center, 'center');
      const end = point(primitive.end, 'end');
      const radius = distance(center, start);
      if (radius === 0) refuse(`${label} has its center on its start point`);
      const sign = signFor(primitive.rotation);
      const radial = Math.atan2(start[1] - center[1], start[0] - center[0]);
      // The tangent is the radial direction turned a quarter towards travel:
      // +90° for a counter-clockwise arc, −90° for clockwise.
      const direction = radial + (sign * Math.PI) / 2;
      const endRadial = Math.atan2(end[1] - center[1], end[0] - center[0]);
      // Sweep in the direction of travel, in (0, 2π].
      let sweep = sign * (endRadial - radial);
      sweep = ((sweep % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      if (sweep === 0) sweep = 2 * Math.PI;
      const signedRadius = sign * radius;
      const length = radius * sweep;
      // The end-point check CANNOT catch a flipped `rot` on an arc: start,
      // centre and end describe one circle, and the other rotation is simply
      // the other arc of it — ending at the same point. The authored length is
      // what tells a 90° arc from its 270° complement, so when LandXML states
      // one it must agree.
      if (primitive.declaredLength !== null) {
        const declared = primitive.declaredLength * units.linearScaleToMeters;
        if (Math.abs(declared - length) > ALIGNMENT_POSITION_TOLERANCE_M) {
          refuse(
            `${label} is ${length.toFixed(3)} m long going ${primitive.rotation.replace('_', '-')}, but declares `
            + `${declared.toFixed(3)} m — its rotation may be the other way round`,
          );
        }
      }
      return {
        segment: {
          sourceId, type: 'CIRCULARARC', start, direction, startRadius: signedRadius, endRadius: signedRadius,
          length, startCurvature: 1 / signedRadius, endCurvature: 1 / signedRadius,
        },
        authoredEnd: end,
      };
    }
    case 'spiral': {
      if (primitive.spiType !== 'clothoid') {
        refuse(`${label} is a '${primitive.spiType}' spiral; only clothoid spirals have a mapping`);
      }
      const start = point(primitive.start, 'start');
      const pi = point(primitive.pi, 'PI');
      const end = point(primitive.end, 'end');
      const length = primitive.declaredLength * units.linearScaleToMeters;
      if (!Number.isFinite(length) || length <= 0) refuse(`${label} has an invalid length`);
      // The tangent at the start points at the spiral's PI.
      const direction = Math.atan2(pi[1] - start[1], pi[0] - start[0]);
      // An authored `rot` wins; without one the turn is read from the PI.
      const cross = (pi[0] - start[0]) * (end[1] - pi[1]) - (pi[1] - start[1]) * (end[0] - pi[0]);
      const rotation: LandXmlIfcRotation = primitive.rotation
        ?? (cross > 0 ? 'counter_clockwise' : cross < 0 ? 'clockwise' : refuse(`${label} does not turn`));
      const sign = signFor(rotation);
      // `|| 0` folds the `-0` a clockwise infinite radius would produce.
      const startRadius = sign * radiusValue(primitive.radiusStart, units, `${label} start`) || 0;
      const endRadius = sign * radiusValue(primitive.radiusEnd, units, `${label} end`) || 0;
      if (startRadius === endRadius) refuse(`${label} has equal start and end radius — not a transition`);
      return {
        segment: {
          sourceId, type: 'CLOTHOID', start, direction, startRadius, endRadius, length,
          startCurvature: curvatureOf(startRadius), endCurvature: curvatureOf(endRadius),
        },
        authoredEnd: end,
      };
    }
    case 'unsupported_spiral':
      return refuse(`${label} is a '${primitive.spiType}' spiral; only clothoid spirals have a mapping`);
    case 'irregular_line':
      return refuse(`${label} is an IrregularLine, which has no IfcAlignmentHorizontalSegment type`);
    default:
      return refuse(`${label} has an unrecognised geometry type`);
  }
}

function mapOne(
  alignment: LandXmlIfcAlignment, units: LandXmlIfcUnits, swap: boolean, resolve: PointResolver,
): MappedAlignment {
  const ordered = [...(alignment.segments ?? [])].sort((a, b) => a.ordinal - b.ordinal);
  if (ordered.length === 0) refuse('it has no horizontal geometry');

  const segments: HorizontalSegment[] = [];
  let previousAuthoredEnd: [number, number] | null = null;
  ordered.forEach((entry, index) => {
    const label = `segment ${index + 1}`;
    const { segment, authoredEnd } = mapPrimitive(entry.primitive, entry.sourceId, units, swap, resolve, label);

    // Continuity with the previous segment's AUTHORED end (§11.4): a gap is a
    // wrong alignment, not a short one.
    if (previousAuthoredEnd) {
      const gap = distance(previousAuthoredEnd, segment.start);
      if (gap > ALIGNMENT_POSITION_TOLERANCE_M) {
        refuse(`${label} starts ${gap.toFixed(3)} m from where segment ${index} ends`);
      }
    }

    // The sign check: integrate the parameters and land on the authored end.
    const evaluated = evaluateSegment(
      segment.start, segment.direction, segment.startCurvature, segment.endCurvature, segment.length,
    );
    const miss = distance(evaluated.point, authoredEnd);
    if (miss > ALIGNMENT_POSITION_TOLERANCE_M) {
      refuse(`${label}'s parameters end ${miss.toFixed(3)} m from its authored end point`);
    }

    segments.push({ ...segment, end: evaluated.point, endDirection: wrap(evaluated.direction) });
    previousAuthoredEnd = authoredEnd;
  });

  return {
    sourceId: alignment.sourceId,
    name: alignment.name,
    startStation: alignment.staStart * units.linearScaleToMeters,
    segments,
  };
}

/**
 * Map every alignment, splitting them into written and refused (§11.2).
 *
 * An alignment is refused WHOLE rather than written with a gap: every station
 * after a missing segment would be wrong.
 */
/**
 * Is this record shaped like a `LandXmlIfcAlignment`? The source field is
 * `unknown[]` (see `LandXmlIfcSource.alignments`), so the shape is checked
 * here rather than trusted: a record that fails is refused by name.
 */
export function isAlignmentRecord(value: unknown): value is LandXmlIfcAlignment {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.sourceId === 'string'
    && (record.name === undefined || typeof record.name === 'string')
    && typeof record.staStart === 'number' && Number.isFinite(record.staStart)
    && Array.isArray(record.segments);
}

export function mapAlignments(
  alignments: readonly unknown[] | undefined, units: LandXmlIfcUnits | null, swap: boolean,
  resolve: PointResolver,
): AlignmentMapping {
  const result: AlignmentMapping = { mapped: [], refused: [] };
  (alignments ?? []).forEach((candidate, index) => {
    if (!isAlignmentRecord(candidate)) {
      result.refused.push({
        sourceId: `alignment[${index}]`, name: `alignment ${index + 1}`,
        reason: 'it is not an alignment record (it needs a sourceId, a numeric staStart and a segments list)',
      });
      return;
    }
    mapOneInto(result, candidate, units, swap, resolve);
  });
  return result;
}

function mapOneInto(
  result: AlignmentMapping, alignment: LandXmlIfcAlignment, units: LandXmlIfcUnits | null, swap: boolean,
  resolve: PointResolver,
): void {
  const name = alignment.name || alignment.sourceId;
  if (units === null) {
    result.refused.push({ sourceId: alignment.sourceId, name, reason: 'the file declares no units' });
    return;
  }
  try {
    result.mapped.push(mapOne(alignment, units, swap, resolve));
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    result.refused.push({ sourceId: alignment.sourceId, name, reason: error.message });
  }
}

/**
 * A resolver over the file's `CgPoint`s, by name. A name used twice resolves
 * to nothing: guessing which of two same-named points an alignment meant would
 * silently move the alignment.
 */
export function cogoPointResolver(
  points: ReadonlyArray<{ name: string | null; point: { northing: number; easting: number } | null }> | undefined,
): PointResolver {
  const byName = new Map<string, { northing: number; easting: number } | null>();
  for (const entry of points ?? []) {
    if (!entry.name || !entry.point) continue;
    byName.set(entry.name, byName.has(entry.name) ? null : entry.point);
  }
  return (pntRef) => byName.get(pntRef) ?? null;
}
