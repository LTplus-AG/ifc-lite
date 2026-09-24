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
import { cogoPointResolver, mapAlignments } from './alignment-mapping.js';
import { mapProfiles } from './profile-mapping.js';
import { stationEquationsOf } from './station-equations.js';
import { writeAlignments, writeSurfaces, writeSurveyPoints } from './writers.js';
import type { LandXmlIfcSource } from './source-types.js';
import type {
  LandXmlIfcCoverage, LandXmlIfcProvenance, LandXmlIfcResult, LandXmlIfcWarning,
} from './result-types.js';

/** The mapping-document version this converter implements. */
export const LANDXML_IFC_MAPPING_VERSION = '1.3';

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
 * Convert a parsed LandXML document to an IFC4X3 STEP file.
 *
 * Returns `{ status: 'refused' }` — with the refusal list intact — when the
 * source carries nothing the mapping covers. That is not an error case to be
 * caught; it is the honest answer for the alignment-only files §9.4 discusses.
 */
export function landXmlToIfc(source: LandXmlIfcSource, options: LandXmlIfcOptions = {}): LandXmlIfcResult {
  const swap = options.swapNorthingEasting === true;
  // Mapped once, and the same mapping decides both what is written and what
  // the refusal list says was not — two passes could disagree.
  const alignmentMapping = mapAlignments(
    source.alignments, source.units, swap, cogoPointResolver(source.plan?.cogoPoints),
  );
  const stationing = stationEquationsOf(source, alignmentMapping);
  const profileMapping = mapProfiles(source.profiles, source.alignments, alignmentMapping, source.units, stationing);
  const refusals = collectRefusals(source, alignmentMapping, profileMapping, stationing);
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
  if (mappableSurfaces.length === 0 && cogoPoints.length === 0 && alignmentMapping.mapped.length === 0) {
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
    // Declared as `IFC4X3_ADD2` by `IfcCreator` itself, like all IFC4X3
    // output (`fileSchemaIdentifier`, #5351).
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

  const surfaceResult = writeSurfaces(terrain, source.surfaces, units, swap, landXmlGlobalId);
  const pointResult = writeSurveyPoints(terrain, cogoPoints, units, swap, landXmlGlobalId);
  const alignmentSamples = writeAlignments(
    terrain, alignmentMapping.mapped, landXmlGlobalId, profileMapping.mapped, stationing,
  );

  if (options.crs?.Bounds) {
    const warning = checkCoordinateOrder(
      [...surfaceResult.samples, ...pointResult.samples, ...alignmentSamples], options.crs.Bounds, options.crs.Name,
    );
    if (warning) warnings.push(warning);
  }

  const coverage: LandXmlIfcCoverage = {
    surfaces: surfaceResult.surfaces,
    surveyPoints: pointResult.count,
    vertices: surfaceResult.vertices,
    triangles: surfaceResult.triangles,
    alignments: alignmentMapping.mapped.length,
    profiles: profileMapping.mapped.length,
  };

  if (coverage.surfaces === 0 && coverage.surveyPoints === 0 && (coverage.alignments ?? 0) === 0) {
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
    { Name: 'ExportedAlignments', Value: String(coverage.alignments ?? 0) },
    { Name: 'ExportedProfiles', Value: String(coverage.profiles ?? 0) },
  ];
  terrain.addPropertySet(terrain.siteId, {
    Name: 'LandXML_Conversion',
    Properties: properties,
  });
}
