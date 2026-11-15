/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Does the IfcSite latitude/longitude agree with where the map conversion
 * puts the site? Needs a reprojector for a distance; with only a catalogue
 * area of use it can still say "not even in the same region".
 */

import { round, type DiagnosisContext } from '../context.js';
import { mapPositionOf, type DoubleMatch } from '../position.js';
import { haversineKm } from '../site-defaults.js';
import type { GeorefFinding, SkippedCheck } from '../types.js';

/**
 * IFC calls RefLatitude/RefLongitude an approximate indication, and some
 * tools put it at a site corner rather than the placement origin, so a few
 * kilometres of disagreement is not a defect. 10 km is beyond any site.
 */
export const SITE_CONTRADICTION_KM = 10;

/** Margin around a catalogue area of use when no reprojector is available. */
export const AREA_OF_USE_MARGIN_DEGREES = 0.5;

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
  const reprojector = ctx.options.reprojector;
  const area = ctx.catalogEntry?.areaOfUse;
  const unit = ctx.catalogEntry?.unitScale ?? 1;

  if (reprojector) {
    // Where the conversion puts the site's own origin (its placement), unless
    // that origin is the doubled anchor, where the anchor alone is the truth.
    const local = double ? undefined : ctx.siteOriginMetres;
    let best: { km: number; latitude: number; longitude: number; swappedKm: number } | undefined;
    for (const mapScale of ctx.mapScales) {
      const p = mapPositionOf(op, mapScale, local);
      const geo = reprojector.toGeographic(code, p.x / unit, p.y / unit);
      if (!geo) continue;
      const km = haversineKm(site.latitude, site.longitude, geo.latitude, geo.longitude);
      const swappedKm = haversineKm(site.longitude, site.latitude, geo.latitude, geo.longitude);
      if (!best || km < best.km) best = { km, latitude: geo.latitude, longitude: geo.longitude, swappedKm };
    }
    if (!best) {
      skipped.push({ code: 'SITE_LOCATION_CONTRADICTS_OPERATION', reason: `The reprojector cannot handle EPSG:${code}.` });
      return undefined;
    }
    if (best.km <= SITE_CONTRADICTION_KM) return undefined;
    const swapped = best.swappedKm <= SITE_CONTRADICTION_KM;
    return {
      code: 'SITE_LOCATION_CONTRADICTS_OPERATION',
      severity: 'warning',
      message: swapped
        ? `The site latitude and longitude are swapped: written as ${round(site.latitude, 4)}° / ${round(site.longitude, 4)}° they point ${Math.round(best.km)} km from where the map conversion puts the site; swap them.`
        : `The site latitude/longitude points ${Math.round(best.km)} km from where the map conversion puts the site, so tools that read one or the other show the model in different places: set the site location to ${round(best.latitude, 5)}°, ${round(best.longitude, 5)}°.`,
      evidence: {
        method: 'reprojection',
        epsg: code,
        siteLatitude: round(site.latitude, 6),
        siteLongitude: round(site.longitude, 6),
        mapLatitude: round(best.latitude, 6),
        mapLongitude: round(best.longitude, 6),
        distanceKm: round(best.km, 1),
        thresholdKm: SITE_CONTRADICTION_KM,
        swapped,
      },
      fixes: [{
        summary: 'Set the site latitude/longitude to where the map conversion puts the site.',
        changes: [
          { entity: 'IfcSite', entityId: site.siteId, attribute: 'RefLatitude', value: round(best.latitude, 7) },
          { entity: 'IfcSite', entityId: site.siteId, attribute: 'RefLongitude', value: round(best.longitude, 7) },
        ],
      }],
    };
  }

  if (area) {
    const m = AREA_OF_USE_MARGIN_DEGREES;
    const inside = site.longitude >= area.west - m && site.longitude <= area.east + m
      && site.latitude >= area.south - m && site.latitude <= area.north + m;
    if (inside) return undefined;
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
        marginDegrees: m,
      },
      fixes: [{
        summary: 'Set the site latitude/longitude to the real site location.',
        changes: [
          { entity: 'IfcSite', entityId: site.siteId, attribute: 'RefLatitude', value: null },
          { entity: 'IfcSite', entityId: site.siteId, attribute: 'RefLongitude', value: null },
        ],
      }],
    };
  }

  skipped.push({ code: 'SITE_LOCATION_CONTRADICTS_OPERATION', reason: 'No reprojector and no CRS area of use injected.' });
  return undefined;
}
