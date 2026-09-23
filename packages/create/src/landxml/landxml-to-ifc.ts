/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * LandXML → IFC4X3, v1.
 *
 * Implements `docs/architecture/landxml-to-ifc-mapping.md` v1.0. That document
 * is the contract; anything not written there is not in v1, and a change to the
 * mapping is a change to that document first.
 *
 * Three properties this file exists to guarantee, each of which fails silently
 * if it is got wrong:
 *
 * 1. **Axis order.** LandXML authors `<P>` text as *northing easting
 *    elevation*. IFC `CoordList` entries are `(X, Y, Z)` = *easting northing
 *    elevation*. The swap happens here, once, at {@link toIfcVertex}.
 * 2. **Units.** Output is always metres, with `linearScaleToMeters` applied to
 *    the plan axes and `elevationScaleToMeters` to the elevation — LandXML may
 *    declare a different unit for each, and applying one scale to all three is
 *    a mistake that looks fine on the common metric file.
 * 3. **Nothing is dropped in silence.** Every out-of-scope record family is
 *    counted and named, and a source with no mappable record refuses outright
 *    rather than producing a valid, empty, useless IFC.
 */

import { uuidFromSeed, uuidToIfcGuid } from '@ifc-lite/encoding';
import { IfcCreator } from '../ifc-creator.js';
import type { TerrainWriter } from '../ifc-creator-terrain.js';
import { checkCoordinateOrder, type CrsPlausibilityBounds } from './coordinate-plausibility.js';
import { collectRefusals, isMappableSurface, refusalReason } from './refusals.js';
import type {
  LandXmlIfcCgPoint, LandXmlIfcSource, LandXmlIfcSurface, LandXmlIfcUnits,
} from './source-types.js';
import type {
  LandXmlIfcCoverage, LandXmlIfcProvenance, LandXmlIfcResult, LandXmlIfcWarning,
} from './result-types.js';

/** The mapping-document version this converter implements. */
export const LANDXML_IFC_MAPPING_VERSION = '1.0';

export interface LandXmlIfcOptions {
  /** Recorded as provenance (§7); never used to decide anything. */
  sourceFileName?: string;
  sourceHash?: string;
  /**
   * Written as `IfcProjectedCRS` + `IfcMapConversion` (§4.2). Omit where the
   * source declares no CRS: §4.2 forbids a placeholder, because a wrong CRS is
   * worse than none.
   */
  crs?: {
    Name: string;
    Description?: string;
    GeodeticDatum?: string;
    VerticalDatum?: string;
    MapProjection?: string;
    MapZone?: string;
    /** Enables the transposition check (§9.1). Without it there is no test. */
    Bounds?: CrsPlausibilityBounds;
  };
  /**
   * Operator-confirmed northing/easting swap for a known-faulty producer
   * (§2.2 item 2). Recorded as provenance, exactly like the units override.
   */
  swapNorthingEasting?: boolean;
  /** Fixed epoch-ms, for byte-deterministic output. */
  timestampMs?: number;
  Author?: string;
  Organization?: string;
}

/** Deterministic GlobalId from a LandXML source id (§4.3, §10). */
export function landXmlGlobalId(sourceId: string): string {
  return uuidToIfcGuid(uuidFromSeed(sourceId));
}

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

function writeSurfaces(
  terrain: TerrainWriter, surfaces: readonly LandXmlIfcSurface[], units: LandXmlIfcUnits, swap: boolean,
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

function writeSurveyPoints(
  terrain: TerrainWriter, points: readonly LandXmlIfcCgPoint[], units: LandXmlIfcUnits, swap: boolean,
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
 * Convert a parsed LandXML document to an IFC4X3 STEP file.
 *
 * Returns `{ status: 'refused' }` — with the refusal list intact — when the
 * source carries nothing the mapping covers. That is not an error case to be
 * caught; it is the honest answer for the alignment-only files §9.4 discusses.
 */
export function landXmlToIfc(source: LandXmlIfcSource, options: LandXmlIfcOptions = {}): LandXmlIfcResult {
  const refusals = collectRefusals(source);
  const warnings: LandXmlIfcWarning[] = [];

  const mappableSurfaces = source.surfaces.filter(isMappableSurface);
  const cogoPoints = (source.plan?.cogoPoints ?? []).filter((point) => point.point !== null);
  const units = source.units;

  if (units === null) {
    // Distinct from an empty source: the file may hold a perfectly good TIN, and
    // the operator needs to know the fix is units, not content.
    return {
      status: 'refused',
      reason: 'This LandXML file declares no LandXML/Units element, so no coordinate can be scaled to '
        + 'metres. Load it with an explicit assumed linear unit, or export the original LandXML file instead.',
      refusals,
      warnings,
    };
  }
  if (mappableSurfaces.length === 0 && cogoPoints.length === 0) {
    return { status: 'refused', reason: refusalReason(refusals), refusals, warnings };
  }

  if (units.assumed) {
    warnings.push({
      code: 'LXIFC-ASSUMED-UNIT',
      message:
        `Every coordinate in this export is scaled by an ASSUMED linear unit ('${units.linearUnit}'). `
        + 'The source declares no LandXML/Units element, so the scale was chosen by an operator, not read '
        + 'from the file. The geometry is at that operator-chosen scale and nothing in the IFC records '
        + 'otherwise except this file\'s provenance property set.',
    });
  }
  if (!options.crs) {
    warnings.push({
      code: 'LXIFC-NO-CRS',
      message:
        'No coordinate reference system is declared, so no IfcProjectedCRS or IfcMapConversion is written '
        + 'and the coordinate-order plausibility check cannot run. The coordinates are written as authored.',
    });
  }
  if (options.swapNorthingEasting) {
    warnings.push({
      code: 'LXIFC-COORD-SWAPPED',
      message:
        'A coordinate-order override is in force: the source\'s point text is being read as '
        + 'easting-first rather than LandXML\'s northing-first order. This is an operator assertion about '
        + 'the producer, not something read from the file.',
    });
  }

  const creator = new IfcCreator({
    Schema: 'IFC4X3',
    Name: options.sourceFileName ?? 'LandXML conversion',
    Description: `Derived from LandXML ${source.schema} by the ifc-lite LandXML→IFC mapping v${LANDXML_IFC_MAPPING_VERSION}`,
    LengthUnit: 'METRE',
    ...(options.timestampMs === undefined ? {} : { Timestamp: options.timestampMs }),
    ...(options.Author === undefined ? {} : { Author: options.Author }),
    ...(options.Organization === undefined ? {} : { Organization: options.Organization }),
    // Content hash first: two different files exported without a name must not
    // share project/site/relationship GlobalIds, or federating them collides.
    GuidSource: deterministicGuidSource(options.sourceHash ?? options.sourceFileName ?? source.schema),
  });
  const terrain = creator.terrain();

  if (options.crs) {
    terrain.setGeoreferencing({
      Name: options.crs.Name,
      Description: options.crs.Description,
      GeodeticDatum: options.crs.GeodeticDatum ?? source.coordinateSystem?.horizontalDatum,
      VerticalDatum: options.crs.VerticalDatum ?? source.coordinateSystem?.verticalDatum,
      MapProjection: options.crs.MapProjection,
      MapZone: options.crs.MapZone,
    });
  }

  const swap = options.swapNorthingEasting === true;
  const surfaceResult = writeSurfaces(terrain, source.surfaces, units, swap);
  const pointResult = writeSurveyPoints(terrain, cogoPoints, units, swap);

  if (options.crs?.Bounds) {
    const warning = checkCoordinateOrder(
      [...surfaceResult.samples, ...pointResult.samples], options.crs.Bounds, options.crs.Name,
    );
    if (warning) warnings.push(warning);
  }

  const coverage: LandXmlIfcCoverage = {
    surfaces: surfaceResult.surfaces,
    surveyPoints: pointResult.count,
    vertices: surfaceResult.vertices,
    triangles: surfaceResult.triangles,
  };

  if (coverage.surfaces === 0 && coverage.surveyPoints === 0) {
    return { status: 'refused', reason: refusalReason(refusals), refusals, warnings };
  }

  const provenance: LandXmlIfcProvenance = {
    sourceFileName: options.sourceFileName ?? null,
    sourceHash: options.sourceHash ?? null,
    mappingVersion: LANDXML_IFC_MAPPING_VERSION,
    landXmlSchema: source.schema,
    units,
    assumedLinearUnit: units.assumed ? units.linearUnit : null,
    coordinateOrderSwapped: swap,
    refusedFamilies: refusals.map((refusal) => refusal.family),
  };
  writeProvenance(terrain, provenance, coverage);

  return {
    status: 'exported',
    content: creator.toIfc().content,
    coverage,
    provenance,
    refusals,
    warnings,
  };
}

/**
 * GlobalIds for the entities that have no LandXML source id of their own — the
 * project, site, building, contexts and every relationship row.
 *
 * Seeded from the source name and a counter so two exports of one source are
 * byte-identical (§8.4). A random source would make every export differ, which
 * would make `ifc-lite diff` between two conversions meaningless.
 */
function deterministicGuidSource(seed: string): () => string {
  let ordinal = 0;
  return () => {
    ordinal += 1;
    return landXmlGlobalId(`landxml-ifc:${seed}:${ordinal}`);
  };
}

/**
 * §7 — what the file says about where it came from, as a property set on the
 * site. It records the assumption, not just the result: an export made under an
 * assumed unit or a coordinate-order override is indistinguishable from a
 * declared one by its geometry alone.
 */
function writeProvenance(
  terrain: TerrainWriter, provenance: LandXmlIfcProvenance, coverage: LandXmlIfcCoverage,
): void {
  const properties: Array<{ Name: string; Value: string }> = [
    { Name: 'DerivedConversion', Value: 'true' },
    { Name: 'MappingVersion', Value: provenance.mappingVersion },
    { Name: 'LandXmlSchema', Value: provenance.landXmlSchema },
    { Name: 'SourceFileName', Value: provenance.sourceFileName ?? '' },
    { Name: 'SourceHash', Value: provenance.sourceHash ?? '' },
    { Name: 'LinearUnit', Value: provenance.units?.linearUnit ?? '' },
    { Name: 'ElevationUnit', Value: provenance.units?.elevationUnit ?? '' },
    { Name: 'AssumedLinearUnit', Value: provenance.assumedLinearUnit ?? '' },
    { Name: 'CoordinateOrderSwapped', Value: String(provenance.coordinateOrderSwapped) },
    { Name: 'RefusedRecordFamilies', Value: provenance.refusedFamilies.join(', ') },
    { Name: 'ExportedSurfaces', Value: String(coverage.surfaces) },
    { Name: 'ExportedSurveyPoints', Value: String(coverage.surveyPoints) },
  ];
  terrain.addPropertySet(terrain.siteId, {
    Name: 'LandXML_Conversion',
    Properties: properties,
  });
}
