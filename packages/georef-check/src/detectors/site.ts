/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Does the IfcSite latitude/longitude agree with where the map conversion
 * puts the site? Needs a reprojector for a distance; with only a catalogue
 * area of use it can still say "not even in the same region".
 *
 * Neither side is assumed to be the truth. When one of them cannot be a real
 * place (a map conversion at the CRS's false origin or off its area, a site
 * at a tool default), the finding names it as the suspect and offers a fix
 * only in the plausible direction; when both are suspect, none.
 */

import { AREA_OF_USE_MARGIN_DEGREES, insideAreaOfUse } from '../area.js';
import { operationAttribute, operationChange, round, toWgs84, type DiagnosisContext } from '../context.js';
import { makeFix } from '../fixes.js';
import { modelMapPositions, type DoubleMatch } from '../position.js';
import { haversineKm, matchSiteDefault } from '../site-defaults.js';
import type { GeorefFinding, SkippedCheck, SuggestedFix, Vec2 } from '../types.js';

/**
 * IFC calls RefLatitude/RefLongitude an approximate indication, and some
 * tools put it at a site corner rather than the placement origin, so a few
 * kilometres of disagreement is not a defect. 10 km is beyond any site.
 */
export const SITE_CONTRADICTION_KM = 10;

/**
 * A map position within this many metres of E 0 / N 0 is the CRS's false
 * origin, a value left behind when nobody entered a position: no projected
 * CRS in use puts its own area there (EPSG:3857's is in the Gulf of Guinea,
 * UTM's is off the zone).
 */
export const FALSE_ORIGIN_RADIUS_METRES = 1_000;

type Geo = { latitude: number; longitude: number };

/** Why the map conversion's position cannot be the real place, if it cannot. */
function conversionSuspicion(ctx: DiagnosisContext, code: number, map: Vec2, geo: Geo): string | undefined {
  if (Math.hypot(map.x, map.y) < FALSE_ORIGIN_RADIUS_METRES) {
    return `it puts the model at E ${round(map.x, 0)} / N ${round(map.y, 0)}, the false origin of EPSG:${code}, which is what a map conversion holds when no position was entered`;
  }
  if (matchSiteDefault(geo.latitude, geo.longitude) === 'nullIsland') {
    return 'it puts the model at 0°N 0°E, in the Gulf of Guinea';
  }
  const area = ctx.catalogEntry?.areaOfUse;
  if (area && !insideAreaOfUse(area, geo.latitude, geo.longitude)) {
    return `it puts the model at ${round(geo.latitude, 4)}°, ${round(geo.longitude, 4)}°, outside the region where EPSG:${code} is used`;
  }
  return undefined;
}

/** Why the site latitude/longitude cannot be the real place, if it cannot. */
function siteSuspicion(ctx: DiagnosisContext, site: Geo): string | undefined {
  const known = matchSiteDefault(site.latitude, site.longitude);
  if (known) return known === 'nullIsland' ? 'it is 0°N 0°E, in the Gulf of Guinea' : `it is ${known.label}, an authoring-tool default`;
  const area = ctx.catalogEntry?.areaOfUse;
  if (area && !insideAreaOfUse(area, site.latitude, site.longitude)) return 'it is outside the region where the CRS is used';
  return undefined;
}

export function detectSiteContradiction(
  ctx: DiagnosisContext,
  double: DoubleMatch | undefined,
  skipped: SkippedCheck[],
): GeorefFinding | undefined {
  const site = ctx.facts.siteLocation;
  const op = ctx.operation;
  if (!site || !op) return undefined;
  const code = ctx.resolved?.code;
  if (code === undefined) {
    skipped.push({ code: 'SITE_LOCATION_CONTRADICTS_OPERATION', reason: 'The CRS has no EPSG code to reproject from.' });
    return undefined;
  }
  if (ctx.crs?.source === 'IfcGeographicCRS') {
    skipped.push({ code: 'SITE_LOCATION_CONTRADICTS_OPERATION', reason: 'Operations onto a geographic CRS are not compared yet.' });
    return undefined;
  }
  const area = ctx.catalogEntry?.areaOfUse;
  const siteChanges = (lat: number | null, lon: number | null) => [
    { entity: 'IfcSite' as const, entityId: site.siteId, attribute: 'RefLatitude', value: lat },
    { entity: 'IfcSite' as const, entityId: site.siteId, attribute: 'RefLongitude', value: lon },
  ];

  if (ctx.options.reprojector) {
    // Where the conversion puts the model (the site origin, else geometry in
    // map coordinates, else the local origin; the anchor alone when it is
    // applied twice), under every map-unit reading. The closest wins: a
    // contradiction must hold under all of them.
    let best: { km: number; geo: Geo; map: Vec2; swappedKm: number } | undefined;
    let error: string | undefined;
    let unresolved = false;
    for (const { position } of modelMapPositions(ctx, double)) {
      const geo = toWgs84(ctx, code, position.x, position.y);
      if (!geo) { unresolved = true; continue; }
      if ('error' in geo) { error = geo.error; unresolved = true; continue; }
      const km = haversineKm(site.latitude, site.longitude, geo.latitude, geo.longitude);
      const swappedKm = haversineKm(site.longitude, site.latitude, geo.latitude, geo.longitude);
      if (!best || km < best.km) best = { km, geo, map: position, swappedKm };
    }
    if (!best) {
      skipped.push({ code: 'SITE_LOCATION_CONTRADICTS_OPERATION', reason: error ? `The reprojector failed for EPSG:${code}: ${error}` : `The reprojector cannot handle EPSG:${code}.` });
      return undefined;
    }
    if (best.km <= SITE_CONTRADICTION_KM) return undefined;
    if (unresolved) {
      // A reading the reprojector could not place might be the one that
      // agrees with the site: the contradiction is not established under all.
      skipped.push({ code: 'SITE_LOCATION_CONTRADICTS_OPERATION', reason: error ? `The reprojector failed for EPSG:${code} under one map-unit reading: ${error}` : `The reprojector cannot place every map-unit reading under EPSG:${code}.` });
      return undefined;
    }
    const swapped = best.swappedKm <= SITE_CONTRADICTION_KM;
    const conversionSuspect = swapped ? undefined : conversionSuspicion(ctx, code, best.map, best.geo);
    const siteSuspect = swapped ? undefined : siteSuspicion(ctx, site);
    const suspect = conversionSuspect && siteSuspect ? 'both' : conversionSuspect ? 'mapConversion' : siteSuspect ? 'siteLocation' : null;
    const at = `${round(site.latitude, 4)}°, ${round(site.longitude, 4)}°`;
    const km = Math.round(best.km);
    let message: string;
    const fixes: SuggestedFix[] = [];
    if (swapped) {
      message = `The site latitude and longitude are swapped: written as ${at} they point ${km} km from where the map conversion puts the site; swap them.`;
      fixes.push(makeFix(ctx, 'Set the site latitude/longitude to where the map conversion puts the site.', siteChanges(round(best.geo.latitude, 7), round(best.geo.longitude, 7))));
    } else if (suspect === 'both') {
      message = `The site latitude/longitude and the map conversion disagree by ${km} km, and neither can be the real place: the map conversion because ${conversionSuspect}, the site because ${siteSuspect}. Enter the real position in the map conversion (and the site location).`;
    } else if (suspect === 'mapConversion') {
      message = `The site latitude/longitude (${at}) and the map conversion disagree by ${km} km, and the map conversion is the suspect one: ${conversionSuspect}. Enter the map position of the project origin as the map conversion's Eastings/Northings.`;
      fixes.push(makeFix(
        ctx,
        'Enter the map position of the project origin (near the site location) as Eastings/Northings.',
        [operationChange(op, operationAttribute(op, 'eastings'), null), operationChange(op, operationAttribute(op, 'northings'), null)],
        `The site location ${at} says roughly where; the survey grid coordinates must come from the survey or the authoring tool.`,
      ));
    } else {
      message = suspect === 'siteLocation'
        ? `The site latitude/longitude points ${km} km from where the map conversion puts the site, and the site location is the suspect one (${siteSuspect}): set the site location to ${round(best.geo.latitude, 5)}°, ${round(best.geo.longitude, 5)}°.`
        : `The site latitude/longitude points ${km} km from where the map conversion puts the site, so tools that read one or the other show the model in different places: check which is right; if the map conversion is, set the site location to ${round(best.geo.latitude, 5)}°, ${round(best.geo.longitude, 5)}°.`;
      fixes.push(makeFix(
        ctx,
        'Set the site latitude/longitude to where the map conversion puts the site.',
        siteChanges(round(best.geo.latitude, 7), round(best.geo.longitude, 7)),
        suspect === 'siteLocation' ? undefined : 'If the site location is the right one, the map conversion is wrong instead: correct its Eastings/Northings rather than the site.',
      ));
    }
    return {
      code: 'SITE_LOCATION_CONTRADICTS_OPERATION',
      severity: 'warning',
      message,
      evidence: {
        method: 'reprojection',
        epsg: code,
        siteLatitude: round(site.latitude, 6),
        siteLongitude: round(site.longitude, 6),
        mapLatitude: round(best.geo.latitude, 6),
        mapLongitude: round(best.geo.longitude, 6),
        mapEastMetres: round(best.map.x),
        mapNorthMetres: round(best.map.y),
        distanceKm: round(best.km, 1),
        thresholdKm: SITE_CONTRADICTION_KM,
        swapped,
        suspect,
      },
      fixes,
    };
  }

  if (area) {
    if (insideAreaOfUse(area, site.latitude, site.longitude)) return undefined;
    return {
      code: 'SITE_LOCATION_CONTRADICTS_OPERATION',
      severity: 'warning',
      message: `The site latitude/longitude ${round(site.latitude, 4)}°, ${round(site.longitude, 4)}° is outside the region where EPSG:${code} is used, so it cannot be where the map conversion puts the model: set the site location to the real place.`,
      evidence: {
        method: 'areaOfUse',
        epsg: code,
        siteLatitude: round(site.latitude, 6),
        siteLongitude: round(site.longitude, 6),
        areaWest: area.west,
        areaSouth: area.south,
        areaEast: area.east,
        areaNorth: area.north,
        marginDegrees: AREA_OF_USE_MARGIN_DEGREES,
      },
      fixes: [makeFix(ctx, 'Set the site latitude/longitude to the real site location.', siteChanges(null, null))],
    };
  }

  skipped.push({ code: 'SITE_LOCATION_CONTRADICTS_OPERATION', reason: 'No reprojector and no CRS area of use injected.' });
  return undefined;
}
