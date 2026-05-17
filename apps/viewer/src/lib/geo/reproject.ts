/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Coordinate reprojection utilities.
 *
 * Converts projected coordinates (e.g. UTM eastings/northings) from an
 * IfcMapConversion + IfcProjectedCRS pair into WGS84 longitude/latitude
 * so they can be displayed on a web map.
 *
 * proj4 definitions are resolved from:
 *   1. The bundled EPSG index (@ifc-lite/data) — covers all 7000+ codes
 *   2. Programmatically constructed (UTM zones, well-known codes)
 *   3. Fetched from epsg.io at runtime as last resort
 */

import proj4 from 'proj4';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { lookupEpsgByCode, lookupProj4 } from '@ifc-lite/data';
import { getEffectiveHorizontalScale, resolveMapUnitToMetreScale } from './geo-scale';
import { resolvePrecisionDef } from './precision-grids';

export interface LatLon {
  lat: number;
  lon: number;
}

// Cache resolved projection definitions (from any source).
const projDefCache = new Map<string, string | null>();
const approxDatumWarningCache = new Set<string>();
// Track datums where the bundled proj4 lacked any datum-shift parameters and we
// couldn't supply a fallback — surfaced via diagnostics, warned once per datum.
const unknownDatumWarningCache = new Set<string>();

/**
 * Extract EPSG numeric code from a CRS name like "EPSG:32632" or "EPSG 2056".
 */
function extractEpsgCode(crs: ProjectedCRS): string | null {
  const match = crs.name?.match(/EPSG[:\s]*(\d+)/i);
  return match ? match[1] : null;
}

/**
 * Well-known CRS names that IFC authoring tools set without an EPSG: prefix.
 * Maps normalised name → EPSG code. Keys are lowercased before lookup.
 *
 * Authoring tools across regions emit different local conventions for the same
 * national grid; covering the common ones lets ifc-lite resolve a projection
 * for files that omit the "EPSG:" prefix entirely.
 */
const WELL_KNOWN_CRS: Record<string, string> = {
  // Global / generic
  'wgs 84': '4326',
  'wgs84': '4326',
  'wgs-84': '4326',
  'nad83': '4269',
  'nad27': '4267',
  'etrs89': '4258',
  'gcs_wgs_1984': '4326',        // ArcGIS / Revit export alias
  'gcs_north_american_1983': '4269',

  // Netherlands — Rijksdriehoeksmeting (RD New, EPSG:28992)
  'rd': '28992',
  'rd new': '28992',
  'amersfoort / rd new': '28992',
  'amersfoort rd new': '28992',
  'stelsel van de rijksdriehoeksmeting': '28992',
  'rijksdriehoeksmeting': '28992',
  'nl_rd': '28992',
  // RD/NAP compound (horizontal RD + vertical NAP)
  'rd new + nap height': '7415',
  'amersfoort / rd new + nap height': '7415',

  // United Kingdom — Ordnance Survey GB (BNG, EPSG:27700)
  'osgb 1936 / british national grid': '27700',
  'osgb36 / british national grid': '27700',
  'british national grid': '27700',
  'bng': '27700',

  // Germany — DHDN / Gauss-Kruger zones + ETRS89 / UTM (most common)
  'dhdn / gauss-kruger zone 2': '31466',
  'dhdn / gauss-kruger zone 3': '31467',
  'dhdn / gauss-kruger zone 4': '31468',
  'dhdn / gauss-kruger zone 5': '31469',
  'etrs89 / utm zone 32n': '25832',
  'etrs89 / utm zone 33n': '25833',

  // Austria — MGI Lambert / Austrian Grid (EPSG:31287)
  'mgi / austria lambert': '31287',
  'austria lambert': '31287',

  // Switzerland — CH1903+ / LV95 (EPSG:2056) and legacy LV03 (EPSG:21781)
  'ch1903+ / lv95': '2056',
  'lv95': '2056',
  'ch1903 / lv03': '21781',
  'lv03': '21781',

  // Belgium — Lambert 2008 (EPSG:3812) and legacy Lambert 72 (EPSG:31370)
  'belge 1972 / belgian lambert 72': '31370',
  'belgian lambert 72': '31370',
  'etrs89 / belgian lambert 2008': '3812',

  // France — RGF93 / Lambert-93 (EPSG:2154)
  'rgf93 / lambert-93': '2154',
  'rgf93 v1 / lambert-93': '2154',
  'lambert-93': '2154',
  'lambert 93': '2154',
};

/**
 * Check if a proj4 definition is a geographic (longlat) CRS rather than a projected one.
 * Geographic CRS coordinates are in degrees, not metres.
 */
function isGeographicProj4(def: string): boolean {
  return /\+proj=longlat\b/.test(def);
}

/**
 * Build a proj4 definition string for a UTM zone.
 */
function utmProj4String(zone: string): string | null {
  const match = zone.match(/^(\d{1,2})([NS])$/i);
  if (!match) return null;
  const zoneNum = parseInt(match[1], 10);
  const isNorth = match[2].toUpperCase() === 'N';
  if (zoneNum < 1 || zoneNum > 60) return null;
  return `+proj=utm +zone=${zoneNum}${isNorth ? '' : ' +south'} +datum=WGS84 +units=m +no_defs`;
}

/**
 * Datum-keyed +towgs84 approximations for CRSs whose canonical definition
 * relies on browser-unavailable grid files (NTv2, NADCON, etc.). Each entry
 * is the published Bursa-Wolf 7-parameter set for that specific datum, in
 * the Position Vector convention proj4 expects, with rotations in arc-seconds.
 *
 * Keys are lowercased datum names as they appear in EpsgIndexEntry.datum. A
 * lookup miss is intentional — it forces sanitizeProj4 to emit a diagnostic
 * rather than silently substitute parameters for the wrong region (an earlier
 * version of this table was keyed by ellipsoid alone, which caused every
 * Bessel-1841 CRS — RD/NL, Hermannskogel/AT, S-JTSK/CZ — to inherit Germany's
 * DHDN shift). Accuracy is typically ~1-5 m, sufficient for map display.
 */
const DATUM_TOWGS84: Record<string, string> = {
  // United Kingdom — OSGB36 (Airy 1830)
  'osgb 1936': '+towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489',
  // North America — NAD27 (Clarke 1866)
  'north american datum 1927': '+towgs84=-8,160,176,0,0,0,0',
  'nad27': '+towgs84=-8,160,176,0,0,0,0',
  // NAD83 ≈ WGS84 to within ~1 m; identity is the standard browser approximation.
  'north american datum 1983': '+towgs84=0,0,0,0,0,0,0',
  'nad83': '+towgs84=0,0,0,0,0,0,0',
  // Germany — DHDN (Bessel 1841)
  'deutsches hauptdreiecksnetz': '+towgs84=598.1,73.7,418.2,0.202,0.045,-2.455,6.7',
  'dhdn': '+towgs84=598.1,73.7,418.2,0.202,0.045,-2.455,6.7',
  // Netherlands — Amersfoort (Bessel 1841). The bundled EPSG:28992 already
  // ships with the higher-precision Kadaster +towgs84, so this fires only
  // when a derived/compound CRS lacks it (e.g. some compound RD/NAP cases).
  'amersfoort': '+towgs84=565.4171,50.3319,465.5524,1.9342,-1.6677,9.1019,4.0725',
  // Austria — MGI (Bessel 1841)
  'militar-geographische institut': '+towgs84=577.326,90.129,463.919,5.137,1.474,5.297,2.4232',
  'mgi': '+towgs84=577.326,90.129,463.919,5.137,1.474,5.297,2.4232',
  // Czech Republic — S-JTSK (Bessel 1841)
  'system of the unified trigonometrical cadastral network': '+towgs84=570.8,85.7,462.8,4.998,1.587,5.261,3.56',
  's-jtsk': '+towgs84=570.8,85.7,462.8,4.998,1.587,5.261,3.56',
  // New Zealand — NZGD49 (International 1924)
  'new zealand geodetic datum 1949': '+towgs84=59.47,-5.04,187.44,0.47,-0.1,1.024,-4.5993',
  'nzgd49': '+towgs84=59.47,-5.04,187.44,0.47,-0.1,1.024,-4.5993',
  // Australia — AGD84 (Australian National Spheroid)
  'australian geodetic datum 1984': '+towgs84=-117.763,-51.51,139.061,0.292,0.443,0.277,-0.191',
  'agd84': '+towgs84=-117.763,-51.51,139.061,0.292,0.443,0.277,-0.191',
};

/**
 * Strip +nadgrids=... from a proj4 string and add a +towgs84 approximation
 * keyed by the datum name from the bundled EPSG index. Grid files cannot be
 * loaded in the browser; +towgs84 is the standard fallback.
 *
 * Skipped (returns input verbatim) when:
 *   - No +nadgrids reference (or it's the no-op `@null`)
 *   - A +towgs84 is already present (proj4 will honour it)
 */
function sanitizeProj4(def: string, code?: string | null, datumName?: string | null): string {
  if (!def.includes('+nadgrids') || def.includes('+nadgrids=@null')) return def;
  if (/\+towgs84=/.test(def)) {
    // Strip the unusable grid reference but keep the existing datum shift.
    return def.replace(/\+nadgrids=\S+/g, '').replace(/\s+/g, ' ').trim();
  }

  const datumKey = datumName?.trim().toLowerCase() ?? '';
  const towgs84 = datumKey ? DATUM_TOWGS84[datumKey] : undefined;

  if (!towgs84) {
    if (datumKey && !unknownDatumWarningCache.has(datumKey)) {
      unknownDatumWarningCache.add(datumKey);
      console.warn(
        `[reproject] EPSG:${code ?? '?'} ("${datumName}") needs browser-unavailable `
        + 'datum grids and has no known +towgs84 fallback for its datum. '
        + 'Positions will be aligned to the source CRS but may be tens of metres '
        + 'off relative to WGS84/basemaps. Consider adding the datum to '
        + 'DATUM_TOWGS84 in apps/viewer/src/lib/geo/reproject.ts.',
      );
    }
    // Strip the grid reference; let proj4 fall through with no datum shift
    // rather than silently substitute a wrong-region transform.
    return def.replace(/\+nadgrids=\S+/g, '').replace(/\s+/g, ' ').trim();
  }

  if (code && !approxDatumWarningCache.has(code)) {
    approxDatumWarningCache.add(code);
    console.warn(
      `[reproject] EPSG:${code} requires browser-unavailable datum grids; `
      + `using approximate +towgs84 for "${datumName}" instead. `
      + 'Expect metre-level XY differences for some locations.',
    );
  }

  return def.replace(/\+nadgrids=\S+/g, '').replace(/\s+/g, ' ').trim() + ' ' + towgs84;
}

/**
 * Inspect a resolved projection string for diagnostics.
 * Returns properties the GeoreferencingPanel surfaces to users.
 */
export interface ProjectionDefDiagnostics {
  hasTowgs84: boolean;
  hasNadgrids: boolean;
  ellipsoid: string | null;
  datumKnown: boolean;
}

export function inspectProjectionDef(def: string | null, datumName?: string | null): ProjectionDefDiagnostics {
  if (!def) {
    return { hasTowgs84: false, hasNadgrids: false, ellipsoid: null, datumKnown: false };
  }
  const ellpsMatch = def.match(/\+ellps=(\S+)/);
  const datumKey = datumName?.trim().toLowerCase() ?? '';
  return {
    hasTowgs84: /\+towgs84=/.test(def),
    hasNadgrids: /\+nadgrids=/.test(def) && !def.includes('+nadgrids=@null'),
    ellipsoid: ellpsMatch?.[1] ?? null,
    datumKnown: datumKey ? Object.prototype.hasOwnProperty.call(DATUM_TOWGS84, datumKey) : false,
  };
}

/**
 * Fetch a proj4 definition string from epsg.io (last-resort fallback).
 */
async function fetchProj4Def(epsgCode: string): Promise<string | null> {
  try {
    const resp = await fetch(`https://epsg.io/${epsgCode}.proj4`);
    if (!resp.ok) return null;
    const text = (await resp.text()).trim();
    if (!text || text.startsWith('<') || text.startsWith('{') || !text.includes('+')) {
      return null;
    }
    return text;
  } catch {
    return null;
  }
}

/**
 * Resolve a proj4 definition for the given ProjectedCRS.
 *
 * Resolution order:
 *   1. Cache hit
 *   2. Precision grid (NTv2/GeoTIFF) for codes where +towgs84 is too coarse
 *      (RD/NL, OSGB/UK, BD72/BE) — fetched once from cdn.proj.org, gives
 *      sub-decimeter accuracy. Falls through to (3) if the fetch fails.
 *   3. Bundled EPSG index (7000+ codes with proj4 strings)
 *   4. Well-known CRS name lookup (e.g. "WGS 84" → EPSG:4326)
 *   5. UTM zone heuristic (from CRS metadata — mapZone, name, description, mapProjection)
 *   6. Fetch from epsg.io (network fallback)
 */
export async function resolveProjection(crs: ProjectedCRS): Promise<string | null> {
  let code = extractEpsgCode(crs);

  // 1. Check cache
  if (code && projDefCache.has(code)) {
    return projDefCache.get(code) ?? null;
  }

  // 2. Precision grid (NTv2/GeoTIFF). For Bessel-based national grids
  // (RD/NL, BD72/BE, OSGB/UK), the +towgs84 approximation that the bundled
  // entries carry is off by 80-200 m. proj4js can consume PROJ's GeoTIFF
  // datum-shift grids — load and register, then use a +nadgrids-based
  // proj4 string for sub-decimeter accuracy.
  if (code) {
    try {
      const precisionDef = await resolvePrecisionDef(code);
      if (precisionDef) {
        projDefCache.set(code, precisionDef);
        return precisionDef;
      }
    } catch (error) {
      console.warn(`[reproject] precision grid resolution failed for EPSG:${code}, falling back`, error);
    }
  }

  // 3. Bundled EPSG index (primary source — all 7000+ codes)
  if (code) {
    try {
      const entry = await lookupEpsgByCode(code);
      if (entry?.proj4) {
        const sanitized = sanitizeProj4(entry.proj4, code, entry.datum);
        projDefCache.set(code, sanitized);
        return sanitized;
      }
    } catch {
      // EPSG index not loaded yet, continue to fallbacks
    }
  }

  // 3. Well-known CRS name → EPSG code (handles "WGS 84", "NAD83", "RD New", etc.)
  if (!code) {
    const normalised = crs.name?.trim().toLowerCase() ?? '';
    const wellKnownCode = WELL_KNOWN_CRS[normalised];
    if (wellKnownCode) {
      code = wellKnownCode;
      if (projDefCache.has(code)) {
        return projDefCache.get(code) ?? null;
      }
      try {
        const entry = await lookupEpsgByCode(code);
        if (entry?.proj4) {
          const sanitized = sanitizeProj4(entry.proj4, code, entry.datum);
          projDefCache.set(code, sanitized);
          // For geographic CRS (longlat), check if we can infer a projected CRS
          // from the UTM zone metadata — a projected CRS is much more useful.
          // If we can't, fall through and return the geographic def below.
        }
      } catch {
        // continue
      }
    }
  }

  // 4. UTM zone heuristic — check mapZone, name, description, AND mapProjection
  if (crs.mapZone) {
    const def = utmProj4String(crs.mapZone);
    if (def) {
      if (code) projDefCache.set(code, def);
      return def;
    }
  }
  const name = crs.name?.toUpperCase() ?? '';
  const utmMatch = name.match(/UTM\s+ZONE\s+(\d{1,2}[NS])/i)
    ?? crs.description?.match(/UTM\s+zone\s+(\d{1,2}[NS])/i)
    ?? crs.mapProjection?.match(/UTM\s+zone\s+(\d{1,2}[NS])/i);
  if (utmMatch) {
    const def = utmProj4String(utmMatch[1]);
    if (def) {
      if (code) projDefCache.set(code, def);
      return def;
    }
  }

  // If step 3 resolved a geographic CRS (e.g. EPSG:4326) and we couldn't
  // upgrade it to a projected CRS via the UTM heuristic, still return it —
  // reprojectToLatLon will handle the longlat identity case.
  if (code && projDefCache.has(code)) {
    return projDefCache.get(code) ?? null;
  }

  // 5. Network fallback — fetch from epsg.io
  if (code) {
    const raw = await fetchProj4Def(code);
    // We don't have a bundled EpsgIndexEntry here (otherwise we'd have hit
    // step 2), so fall back to parsing the datum name out of the proj4
    // string itself when possible. `+datum=` is rare in modern proj4 output;
    // the typical hint is `+ellps=` which we already accept as a weak signal
    // inside DATUM_TOWGS84 keys above.
    const fetched = raw ? sanitizeProj4(raw, code, null) : null;
    projDefCache.set(code, fetched);
    return fetched;
  }

  return null;
}

/**
 * Compute the model center in the projected CRS (easting, northing).
 *
 * The coordinate pipeline is:
 *   1. WASM extracts IFC positions (Z-up) and may apply RTC offset (wasmRtcOffset, Z-up)
 *   2. Mesh collector converts Z-up → Y-up: viewerX = ifcX, viewerY = ifcZ, viewerZ = -ifcY
 *   3. CoordinateHandler may apply originShift (Y-up)
 *
 * To recover IFC world coordinates (Z-up) from the viewer bounds:
 *   world_yup = bounds_center + originShift + wasmRtcOffset_as_yup
 *   ifc_x = world_yup.x,  ifc_y = -world_yup.z,  ifc_z = world_yup.y
 *
 * Then the projected CRS coordinates are:
 *   easting  = mapConversion.eastings + scale * (cos*ifc_x - sin*ifc_y)
 *   northing = mapConversion.northings + scale * (sin*ifc_x + cos*ifc_y)
 */
function computeProjectedCenter(
  conversion: MapConversion,
  coordinateInfo: CoordinateInfo | undefined,
  mapUnitScale: number,
  lengthUnitScale: number,
): { easting: number; northing: number } {
  const { ifcX, ifcY } = computeModelCenterInIfcMeters(coordinateInfo);

  // Geometry coordinates (ifcX, ifcY) are already in metres — the geometry engine
  // converts from the IFC file's native unit during extraction. Only MapConversion
  // values (eastings, northings) are in the file's native unit and need scaling.
  // IfcMapConversion.Scale converts project length unit → map unit (e.g. 0.001
  // for mm→m); since geometry is already in metres, use the effective scale —
  // see issue #595.
  const scale = getEffectiveHorizontalScale(conversion.scale, mapUnitScale, lengthUnitScale);
  const abscissa = conversion.xAxisAbscissa ?? 1.0;
  const ordinate = conversion.xAxisOrdinate ?? 0.0;

  const easting = conversion.eastings * mapUnitScale + scale * (abscissa * ifcX - ordinate * ifcY);
  const northing = conversion.northings * mapUnitScale + scale * (ordinate * ifcX + abscissa * ifcY);

  return { easting, northing };
}

/**
 * Reproject the model center from the projected CRS to WGS84 lat/lon.
 *
 * Uses the model's actual geometry bounds + RTC offset to determine where
 * the model sits in the projected coordinate system, then reprojects to WGS84.
 *
 * @param conversion      IfcMapConversion (offset, rotation, scale)
 * @param crs             IfcProjectedCRS (EPSG code, mapUnitScale)
 * @param coordinateInfo  Geometry coordinate info with bounds and RTC offset
 * @param lengthUnitScale IFC project length unit → metres (fallback when crs.mapUnitScale is absent)
 */
export async function reprojectToLatLon(
  conversion: MapConversion,
  crs: ProjectedCRS,
  coordinateInfo?: CoordinateInfo,
  lengthUnitScale = 1,
): Promise<LatLon | null> {
  const projDef = await resolveProjection(crs);
  if (!projDef) return null;

  // Geographic CRS (e.g. EPSG:4326) — eastings/northings are already lon/lat.
  // Don't add the model's geometry center (in meters) to degree-based coordinates.
  if (isGeographicProj4(projDef)) {
    const lon = conversion.eastings;
    const lat = conversion.northings;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat, lon };
  }

  // MapConversion values use the unit from IfcProjectedCRS.MapUnit. If MapUnit
  // is not specified, the IFC spec defaults to the project's length unit.
  const mapScale = resolveMapUnitToMetreScale(crs.mapUnitScale, lengthUnitScale);
  const { easting, northing } = computeProjectedCenter(conversion, coordinateInfo, mapScale, lengthUnitScale);

  try {
    const [lon, lat] = proj4(projDef, 'WGS84', [easting, northing]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat, lon };
  } catch {
    return null;
  }
}

/**
 * Compute the model's center in IFC Z-up metres from coordinate info.
 * This is the geometry center before MapConversion is applied.
 */
export function computeModelCenterInIfcMeters(
  coordinateInfo?: CoordinateInfo,
): { ifcX: number; ifcY: number; ifcZ: number } {
  if (!coordinateInfo) return { ifcX: 0, ifcY: 0, ifcZ: 0 };

  const bounds = coordinateInfo.originalBounds;
  const shift = coordinateInfo.originShift;
  const rtc = coordinateInfo.wasmRtcOffset;

  const rtcYup = rtc
    ? { x: rtc.x, y: rtc.z, z: -rtc.y }
    : { x: 0, y: 0, z: 0 };

  const cx = (bounds.min.x + bounds.max.x) / 2;
  const cy = (bounds.min.y + bounds.max.y) / 2;
  const cz = (bounds.min.z + bounds.max.z) / 2;

  const worldYupX = cx + shift.x + rtcYup.x;
  const worldYupY = cy + shift.y + rtcYup.y;
  const worldYupZ = cz + shift.z + rtcYup.z;

  return {
    ifcX: worldYupX,
    ifcY: -worldYupZ,
    ifcZ: worldYupY,
  };
}

/**
 * Reverse-project a WGS84 lat/lon into the IfcMapConversion eastings/northings
 * values that would place the model center at the given location.
 *
 * This accounts for the model's local geometry offset, rotation, and scale:
 *   projected = eastings + scale * (cos*ifcX - sin*ifcY)
 *   ⟹ eastings = projected - scale * (cos*ifcX - sin*ifcY)
 */
export async function reprojectFromLatLon(
  latLon: LatLon,
  crs: ProjectedCRS,
  conversion?: MapConversion,
  coordinateInfo?: CoordinateInfo,
  lengthUnitScale = 1,
): Promise<{ easting: number; northing: number } | null> {
  const projDef = await resolveProjection(crs);
  if (!projDef) return null;

  // Geographic CRS — coordinates are lon/lat in degrees, no projection needed.
  if (isGeographicProj4(projDef)) {
    return { easting: latLon.lon, northing: latLon.lat };
  }

  try {
    const [projE, projN] = proj4('WGS84', projDef, [latLon.lon, latLon.lat]);
    if (!Number.isFinite(projE) || !Number.isFinite(projN)) return null;

    // Convert projected metres back to MapConversion's unit.
    // Geometry offsets (ifcX/Y) are already in metres.
    const mapScale = resolveMapUnitToMetreScale(crs.mapUnitScale, lengthUnitScale);
    const invScale = mapScale !== 0 ? 1 / mapScale : 1;
    const { ifcX, ifcY } = computeModelCenterInIfcMeters(coordinateInfo);
    // Effective horizontal scale for metre-converted geometry — see issue #595.
    const scale = getEffectiveHorizontalScale(conversion?.scale, mapScale, lengthUnitScale);
    const abscissa = conversion?.xAxisAbscissa ?? 1.0;
    const ordinate = conversion?.xAxisOrdinate ?? 0.0;

    // Result is in IFC native units (the reverse of: E_native * mapScale + geom_offset = E_metres)
    const easting = (projE - scale * (abscissa * ifcX - ordinate * ifcY)) * invScale;
    const northing = (projN - scale * (ordinate * ifcX + abscissa * ifcY)) * invScale;

    return { easting, northing };
  } catch {
    return null;
  }
}

/**
 * Compute a building footprint rectangle from the model's bounding box and
 * reproject each corner to WGS84 for display as a GeoJSON polygon on a web map.
 *
 * Uses the shiftedBounds (scene-local after RTC) from CoordinateInfo, transforms
 * each corner through the MapConversion pipeline (rotation + scale + offset),
 * then reprojects to lat/lon. The result is a rotated rectangle matching the
 * model's XZ extent on the map.
 *
 * @param lengthUnitScale IFC project length unit → metres (fallback when crs.mapUnitScale is absent)
 * @returns A single GeoJSON-compatible polygon: closed ring of [lon, lat] pairs
 */
export async function computeFootprintGeoJSON(
  conversion: MapConversion,
  crs: ProjectedCRS,
  coordinateInfo: CoordinateInfo,
  lengthUnitScale = 1,
): Promise<[number, number][] | null> {
  const projDef = await resolveProjection(crs);
  if (!projDef) {
    console.warn('[footprint] failed to resolve projection for CRS:', crs.name);
    return null;
  }

  // Geographic CRS values are degrees, while the model bounds are metres.
  // Without a projected CRS / map conversion, we can show the model pin but
  // not a trustworthy footprint polygon.
  if (isGeographicProj4(projDef)) {
    return null;
  }

  // Effective horizontal scale for metre-converted geometry — see issue #595.
  const mapScale = resolveMapUnitToMetreScale(crs.mapUnitScale, lengthUnitScale);
  const scale = getEffectiveHorizontalScale(conversion.scale, mapScale, lengthUnitScale);
  const abscissa = conversion.xAxisAbscissa ?? 1.0;
  const ordinate = conversion.xAxisOrdinate ?? 0.0;

  const shift = coordinateInfo.originShift;
  const rtc = coordinateInfo.wasmRtcOffset;
  const rtcYup = rtc
    ? { x: rtc.x, z: -rtc.y }
    : { x: 0, z: 0 };

  const bounds = coordinateInfo.shiftedBounds;

  // Four corners of the bounding box on the XZ plane (viewer Y-up)
  const corners = [
    { x: bounds.min.x, z: bounds.min.z },
    { x: bounds.max.x, z: bounds.min.z },
    { x: bounds.max.x, z: bounds.max.z },
    { x: bounds.min.x, z: bounds.max.z },
  ];

  const ring: [number, number][] = [];

  for (const c of corners) {
    // Scene-local → world Y-up
    const worldX = c.x + shift.x + rtcYup.x;
    const worldZ = c.z + shift.z + rtcYup.z;

    // Y-up → IFC Z-up: ifcX = worldX, ifcY = -worldZ
    const ifcX = worldX;
    const ifcY = -worldZ;

    // Geometry coords (ifcX/Y) are already in metres; MapConversion values
    // are converted to metres via mapScale.
    const easting = conversion.eastings * mapScale + scale * (abscissa * ifcX - ordinate * ifcY);
    const northing = conversion.northings * mapScale + scale * (ordinate * ifcX + abscissa * ifcY);

    // Projected CRS → WGS84
    try {
      const [lon, lat] = proj4(projDef, 'WGS84', [easting, northing]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      ring.push([lon, lat]);
    } catch {
      return null;
    }
  }

  // Close the ring (GeoJSON requirement)
  ring.push(ring[0]);
  return ring;
}

/**
 * Query terrain elevation at a given lat/lon using the Open-Meteo elevation API.
 * Returns height in metres above sea level, or null on failure.
 */
export async function queryTerrainElevation(latLon: LatLon): Promise<number | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${latLon.lat}&longitude=${latLon.lon}`;
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return null;
    const data = await resp.json();
    const elev = data?.elevation?.[0];
    return typeof elev === 'number' && Number.isFinite(elev) ? elev : null;
  } catch (err) {
    console.warn(`[reproject] queryTerrainElevation failed for ${latLon.lat},${latLon.lon}:`, err);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
