/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Whether the model says where it is at all, and with what: nothing, only an
 * address or the IfcSite reference point, a tool default, a CRS with nothing
 * placed in it, or big numbers in the placements.
 */

import { MAP_MAGNITUDE_METRES, atMapMagnitude, farGeometry, isIfc2x3, round, type DiagnosisContext } from '../context.js';
import { makeFix, newMapConversionChanges, newMapConversionFix, siteMoveChange } from '../fixes.js';
import { matchSiteDefault } from '../site-defaults.js';
import type { CrsFact, GeorefFinding, SuggestedFix, Vec2 } from '../types.js';

function hasOperation(ctx: DiagnosisContext): boolean {
  return !!ctx.facts.entities?.operation || !!ctx.facts.ePSet?.operation;
}

/** A CRS that names a map: a blank Name with no WKT is an empty record, the same as none (see `georeferencingLevels`). */
function declaredCrs(ctx: DiagnosisContext): CrsFact | undefined {
  const usable = (c: CrsFact | undefined): CrsFact | undefined => (c && (c.name.trim() !== '' || c.wellKnownText) ? c : undefined);
  return usable(ctx.crs) ?? usable(ctx.facts.entities?.crs) ?? usable(ctx.facts.ePSet?.crs);
}

/**
 * A file that declares no length unit is read in metres, but the numbers are
 * as often millimetres (a fragment exported without its IfcUnitAssignment).
 * A magnitude claim on such a file must then hold under the millimetre
 * reading too: 1000x further out.
 */
export const UNDECLARED_UNIT_SMALLEST_READING = 0.001;

function farEnough(ctx: DiagnosisContext, v: Vec2 | undefined): v is Vec2 {
  if (!atMapMagnitude(v)) return false;
  if (ctx.facts.lengthUnitDeclared) return true;
  const k = UNDECLARED_UNIT_SMALLEST_READING;
  return atMapMagnitude({ x: v.x * k, y: v.y * k });
}

/** Where the model's coordinates are at map magnitude with no operation: the site placement, else a geometry family. */
function absoluteCoordinates(ctx: DiagnosisContext): { where: string; metres: Vec2; site: boolean } | undefined {
  if (farEnough(ctx, ctx.siteOriginMetres)) return { where: 'site placement', metres: ctx.siteOriginMetres, site: true };
  const far = farGeometry(ctx).find((g) => farEnough(ctx, g.metres));
  if (!far) return undefined;
  return { where: far.family === 'pointLists' ? 'tessellated geometry' : 'geometry', metres: far.metres, site: false };
}

/** Big site or geometry coordinates with no operation and no CRS: the map position is in the placements, grid unnamed. */
function mapCoordinatesInPlacements(ctx: DiagnosisContext): GeorefFinding | undefined {
  if (hasOperation(ctx) || declaredCrs(ctx)) return undefined;
  const absolute = absoluteCoordinates(ctx);
  if (!absolute) return undefined;
  const site = ctx.siteOriginMetres;
  const fixes: SuggestedFix[] = [];
  const origin = ctx.facts.coordinates?.siteOrigin;
  if (absolute.site && origin) {
    const L = ctx.lengthScale;
    const move = siteMoveChange(ctx, origin);
    if (move) {
      fixes.push(makeFix(
        ctx,
        'Move the map position out of the site placement into a map conversion (in metres), and put the site back at the local origin.',
        [...newMapConversionChanges(ctx, { e: origin.x * L, n: origin.y * L, h: origin.z * L }), move.change],
        ['Assumes the map unit is metre and the placement axes are grid-aligned; set the EPSG code yourself.', move.caveat].filter(Boolean).join(' '),
      ));
    }
  }
  return {
    code: 'MAP_COORDINATES_IN_PLACEMENTS',
    severity: 'warning',
    message: `The ${absolute.where} sits about ${Math.round(Math.hypot(absolute.metres.x, absolute.metres.y) / 1000)} km from the origin but the file names no CRS and no map conversion, so no tool can tell which grid these numbers belong to, and viewers lose precision on them: put the map position into an IfcMapConversion instead.`,
    evidence: {
      siteOriginEastMetres: site ? round(site.x) : null,
      siteOriginNorthMetres: site ? round(site.y) : null,
      ...Object.fromEntries(ctx.geometryMedians.flatMap((g) => [[`${g.family}MedianEastMetres`, round(g.metres.x)], [`${g.family}MedianNorthMetres`, round(g.metres.y)]])),
      thresholdMetres: MAP_MAGNITUDE_METRES,
    },
    fixes,
  };
}

/** A CRS with nothing placing the model in it (bot review on PR #10386: a CRS alone used to read as "georeferenced"). */
function crsWithoutOperation(ctx: DiagnosisContext): GeorefFinding | undefined {
  const crs = declaredCrs(ctx);
  if (hasOperation(ctx) || !crs) return undefined;
  const label = crs.name.trim() ? `"${crs.name.trim()}"` : '(defined by WKT)';
  const absolute = absoluteCoordinates(ctx);
  const evidence = { crsSource: crs.source, crsName: crs.name, absoluteCoordinates: absolute?.where ?? null };
  if (absolute) {
    return {
      code: 'CRS_WITHOUT_OPERATION',
      severity: 'warning',
      message: `The CRS ${label} is declared and the ${absolute.where} already sits at map coordinates, but no map conversion links the two, so tools that place a model through its map conversion leave this one at 0,0: add a map conversion with zero offsets.`,
      evidence,
      fixes: [makeFix(ctx, 'Add a map conversion with zero offsets, so the absolute coordinates are read in the declared CRS.', newMapConversionChanges(ctx, { e: 0, n: 0, h: 0 }),
        'Viewers draw in single precision; coordinates of hundreds of kilometres jitter at the millimetre level. Moving them into the map conversion avoids that.')],
    };
  }
  return {
    code: 'CRS_WITHOUT_OPERATION',
    severity: 'warning',
    message: `The CRS ${label} is declared, but no map conversion says where the model is in it, so every GIS tool still puts the model at the CRS's origin: add a map conversion with the map position of the project origin.`,
    evidence,
    fixes: [makeFix(ctx, 'Add a map conversion with the map position of the project origin, in the declared CRS.', newMapConversionChanges(ctx))],
  };
}

export function detectPresence(ctx: DiagnosisContext): GeorefFinding[] {
  const findings: GeorefFinding[] = [];
  const { facts } = ctx;
  const ifc2x3 = isIfc2x3(facts.schemaVersion);
  const site = facts.siteLocation;
  const placements = mapCoordinatesInPlacements(ctx);
  const crsOnly = crsWithoutOperation(ctx);
  const anyCrs = !!declaredCrs(ctx);

  if (!hasOperation(ctx) && !anyCrs && !site && !placements) {
    findings.push({
      code: 'NO_GEOREFERENCE',
      severity: 'warning',
      message: facts.hasPostalAddress
        ? 'The model gives only a postal address, no coordinates (no map conversion, no CRS, no site latitude/longitude), so GIS tools can at best geocode the address and otherwise put it at 0,0: add a map conversion with the EPSG code of your survey grid.'
        : 'The model says nowhere where it is on Earth (no map conversion, no CRS, no site latitude/longitude, no address), so every GIS tool puts it at 0,0: add a map conversion with the EPSG code of your survey grid.',
      evidence: { schemaVersion: facts.schemaVersion, hasPostalAddress: !!facts.hasPostalAddress },
      fixes: [newMapConversionFix(ctx)],
    });
  }

  if (placements) findings.push(placements);
  if (crsOnly) findings.push(crsOnly);

  if (site && !hasOperation(ctx) && !anyCrs && !ifc2x3) {
    findings.push({
      code: 'SITE_LOCATION_ONLY',
      severity: 'warning',
      message: 'Only the site latitude/longitude says where the model is, which IFC calls an approximate indication with no grid, turn or scale, so GIS tools cannot place it precisely: add an IfcMapConversion and IfcProjectedCRS.',
      evidence: { latitude: round(site.latitude, 6), longitude: round(site.longitude, 6) },
      fixes: [newMapConversionFix(ctx)],
    });
  }

  if (site) {
    const match = matchSiteDefault(site.latitude, site.longitude);
    if (match) {
      const label = match === 'nullIsland' ? '0°N 0°E ("Null Island", in the Gulf of Guinea)' : match.label;
      findings.push({
        code: 'SITE_LOCATION_DEFAULT',
        severity: 'warning',
        message: `The site latitude/longitude is ${label}, a value authoring tools leave behind until someone sets the real location: set the project location in your authoring tool (if your site really is there, ignore this).`,
        evidence: {
          latitude: round(site.latitude, 6),
          longitude: round(site.longitude, 6),
          matchedDefault: label,
        },
        fixes: [makeFix(ctx, 'Set RefLatitude and RefLongitude to the real site location.', [
          { entity: 'IfcSite', entityId: site.siteId, attribute: 'RefLatitude', value: null },
          { entity: 'IfcSite', entityId: site.siteId, attribute: 'RefLongitude', value: null },
        ])],
      });
    }
  }

  if (ifc2x3 && !facts.ePSet?.operation) {
    findings.push({
      code: 'IFC2X3_NO_EPSET',
      severity: 'info',
      message: 'IFC2X3 has no IfcMapConversion; the buildingSMART convention for a precise map position in IFC2X3 is an ePSet_MapConversion and ePSet_ProjectedCRS property set, and this file has none.',
      evidence: { schemaVersion: facts.schemaVersion, hasSiteLocation: !!site },
      fixes: [newMapConversionFix(ctx)],
    });
  }

  return findings;
}
