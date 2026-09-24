/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * LandXML `StaEquation` → `IfcReferent` / `Pset_Stationing` parameters
 * (mapping spec §14).
 *
 * Pure numbers, like `alignment-mapping.ts`: the export dialog's pre-flight
 * and the export itself run this same function, so the refusal the dialog
 * shows is the refusal the export gives.
 *
 * An alignment's equations are mapped ALL OR NONE (§14.2). Stationing is
 * cumulative, so writing some and dropping one would make every station after
 * the dropped one wrong in a file that looks complete.
 */

import {
  ALIGNMENT_POSITION_TOLERANCE_M, isAlignmentRecord, type AlignmentMapping, type MappedAlignment,
} from './alignment-mapping.js';
import type { LandXmlIfcAlignment, LandXmlIfcSource, LandXmlIfcUnits } from './source-types.js';

/**
 * A `StaEquation` as the parser delivers it. `LandXmlIfcAlignment.stationEquations`
 * stays `unknown[]` (narrowing a published input type is a breaking change), so
 * each record is checked against this shape at run time instead.
 */
export interface LandXmlIfcStationEquation {
  sourceId: string;
  /** Where, in the alignment's continuous stationing (`staStart` + distance along). */
  staInternal: number;
  /** The station from here on. */
  staAhead: number;
  /** The station arriving here, when authored. */
  staBack: number | null;
  /** `'increasing'` / `'decreasing'` — the direction of stationing after this point. */
  staIncrement: string | null;
}

/** One station equation, in metres, ready for `Pset_Stationing`. */
export interface MappedStationEquation {
  sourceId: string;
  /** Distance along the alignment's basis curve from its start. */
  distanceAlong: number;
  /** `Pset_Stationing.Station` — the ahead station. */
  station: number;
  /** `Pset_Stationing.IncomingStation` — authored `staBack`, or derived (§14.1). */
  incomingStation: number;
  /** `Pset_Stationing.HasIncreasingStation`; `null` when `staIncrement` was not authored. */
  increasing: boolean | null;
}

export interface StationEquationMapping {
  /** Written equations, in order along the alignment. Empty when refused. */
  equations: MappedStationEquation[];
  /** How many equations the source carries on this alignment. */
  count: number;
  /** Why they were all refused, or `null` when they are written. */
  refusal: string | null;
}

class Refusal extends Error {}

function refuse(message: string): never {
  throw new Refusal(message);
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function checkRecord(value: unknown, label: string): LandXmlIfcStationEquation {
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const increment = record.staIncrement;
  if (typeof record.sourceId !== 'string' || !finite(record.staInternal) || !finite(record.staAhead)
    || !(record.staBack === null || record.staBack === undefined || finite(record.staBack))
    || !(increment === null || increment === undefined || increment === 'increasing' || increment === 'decreasing')) {
    refuse(`${label} is not a station-equation record (it needs a finite staInternal and staAhead, `
      + 'and a finite staBack and an increasing/decreasing staIncrement where given)');
  }
  return {
    sourceId: record.sourceId,
    staInternal: record.staInternal,
    staAhead: record.staAhead,
    staBack: finite(record.staBack) ? record.staBack : null,
    staIncrement: typeof increment === 'string' ? increment : null,
  };
}

function mapAll(
  records: readonly unknown[], alignment: MappedAlignment, units: LandXmlIfcUnits,
): MappedStationEquation[] {
  const scale = units.linearScaleToMeters;
  const length = alignment.segments.reduce((total, segment) => total + segment.length, 0);
  const out: MappedStationEquation[] = [];
  // The running stationing, exactly as `rust/landxml`'s `station_mapping`
  // walks it: the display value and direction in force since the last equation.
  let previousDistance = 0;
  let displayed = alignment.startStation;
  let direction = 1;
  records.forEach((value, index) => {
    const label = `station equation ${index + 1}`;
    const equation = checkRecord(value, label);
    const distanceAlong = equation.staInternal * scale - alignment.startStation;
    if (distanceAlong <= ALIGNMENT_POSITION_TOLERANCE_M) {
      refuse(`${label} is at internal station ${equation.staInternal}, at or before the alignment's start`);
    }
    if (distanceAlong > length + ALIGNMENT_POSITION_TOLERANCE_M) {
      refuse(`${label} is ${(distanceAlong - length).toFixed(3)} m beyond the alignment's end`);
    }
    if (index > 0 && distanceAlong <= previousDistance) {
      refuse(`${label} is not after station equation ${index} along the alignment`);
    }
    const along = Math.min(distanceAlong, length);
    const incomingStation = equation.staBack !== null
      ? equation.staBack * scale
      : displayed + direction * (along - previousDistance);
    out.push({
      sourceId: equation.sourceId,
      distanceAlong: along,
      station: equation.staAhead * scale,
      incomingStation,
      increasing: equation.staIncrement === null ? null : equation.staIncrement === 'increasing',
    });
    previousDistance = along;
    displayed = equation.staAhead * scale;
    direction = equation.staIncrement === 'decreasing' ? -1 : 1;
  });
  return out;
}

/** Map one WRITTEN alignment's station equations, all or none (§14.2). */
export function mapStationEquations(
  record: LandXmlIfcAlignment, alignment: MappedAlignment, units: LandXmlIfcUnits,
): StationEquationMapping {
  const records = record.stationEquations ?? [];
  if (records.length === 0) return { equations: [], count: 0, refusal: null };
  try {
    return { equations: mapAll(records, alignment, units), count: records.length, refusal: null };
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return { equations: [], count: records.length, refusal: error.message };
  }
}

/**
 * The station-equation mapping of every WRITTEN alignment, by source id. A
 * refused alignment takes its equations with it and is absent here: counting
 * them again would misstate what is missing.
 */
export function stationEquationsOf(
  source: LandXmlIfcSource, alignmentMapping: AlignmentMapping,
): Map<string, StationEquationMapping> {
  const out = new Map<string, StationEquationMapping>();
  if (source.units === null) return out;
  const records = new Map<string, LandXmlIfcAlignment>();
  for (const candidate of source.alignments ?? []) {
    if (isAlignmentRecord(candidate) && !records.has(candidate.sourceId)) records.set(candidate.sourceId, candidate);
  }
  for (const alignment of alignmentMapping.mapped) {
    const record = records.get(alignment.sourceId);
    if (record) out.set(alignment.sourceId, mapStationEquations(record, alignment, source.units));
  }
  return out;
}

/**
 * Every distance along the alignment at which the DISPLAYED `station` (metres)
 * occurs, given its written station equations — `rust/landxml`'s
 * `distances_for_station`, over the mapped (metre) values.
 *
 * Empty: the station falls in a forward jump's gap. More than one: a backward
 * jump (or a change of direction) displays it twice. Only exactly one is a
 * place (§12.2, §14.5).
 */
export function distancesForStation(
  station: number, startStation: number, equations: readonly MappedStationEquation[], length: number,
): number[] {
  const tolerance = ALIGNMENT_POSITION_TOLERANCE_M;
  const boundaries = [0, ...equations.map((equation) => equation.distanceAlong), length];
  const out: number[] = [];
  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const previous = index === 0 ? null : equations[index - 1];
    const displayStart = previous ? previous.station : startStation;
    const direction = previous?.increasing === false ? -1 : 1;
    const candidate = boundaries[index] + (station - displayStart) / direction;
    if (candidate < boundaries[index] - tolerance || candidate > boundaries[index + 1] + tolerance) continue;
    const distance = Math.min(Math.max(candidate, 0), length);
    if (out.length === 0 || Math.abs(distance - out[out.length - 1]) > tolerance) out.push(distance);
  }
  return out;
}
