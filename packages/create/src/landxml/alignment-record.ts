/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Run-time shape check for `LandXmlIfcSource.alignments`, which is `unknown[]`
 * (narrowing a published input type is a breaking change, #5370 review).
 *
 * The check goes all the way down to each location: a record whose header is
 * fine but whose segment is `{}` used to pass, and the mapper then threw a
 * `TypeError` out of the pre-flight and the export instead of refusing that
 * alignment by name.
 */

import type { LandXmlIfcAlignment } from './source-types.js';

type Fields = Record<string, unknown>;

const isObject = (value: unknown): value is Fields => typeof value === 'object' && value !== null;
const isNumber = (value: unknown): boolean => typeof value === 'number';
/** A length must be finite: `NaN` fails every `>` comparison, so it would pass the length checks unseen. */
const isLength = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value);
const isOptionalLength = (value: unknown): boolean => value === null || isLength(value);
const isRotation = (value: unknown): boolean => value === 'clockwise' || value === 'counter_clockwise';
const isRadius = (value: unknown): boolean => value === undefined || value === 'infinite' || isNumber(value);

function isLocation(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.kind === 'point_reference') return typeof value.pntRef === 'string';
  return value.kind === 'coordinates' && isObject(value.point)
    && isNumber(value.point.northing) && isNumber(value.point.easting);
}

function isPrimitive(value: unknown): boolean {
  if (!isObject(value)) return false;
  switch (value.kind) {
    case 'line':
    case 'irregular_line':
      return isLocation(value.start) && isLocation(value.end) && isOptionalLength(value.declaredLength);
    case 'curve':
      return isLocation(value.start) && isLocation(value.center) && isLocation(value.end)
        && isRotation(value.rotation) && isOptionalLength(value.radius) && isOptionalLength(value.declaredLength);
    case 'spiral':
    case 'unsupported_spiral':
      return isLocation(value.start) && isLocation(value.pi) && isLocation(value.end)
        && typeof value.spiType === 'string' && isRadius(value.radiusStart) && isRadius(value.radiusEnd)
        && (value.rotation === undefined || isRotation(value.rotation)) && isLength(value.declaredLength);
    default:
      return false;
  }
}

function isSegment(value: unknown): boolean {
  return isObject(value) && typeof value.sourceId === 'string' && isNumber(value.ordinal)
    && isPrimitive(value.primitive);
}

/**
 * Why this record is not a `LandXmlIfcAlignment`, or `null` when it is. The
 * reason names the first malformed segment, so a refusal says where to look.
 */
export function alignmentRecordProblem(value: unknown): string | null {
  if (!isObject(value)
    || typeof value.sourceId !== 'string'
    || typeof value.name !== 'string'
    || !(typeof value.staStart === 'number' && Number.isFinite(value.staStart))
    || !Array.isArray(value.segments)) {
    return 'it is not an alignment record (it needs a sourceId, a name, a numeric staStart and a segments list)';
  }
  const bad = value.segments.findIndex((segment) => !isSegment(segment));
  return bad === -1
    ? null
    : `its segment ${bad + 1} is not a line, curve or spiral record with plan locations for each of its points`;
}

/** Is this record shaped like a `LandXmlIfcAlignment`, down to every location? */
export function isAlignmentRecord(value: unknown): value is LandXmlIfcAlignment {
  return alignmentRecordProblem(value) === null;
}
