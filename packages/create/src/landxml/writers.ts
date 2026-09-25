/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The per-record writers `landXmlToIfc` composes: TIN surfaces, survey points
 * and alignments. Split out of `landxml-to-ifc.ts` so the orchestrator reads
 * as the sequence it is — refuse, warn, write, record provenance — and each
 * record family's conversion can be read on its own.
 *
 * `toIfcVertex` is the one place a surface or survey point's axes are
 * reordered (alignments do theirs in `alignment-mapping.ts`'s `planPoint`).
 */

import type { TerrainWriter } from '../ifc-creator-terrain.js';
import { isMappableSurface } from './refusals.js';
import type { MappedAlignment } from './alignment-mapping.js';
import type { MappedProfile } from './profile-mapping.js';
import type { StationEquationMapping } from './station-equations.js';
import type { LandXmlIfcCgPoint, LandXmlIfcSurface, LandXmlIfcUnits } from './source-types.js';

/** Deterministic GlobalId from a LandXML source id, passed in to avoid an import cycle. */
export type GlobalIdOf = (sourceId: string) => string;

/**
 * LandXML's authored `(northing, easting, elevation)` → IFC's
 * `(X, Y, Z) = (easting, northing, elevation)`, in metres.
 *
 * The one place the axes are reordered. `swap` is the operator's confirmed
 * override for a producer that wrote its point text easting-first; it reverses
 * this function's own swap, so a swapped source and an unswapped one produce
 * the same IFC.
 */
function toIfcVertex(
  northing: number, easting: number, elevation: number, units: LandXmlIfcUnits, swap: boolean,
): [number, number, number] {
  const plan = units.linearScaleToMeters;
  const [x, y] = swap ? [northing, easting] : [easting, northing];
  return [x * plan, y * plan, elevation * units.elevationScaleToMeters];
}

function surfaceVertices(
  surface: LandXmlIfcSurface, units: LandXmlIfcUnits, swap: boolean,
): { coordinates: Array<[number, number, number]>; indexById: Map<string, number> } {
  const coordinates: Array<[number, number, number]> = [];
  const indexById = new Map<string, number>();
  for (const point of surface.points) {
    // `CoordIndex` is 1-based, so the index recorded here is `length` *after*
    // the push — not before.
    coordinates.push(toIfcVertex(point.northing, point.easting, point.elevation, units, swap));
    // First writer wins on a duplicate `<P id>`: a later duplicate would
    // silently repoint every face authored against the earlier one.
    if (!indexById.has(point.id)) indexById.set(point.id, coordinates.length);
  }
  return { coordinates, indexById };
}

function surfaceTriangles(
  surface: LandXmlIfcSurface, indexById: ReadonlyMap<string, number>,
): Array<[number, number, number]> {
  const visibility = surface.faceVisibility;
  const triangles: Array<[number, number, number]> = [];
  surface.faces.forEach((face, ordinal) => {
    // An authored `<F i="true">` is a hidden face: it is part of the source
    // record but draws nothing, and writing it would add a triangle the source
    // says is not there.
    if (visibility && visibility[ordinal] === false) return;
    const resolved = face.map((pointId) => indexById.get(pointId));
    if (resolved.some((index) => index === undefined)) {
      throw new Error(
        `landXmlToIfc: surface '${surface.name}' face ${ordinal} references point id `
        + `'${face.find((id) => !indexById.has(id))}', which the surface does not define`,
      );
    }
    triangles.push(resolved as [number, number, number]);
  });
  return triangles;
}

/** Non-empty text properties of one CgPoint, in a stable order. */
function surveyProperties(point: LandXmlIfcCgPoint, location: readonly [number, number, number]): Array<{ Name: string; Value: string }> {
  const entries: Array<{ Name: string; Value: string }> = [
    { Name: 'SourceId', Value: point.sourceId },
  ];
  if (point.name) entries.push({ Name: 'Name', Value: point.name });
  if (point.code) entries.push({ Name: 'Code', Value: point.code });
  if (point.description) entries.push({ Name: 'Description', Value: point.description });
  entries.push(
    { Name: 'Easting', Value: String(location[0]) },
    { Name: 'Northing', Value: String(location[1]) },
  );
  // A 2D CgPoint is placed at Z = 0 because a placement needs a number, but
  // the property set must not claim an elevation the source never authored.
  if (point.point?.elevation !== null && point.point?.elevation !== undefined) {
    entries.push({ Name: 'Elevation', Value: String(location[2]) });
  }
  return entries;
}

export function writeSurfaces(
  terrain: TerrainWriter, surfaces: readonly LandXmlIfcSurface[], units: LandXmlIfcUnits, swap: boolean,
  landXmlGlobalId: GlobalIdOf,
): { surfaces: number; vertices: number; triangles: number; samples: Array<[number, number]> } {
  let written = 0;
  let vertices = 0;
  let triangles = 0;
  const samples: Array<[number, number]> = [];
  for (const surface of surfaces) {
    if (!isMappableSurface(surface)) continue;
    const { coordinates, indexById } = surfaceVertices(surface, units, swap);
    const faces = surfaceTriangles(surface, indexById);
    // Unreachable for an all-hidden surface — `isMappableSurface` refuses it by
    // name first. Kept as a guard because CoordIndex is LIST [1:?].
    if (faces.length === 0) continue;
    terrain.addSurface({
      Name: surface.name,
      GlobalId: landXmlGlobalId(surface.sourceId),
      Coordinates: coordinates,
      Triangles: faces,
    });
    written += 1;
    vertices += coordinates.length;
    triangles += faces.length;
    for (const [x, y] of coordinates) samples.push([x, y]);
  }
  return { surfaces: written, vertices, triangles, samples };
}

export function writeSurveyPoints(
  terrain: TerrainWriter, points: readonly LandXmlIfcCgPoint[], units: LandXmlIfcUnits, swap: boolean,
  landXmlGlobalId: GlobalIdOf,
): { count: number; samples: Array<[number, number]> } {
  let count = 0;
  const samples: Array<[number, number]> = [];
  for (const point of points) {
    // A CgPoint may carry only a `pntRef`, with no coordinates of its own.
    // `collectRefusals` names those as `unlocated-cgpoints`.
    if (!point.point) continue;
    const location = toIfcVertex(
      point.point.northing, point.point.easting, point.point.elevation ?? 0, units, swap,
    );
    const annotationId = terrain.addSurveyPoint({
      Name: point.name,
      Description: point.description,
      GlobalId: landXmlGlobalId(point.sourceId),
      Location: location,
    });
    terrain.addPropertySet(annotationId, {
      Name: 'LandXML_CgPoint',
      GlobalId: landXmlGlobalId(`${point.sourceId}:pset`),
      Properties: surveyProperties(point, location),
    });
    count += 1;
    samples.push([location[0], location[1]]);
  }
  return { count, samples };
}

/**
 * Write each mapped alignment (§11). GlobalIds derive from the alignment's
 * source id and the role of each owned entity, so a re-export of an unchanged
 * alignment is byte-identical (§4.3).
 */
export function writeAlignments(
  terrain: TerrainWriter, alignments: readonly MappedAlignment[], landXmlGlobalId: GlobalIdOf,
  profiles: readonly MappedProfile[] = [],
  stationing: ReadonlyMap<string, StationEquationMapping> = new Map(),
): Array<[number, number]> {
  const samples: Array<[number, number]> = [];
  for (const alignment of alignments) {
    // At most one: `mapProfiles` refuses every design profile of an alignment
    // that has more than one (§12.2).
    const profile = profiles.find((candidate) => candidate.alignmentSourceId === alignment.sourceId);
    terrain.addAlignment({
      ...(profile ? {
        Vertical: { Name: profile.name, GlobalId: landXmlGlobalId(profile.sourceId), Segments: profile.segments },
      } : {}),
      Name: alignment.name,
      GlobalId: landXmlGlobalId(alignment.sourceId),
      StartStation: alignment.startStation,
      Segments: alignment.segments,
      // §14: each written equation is an IfcReferent whose GlobalId derives
      // from the equation's own source id.
      StationEquations: (stationing.get(alignment.sourceId)?.equations ?? []).map((equation) => ({
        DistanceAlong: equation.distanceAlong,
        Station: equation.station,
        IncomingStation: equation.incomingStation,
        HasIncreasingStation: equation.increasing,
        Role: equation.sourceId.startsWith(`${alignment.sourceId}:`)
          ? equation.sourceId.slice(alignment.sourceId.length + 1)
          : equation.sourceId,
      })),
      guidFor: (role) => landXmlGlobalId(`${alignment.sourceId}:${role}`),
    });
    for (const segment of alignment.segments) samples.push([segment.start[0], segment.start[1]]);
  }
  return samples;
}

