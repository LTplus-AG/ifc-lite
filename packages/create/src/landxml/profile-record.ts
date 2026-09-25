/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shape of one `LandXmlIfcSource.profiles` record, and its run-time check
 * (mapping spec §12).
 *
 * `profiles` stays `unknown[]` on the source (narrowing a published input type
 * is a breaking change, #5370 review), so every record is checked here before
 * the mapper reads it — exactly as `alignment-record.ts` does for alignments.
 * A record that fails is refused by name, never read into.
 *
 * The shapes mirror the viewer's `LandXmlProfile` field for field, so the
 * viewer's parsed document satisfies them without a translation layer.
 */

/** One `PVI` (or sampled station/elevation pair), in the file's declared units. */
export interface LandXmlIfcProfilePoint {
  sourceId: string;
  /** A STATION, not a distance along: `staStart` has not been subtracted. */
  station: number;
  elevation: number | null;
}

/**
 * A `ParaCurve`, `UnsymParaCurve` or `CircCurve`, anchored at its PVI. The
 * parser also records that PVI in `pvis`, with the same station and elevation.
 */
export interface LandXmlIfcVerticalCurve {
  sourceId: string;
  kind: 'parabolic' | 'unsymmetrical_parabolic' | 'circular';
  station: number;
  elevation: number | null;
  length: number | null;
  lengthIn: number | null;
  lengthOut: number | null;
  radius: number | null;
}

/** A `ProfAlign` (`kind: 'design'`) or `ProfSurf` (`kind: 'sampled'`) under an alignment. */
export interface LandXmlIfcProfile {
  sourceId: string;
  parentAlignmentSourceId: string;
  name: string;
  kind: 'design' | 'sampled';
  /** Authored order. */
  pvis: readonly LandXmlIfcProfilePoint[];
  verticalCurves: readonly LandXmlIfcVerticalCurve[];
}

type Fields = Record<string, unknown>;

const isObject = (value: unknown): value is Fields => typeof value === 'object' && value !== null;
const isNumber = (value: unknown): boolean => typeof value === 'number';
const isOptionalNumber = (value: unknown): boolean => value === null || isNumber(value);

function isPoint(value: unknown): boolean {
  return isObject(value) && typeof value.sourceId === 'string' && isNumber(value.station)
    && isOptionalNumber(value.elevation);
}

function isCurve(value: unknown): boolean {
  return isObject(value) && typeof value.sourceId === 'string'
    && (value.kind === 'parabolic' || value.kind === 'unsymmetrical_parabolic' || value.kind === 'circular')
    && isNumber(value.station) && isOptionalNumber(value.elevation)
    && isOptionalNumber(value.length) && isOptionalNumber(value.lengthIn)
    && isOptionalNumber(value.lengthOut) && isOptionalNumber(value.radius);
}

/** Why this record is not a `LandXmlIfcProfile`, or `null` when it is. */
export function profileRecordProblem(value: unknown): string | null {
  if (!isObject(value)
    || typeof value.sourceId !== 'string'
    || typeof value.parentAlignmentSourceId !== 'string'
    || typeof value.name !== 'string'
    || (value.kind !== 'design' && value.kind !== 'sampled')
    || !Array.isArray(value.pvis)
    || !Array.isArray(value.verticalCurves)) {
    return 'it is not a profile record (it needs a sourceId, a parentAlignmentSourceId, a name, a design or '
      + 'sampled kind, and PVI and vertical-curve lists)';
  }
  const badPoint = value.pvis.findIndex((point) => !isPoint(point));
  if (badPoint !== -1) return `its PVI ${badPoint + 1} is not a station/elevation record`;
  const badCurve = value.verticalCurves.findIndex((curve) => !isCurve(curve));
  if (badCurve !== -1) return `its vertical curve ${badCurve + 1} is not a ParaCurve, UnsymParaCurve or CircCurve record`;
  return null;
}
