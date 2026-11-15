/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Whether the model says where it is at all, and with what: nothing, only the
 * IfcSite reference point, a tool default, or big numbers in the placements.
 */

import { MAP_MAGNITUDE_METRES, isIfc2x3, round, type DiagnosisContext } from '../context.js';
import { matchSiteDefault } from '../site-defaults.js';
import type { FieldChange, GeorefFinding, SuggestedFix } from '../types.js';

/** The fields a new map conversion needs, valued `null` where only the user knows the answer. */
function newMapConversionFix(ePSet: boolean, values?: { e: number; n: number; h: number }): SuggestedFix {
  const op = ePSet ? 'ePSet_MapConversion' : 'IfcMapConversion';
  const crs = ePSet ? 'ePSet_ProjectedCRS' : 'IfcProjectedCRS';
  const changes: FieldChange[] = [
    { entity: crs, attribute: 'Name', value: null },
    { entity: op, attribute: 'Eastings', value: values ? round(values.e) : null },
    { entity: op, attribute: 'Northings', value: values ? round(values.n) : null },
    { entity: op, attribute: 'OrthogonalHeight', value: values ? round(values.h) : null },
  ];
  return {
    summary: ePSet
      ? 'Add ePSet_MapConversion and ePSet_ProjectedCRS with the EPSG code and the map position of the project origin.'
      : 'Add an IfcMapConversion and IfcProjectedCRS with the EPSG code and the map position of the project origin.',
    changes,
  };
}

function hasOperation(ctx: DiagnosisContext): boolean {
  return !!ctx.facts.entities?.operation || !!ctx.facts.ePSet?.operation;
}

/** Big site or geometry coordinates with no operation: the map position is in the placements (LoGeoRef 30). */
function mapCoordinatesInPlacements(ctx: DiagnosisContext): GeorefFinding | undefined {
  if (hasOperation(ctx)) return undefined;
  const site = ctx.siteOriginMetres;
  const points = ctx.pointMedianMetres;
  const siteFar = site && Math.hypot(site.x, site.y) >= MAP_MAGNITUDE_METRES;
  const pointsFar = points && Math.hypot(points.x, points.y) >= MAP_MAGNITUDE_METRES;
  if (!siteFar && !pointsFar) return undefined;
  const where = siteFar ? 'site placement' : 'geometry';
  const origin = siteFar ? ctx.facts.coordinates?.siteOrigin : ctx.facts.coordinates?.pointMedian;
  const far = (siteFar ? site : points) as { x: number; y: number };
  const fixes: SuggestedFix[] = [];
  if (siteFar && origin) {
    const L = ctx.lengthScale;
    const move = newMapConversionFix(isIfc2x3(ctx.facts.schemaVersion), { e: origin.x * L, n: origin.y * L, h: origin.z * L });
    move.summary = 'Move the map position out of the site placement into a map conversion (in metres), and put the site back at the local origin.';
    move.changes.push({ entity: 'IfcLocalPlacement', entityId: ctx.facts.coordinates?.sitePlacementId, attribute: 'Location', value: [0, 0, 0] });
    move.caveat = 'Assumes the map unit is metre and the placement axes are grid-aligned; set the EPSG code yourself.';
    fixes.push(move);
  }
  return {
    code: 'MAP_COORDINATES_IN_PLACEMENTS',
    severity: 'warning',
    message: `The ${where} sits about ${Math.round(Math.hypot(far.x, far.y) / 1000)} km from the origin but the file names no map conversion, so no tool can tell which grid these numbers belong to, and viewers lose precision on them: put the map position into an IfcMapConversion instead.`,
    evidence: {
      siteOriginEastMetres: site ? round(site.x) : null,
      siteOriginNorthMetres: site ? round(site.y) : null,
      pointMedianEastMetres: points ? round(points.x) : null,
      pointMedianNorthMetres: points ? round(points.y) : null,
      thresholdMetres: MAP_MAGNITUDE_METRES,
    },
    fixes,
  };
}

export function detectPresence(ctx: DiagnosisContext): GeorefFinding[] {
  const findings: GeorefFinding[] = [];
  const { facts } = ctx;
  const ifc2x3 = isIfc2x3(facts.schemaVersion);
  const site = facts.siteLocation;
  const placements = mapCoordinatesInPlacements(ctx);
  const anyCrs = !!facts.entities?.crs || !!facts.ePSet?.crs;

  if (!hasOperation(ctx) && !anyCrs && !site && !placements) {
    findings.push({
      code: 'NO_GEOREFERENCE',
      severity: 'warning',
      message: 'The model says nowhere where it is on Earth (no map conversion, no CRS, no site latitude/longitude), so every GIS tool puts it at 0,0: add a map conversion with the EPSG code of your survey grid.',
      evidence: { schemaVersion: facts.schemaVersion },
      fixes: [newMapConversionFix(ifc2x3)],
    });
  }

  if (placements) findings.push(placements);

  if (site && !hasOperation(ctx) && !ifc2x3) {
    findings.push({
      code: 'SITE_LOCATION_ONLY',
      severity: 'warning',
      message: 'Only the site latitude/longitude says where the model is, which IFC calls an approximate indication with no grid, turn or scale, so GIS tools cannot place it precisely: add an IfcMapConversion and IfcProjectedCRS.',
      evidence: { latitude: round(site.latitude, 6), longitude: round(site.longitude, 6) },
      fixes: [newMapConversionFix(false)],
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
        fixes: [{
          summary: 'Set RefLatitude and RefLongitude to the real site location.',
          changes: [
            { entity: 'IfcSite', entityId: site.siteId, attribute: 'RefLatitude', value: null },
            { entity: 'IfcSite', entityId: site.siteId, attribute: 'RefLongitude', value: null },
          ],
        }],
      });
    }
  }

  if (ifc2x3 && !facts.ePSet?.operation) {
    findings.push({
      code: 'IFC2X3_NO_EPSET',
      severity: 'info',
      message: 'IFC2X3 has no IfcMapConversion; the buildingSMART convention for a precise map position in IFC2X3 is an ePSet_MapConversion and ePSet_ProjectedCRS property set, and this file has none.',
      evidence: { schemaVersion: facts.schemaVersion, hasSiteLocation: !!site },
      fixes: [newMapConversionFix(true)],
    });
  }

  return findings;
}
