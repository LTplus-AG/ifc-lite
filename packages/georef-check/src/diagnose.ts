/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { atMapMagnitude, buildContext, farGeometry, isIfc2x3, type DiagnosisContext } from './context.js';
import { detectConsistency } from './detectors/consistency.js';
import { detectCrs } from './detectors/crs.js';
import { detectPosition } from './detectors/position.js';
import { detectPresence } from './detectors/presence.js';
import { detectRotation } from './detectors/rotation.js';
import { detectSiteContradiction } from './detectors/site.js';
import { detectUnits } from './detectors/units.js';
import type {
  CrsFact,
  CrsRequirement,
  DiagnoseOptions,
  GeorefFacts,
  GeorefFindingCode,
  GeorefIndicators,
  GeorefLevel,
  GeorefReport,
  SkippedCheck,
} from './types.js';

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

const POSITION_DEFECTS: ReadonlySet<GeorefFindingCode> = new Set<GeorefFindingCode>([
  'EASTING_ZONE_PREFIX',
  'EASTING_ZONE_PREFIX_MISSING',
  'LV03_LV95_MIX',
  'OUTSIDE_CRS_AREA',
]);

/** "Declared" as detectCrs reads it: a name or a definition, not a blank record. */
function isDeclaredCrs(crs: CrsFact | undefined): boolean {
  return !!crs && (crs.name.trim() !== '' || !!crs.wellKnownText);
}

/**
 * Levels of Georeferencing present in the file, per their published
 * definition (Clemen & Görne 2019; the IFCGeoRefChecker documentation,
 * https://github.com/dd-bim/City2BIM/wiki/IFCGeoRefChecker; restated by Jaud
 * & Clemen, ISPRS Annals X-4/W5-2024). Each level stands on its own:
 * - 10: an IfcPostalAddress referenced by an IfcSite or IfcBuilding;
 * - 20: an IfcSite with RefLatitude and RefLongitude;
 * - 30: a location or rotation stored in the placement of a spatial
 *   structure element whose IfcLocalPlacement has an empty PlacementRelTo
 *   (the checker's test: a Location coordinate other than zero). No distance
 *   rule: the level says where the value is stored, not that it is a map
 *   coordinate (see {@link GeorefIndicators.placementAtMapMagnitude});
 * - 40: the 3D model context's WorldCoordinateSystem off the origin, or an
 *   authored TrueNorth other than +y;
 * - 50: an IfcMapConversion (or its IFC4X3 subtype IfcMapConversionScaled)
 *   onto a declared CRS. Only possible from IFC4: an IFC2X3 ePSet_MapConversion
 *   is the documented workaround, not this level
 *   ({@link GeorefIndicators.ePSetConvention}), and an IFC4X3 IfcRigidOperation
 *   is not an IfcMapConversion ({@link GeorefIndicators.rigidOperation}).
 */
export function georeferencingLevels(facts: GeorefFacts): GeorefLevel[] {
  const levels: GeorefLevel[] = [];
  if (facts.hasPostalAddress) levels.push(10);
  if (facts.siteLocation) levels.push(20);
  const roots = facts.rootSpatialPlacements ?? [];
  if (roots.some((r) => r.rotated || r.location.x !== 0 || r.location.y !== 0 || r.location.z !== 0)) levels.push(30);
  const north = facts.trueNorth;
  const customNorth = !!north && !(Math.abs(north.x) < 1e-9 && north.y > 0);
  const origin = facts.contextOrigin;
  if (customNorth || (origin && (origin.x !== 0 || origin.y !== 0 || origin.z !== 0))) levels.push(40);
  const op = facts.entities?.operation;
  const crs = facts.entities?.crs;
  if (!isIfc2x3(facts.schemaVersion) && op?.source === 'IfcMapConversion' && isDeclaredCrs(crs)) levels.push(50);
  return levels;
}

/** The stricter notions the published levels leave out. */
export function georeferencingIndicators(facts: GeorefFacts, ctx: DiagnosisContext = buildContext(facts, {})): GeorefIndicators {
  return {
    placementAtMapMagnitude: atMapMagnitude(ctx.siteOriginMetres),
    geometryAtMapMagnitude: farGeometry(ctx).length > 0,
    ePSetConvention: !!facts.ePSet?.operation,
    rigidOperation: facts.entities?.operation?.source === 'IfcRigidOperation',
    crsDeclared: isDeclaredCrs(facts.entities?.crs) || isDeclaredCrs(facts.ePSet?.crs),
  };
}

/**
 * The CRSs {@link diagnoseGeoreference} will ask the reprojector about, so a
 * caller with an asynchronous resolver (`@ifc-lite/geo`'s `resolveCrs`) can
 * resolve them first and hand in a synchronous {@link Reprojector}. Empty
 * when nothing will be reprojected (no operation, or a CRS with no EPSG code,
 * which the reprojection checks then report as skipped). Pass the same
 * `crsCatalog` as to the diagnosis: it can resolve a CRS written by name.
 */
export function crsRequirements(facts: GeorefFacts, options: Pick<DiagnoseOptions, 'crsCatalog'> = {}): CrsRequirement[] {
  const ctx = buildContext(facts, options);
  if (!ctx.operation || !ctx.resolved || !ctx.crs || ctx.crs.source === 'IfcGeographicCRS') return [];
  const requirement: CrsRequirement = { epsg: ctx.resolved.code };
  if (ctx.crs.name.trim()) requirement.name = ctx.crs.name;
  if (ctx.crs.wellKnownText) requirement.wkt = ctx.crs.wellKnownText;
  return [requirement];
}

/**
 * Diagnose a model's georeferencing from its facts. Pure: no I/O, no globals;
 * the reprojector and CRS catalogue are injected and every check that needs
 * a missing one is listed in `skipped` instead of guessed.
 *
 * Precision over recall: each detector fires only on a signature a correct
 * model cannot show (thresholds are documented beside each detector and in
 * the README).
 */
export function diagnoseGeoreference(facts: GeorefFacts, options: DiagnoseOptions = {}): GeorefReport {
  const ctx = buildContext(facts, options);
  const skipped: SkippedCheck[] = [];
  const position = detectPosition(ctx, skipped);
  // A map position already reported as impossible would only be echoed (with
  // a nonsense "set the site to the mid-Atlantic" fix), so the site check waits for it.
  const positionFlagged = position.findings.some((f) => POSITION_DEFECTS.has(f.code));
  if (positionFlagged && facts.siteLocation && ctx.operation) {
    skipped.push({ code: 'SITE_LOCATION_CONTRADICTS_OPERATION', reason: 'The map position itself is reported as wrong; fix that first.' });
  }
  const site = positionFlagged ? undefined : detectSiteContradiction(ctx, position.double, skipped);
  const findings = [
    ...detectPresence(ctx),
    ...position.findings,
    ...(site ? [site] : []),
    ...detectUnits(ctx),
    ...detectCrs(ctx),
    ...detectRotation(ctx),
    ...detectConsistency(ctx),
  ].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  const levels = georeferencingLevels(facts);
  const effectiveSource = ctx.operation?.source ?? (facts.siteLocation && !ctx.crs ? 'IfcSite' : undefined);
  return {
    level: levels.length ? levels[levels.length - 1] : 0,
    levels,
    effectiveSource,
    findings,
    skipped,
    indicators: georeferencingIndicators(facts, ctx),
  };
}
