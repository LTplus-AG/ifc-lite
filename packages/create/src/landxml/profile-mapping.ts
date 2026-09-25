/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which LandXML profiles become an `IfcAlignmentVertical`, and which are
 * refused by name (mapping spec §12.2).
 *
 * Like `alignment-mapping.ts`, no STEP is written here, so the export dialog's
 * pre-flight and the export itself give the same answer. The geometry lives in
 * `profile-geometry.ts`; this module decides linkage and runs the mapping.
 */

import { ALIGNMENT_POSITION_TOLERANCE_M, isAlignmentRecord, type AlignmentMapping } from './alignment-mapping.js';
import {
  ProfileRefusal, assembleProfile, checkProfile, curveSegments, refuseProfile, type ProfileVertex, type VerticalSegment,
} from './profile-geometry.js';
import { profileRecordProblem, type LandXmlIfcProfile } from './profile-record.js';
import type { LandXmlIfcAlignment, LandXmlIfcUnits } from './source-types.js';
import { distancesForStation, type StationEquationMapping } from './station-equations.js';

/** A PVI's authored station → distance along, or a refusal (§12.2, §14.5). */
type DistanceOf = (station: number, label: string) => number;

/** A design profile mapped onto a written alignment. */
export interface MappedProfile {
  sourceId: string;
  name: string;
  alignmentSourceId: string;
  segments: VerticalSegment[];
}

export interface RefusedProfile {
  sourceId: string;
  name: string;
  reason: string;
}

export interface ProfileMapping {
  mapped: MappedProfile[];
  refused: RefusedProfile[];
}

function mapDesignProfile(
  profile: LandXmlIfcProfile, distanceOf: DistanceOf, horizontalLength: number, units: LandXmlIfcUnits,
): VerticalSegment[] {
  if (profile.pvis.length < 2) refuseProfile('it has fewer than two PVIs, so it has no grade');
  const vertices: ProfileVertex[] = profile.pvis.map((pvi, index) => {
    if (pvi.elevation === null || !Number.isFinite(pvi.elevation) || !Number.isFinite(pvi.station)) {
      refuseProfile(`its PVI ${index + 1} has no finite station and elevation`);
    }
    return {
      sourceId: pvi.sourceId,
      distAlong: distanceOf(pvi.station, `its PVI ${index + 1}`),
      height: pvi.elevation * units.elevationScaleToMeters,
    };
  });
  vertices.slice(1).forEach((vertex, index) => {
    if (vertex.distAlong <= vertices[index].distAlong) refuseProfile(`its PVI ${index + 2} does not advance in station`);
  });
  const start = vertices[0].distAlong;
  const end = vertices[vertices.length - 1].distAlong;
  if (start < -ALIGNMENT_POSITION_TOLERANCE_M || end > horizontalLength + ALIGNMENT_POSITION_TOLERANCE_M) {
    refuseProfile(
      `it runs from ${start.toFixed(3)} m to ${end.toFixed(3)} m along an alignment ${horizontalLength.toFixed(3)} m long`,
    );
  }

  const gradeOf = (a: ProfileVertex, b: ProfileVertex): number => (b.height - a.height) / (b.distAlong - a.distAlong);
  const curves: VerticalSegment[][] = vertices.map(() => []);
  const seen = new Set<number>();
  profile.verticalCurves.forEach((curve, curveIndex) => {
    const label = `vertical curve ${curveIndex + 1}`;
    // The parser records a curve's PVI in `pvis` with the same station and
    // elevation — the same pairing `rust/landxml`'s profile evaluator uses.
    const index = profile.pvis.findIndex((pvi) => pvi.station === curve.station && pvi.elevation === curve.elevation);
    if (index <= 0 || index >= vertices.length - 1) {
      refuseProfile(`${label} is not at an interior PVI, so it has no grade on both sides`);
    }
    if (seen.has(index)) refuseProfile(`PVI ${index + 1} carries more than one vertical curve`);
    seen.add(index);
    const before = vertices[index - 1];
    const pvi = vertices[index];
    const after = vertices[index + 1];
    curves[index] = curveSegments(curve, pvi, gradeOf(before, pvi), gradeOf(pvi, after), units, label);
  });

  const segments = assembleProfile(profile.sourceId, vertices, curves);
  checkProfile(segments, vertices, curves);
  return segments;
}

/**
 * Map every profile onto the alignments `alignmentMapping` writes, and refuse
 * the rest by name (§12.2). `alignments` is the source's raw list — a
 * profile's link is checked against it, not only against the written ones, so
 * a profile of a refused alignment says so rather than reading as unlinked.
 */
export function mapProfiles(
  profiles: readonly unknown[] | undefined, alignments: readonly unknown[] | undefined,
  alignmentMapping: AlignmentMapping, units: LandXmlIfcUnits | null,
  stationing: ReadonlyMap<string, StationEquationMapping> = new Map(),
): ProfileMapping {
  const result: ProfileMapping = { mapped: [], refused: [] };
  const records = (alignments ?? []).filter(isAlignmentRecord);
  const written = new Map(alignmentMapping.mapped.map((alignment) => [alignment.sourceId, alignment]));
  const designCount = new Map<string, number>();
  const valid: LandXmlIfcProfile[] = [];

  (profiles ?? []).forEach((candidate, index) => {
    const problem = profileRecordProblem(candidate);
    if (problem === null) {
      valid.push(candidate as LandXmlIfcProfile);
      return;
    }
    const header = candidate as { sourceId?: unknown; name?: unknown } | null;
    const named = typeof header?.sourceId === 'string' && typeof header.name === 'string';
    result.refused.push({
      sourceId: named ? header.sourceId as string : `profile[${index}]`,
      name: named ? (header.name as string) || (header.sourceId as string) : `profile ${index + 1}`,
      reason: problem,
    });
  });

  // A profile is linked when its alignment exists and, if that alignment
  // lists its profiles, lists this one. Only LINKED design profiles compete
  // for the alignment's one vertical layout: an unlinked sibling is refused
  // on its own and must not make the linked one look ambiguous (#5930 review).
  const alignmentOf = (profile: LandXmlIfcProfile) => records.find((record) => record.sourceId === profile.parentAlignmentSourceId);
  const isLinked = (profile: LandXmlIfcProfile): boolean => {
    const alignment = alignmentOf(profile);
    const listed = alignment?.profileSourceIds ?? [];
    return alignment !== undefined && (listed.length === 0 || listed.includes(profile.sourceId));
  };
  for (const profile of valid) {
    if (profile.kind === 'design' && isLinked(profile)) {
      designCount.set(profile.parentAlignmentSourceId, (designCount.get(profile.parentAlignmentSourceId) ?? 0) + 1);
    }
  }

  for (const profile of valid) {
    const refuse = (reason: string): void => {
      result.refused.push({ sourceId: profile.sourceId, name: profile.name || profile.sourceId, reason });
    };
    const alignment = alignmentOf(profile);
    // An empty `profileSourceIds` declares nothing; a non-empty one must agree.
    if (!alignment || !isLinked(profile)) {
      refuse('it is not linked to any alignment in the file');
      continue;
    }
    const alignmentName = alignment.name || alignment.sourceId;
    const mapped = written.get(alignment.sourceId);
    if (!mapped || units === null) {
      refuse(`its alignment '${alignmentName}' is not written, so there is no horizontal to measure it along`);
      continue;
    }
    if (profile.kind === 'sampled') {
      refuse('it is a sampled ground profile (ProfSurf), not a design vertical layout');
      continue;
    }
    const designs = designCount.get(alignment.sourceId) ?? 0;
    if (designs > 1) {
      refuse(`its alignment '${alignmentName}' has ${designs} design profiles, and IFC nests one vertical layout under an alignment; choosing one would be a guess`);
      continue;
    }
    const horizontalLength = mapped.segments.reduce((total, segment) => total + segment.length, 0);
    const distanceOf = profileDistances(alignment, mapped.startStation, horizontalLength, units, stationing);
    if (typeof distanceOf === 'string') {
      refuse(distanceOf);
      continue;
    }
    try {
      result.mapped.push({
        sourceId: profile.sourceId,
        name: profile.name,
        alignmentSourceId: alignment.sourceId,
        segments: mapDesignProfile(profile, distanceOf, horizontalLength, units),
      });
    } catch (error) {
      if (!(error instanceof ProfileRefusal)) throw error;
      refuse(error.message);
    }
  }
  return result;
}

/**
 * How a profile's stations become distances along its alignment (§14.5).
 *
 * Without station equations, linearly from the start station. With written
 * ones, through the displayed stationing they define: a PVI station must occur
 * at exactly one place along the alignment, and one in a forward jump's gap or
 * displayed twice after a backward jump is refused by name, never guessed. When
 * the alignment's equations were themselves refused (§14.2) there is no
 * stationing to read the profile against, so it is refused as a whole.
 */
function profileDistances(
  alignment: LandXmlIfcAlignment, startStation: number, length: number, units: LandXmlIfcUnits,
  stationing: ReadonlyMap<string, StationEquationMapping>,
): DistanceOf | string {
  const scale = units.linearScaleToMeters;
  if ((alignment.stationEquations?.length ?? 0) === 0) {
    return (station) => station * scale - startStation;
  }
  const alignmentName = alignment.name || alignment.sourceId;
  const mapping = stationing.get(alignment.sourceId);
  if (!mapping || mapping.refusal !== null) {
    return `its alignment '${alignmentName}' has station equations that are not written, so its stations cannot be placed along it`;
  }
  return (station, label) => {
    const places = distancesForStation(station * scale, startStation, mapping.equations, length);
    if (places.length === 0) {
      refuseProfile(`${label} is at station ${station}, which falls in a station-equation gap of '${alignmentName}'`);
    }
    if (places.length > 1) {
      refuseProfile(
        `${label} is at station ${station}, which '${alignmentName}' displays at ${places.length} places `
        + `(${places.map((place) => `${place.toFixed(3)} m`).join(', ')}); choosing one would be a guess`,
      );
    }
    return places[0];
  };
}
