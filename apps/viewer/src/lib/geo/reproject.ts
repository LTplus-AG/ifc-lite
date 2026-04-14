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
import { lookupProj4 } from '@ifc-lite/data';

export interface LatLon {
  lat: number;
  lon: number;
}

// Cache resolved projection definitions (from any source).
const projDefCache = new Map<string, string | null>();

/**
 * Extract EPSG numeric code from a CRS name like "EPSG:32632" or "EPSG 2056".
 */
function extractEpsgCode(crs: ProjectedCRS): string | null {
  const match = crs.name?.match(/EPSG[:\s]*(\d+)/i);
  return match ? match[1] : null;
}

/**
 * Well-known CRS names that IFC authoring tools set without an EPSG: prefix.
 * Maps normalised name → EPSG code.
 */
const WELL_KNOWN_CRS: Record<string, string> = {
  'wgs 84': '4326',
  'wgs84': '4326',
  'wgs-84': '4326',
  'nad83': '4269',
  'nad27': '4267',
  'etrs89': '4258',
  'gcs_wgs_1984': '4326',        // ArcGIS / Revit export alias
  'gcs_north_american_1983': '4269',
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
 * Well-known +towgs84 approximations for datums that normally use grid files.
 * These are accurate to ~1-5m, which is sufficient for map display.
 * Grid files (like OSTN15_NTv2_OSGBtoETRS.gsb) cannot run in the browser.
 */
const DATUM_TOWGS84: Record<string, string> = {
  'airy': '+towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489',      // OSGB36 (UK)
  'clrk66': '+towgs84=-8,160,176,0,0,0,0',                                   // NAD27 (approx)
  'GRS80': '+towgs84=0,0,0,0,0,0,0',                                          // GRS80-based (NAD83≈WGS84)
  'bessel': '+towgs84=598.1,73.7,418.2,0.202,0.045,-2.455,6.7',              // DHDN (Germany)
  'intl': '+towgs84=-87,-98,-121,0,0,0,0',                                    // NZGD49 (NZ)
  'aust_SA': '+towgs84=-134,-48,149,0,0,0,0',                                 // AGD84 (Australia)
};

/**
 * Strip +nadgrids=... from a proj4 string and add a +towgs84 approximation
 * based on the ellipsoid. Grid files cannot be loaded in the browser.
 */
function sanitizeProj4(def: string): string {
  if (!def.includes('+nadgrids') || def.includes('+nadgrids=@null')) return def;

  // Extract the ellipsoid to find the right towgs84 approximation
  const ellpsMatch = def.match(/\+ellps=(\S+)/);
  const ellps = ellpsMatch?.[1] ?? '';
  const towgs84 = DATUM_TOWGS84[ellps] ?? '+towgs84=0,0,0,0,0,0,0';

  // Remove +nadgrids=... and add +towgs84
  return def.replace(/\+nadgrids=\S+/g, '').replace(/\s+/g, ' ').trim() + ' ' + towgs84;
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
 *   2. Bundled EPSG index (7000+ codes with proj4 strings)
 *   3. Well-known CRS name lookup (e.g. "WGS 84" → EPSG:4326)
 *   4. UTM zone heuristic (from CRS metadata — mapZone, name, description, mapProjection)
 *   5. Fetch from epsg.io (network fallback)
 */
export async function resolveProjection(crs: ProjectedCRS): Promise<string | null> {
  let code = extractEpsgCode(crs);

  // 1. Check cache
  if (code && projDefCache.has(code)) {
    return projDefCache.get(code) ?? null;
  }

  // 2. Bundled EPSG index (primary source — all 7000+ codes)
  if (code) {
    try {
      const bundled = await lookupProj4(code);
      if (bundled) {
        const sanitized = sanitizeProj4(bundled);
        projDefCache.set(code, sanitized);
        return sanitized;
      }
    } catch {
      // EPSG index not loaded yet, continue to fallbacks
    }
  }

  // 3. Well-known CRS name → EPSG code (handles "WGS 84", "NAD83", etc.)
  if (!code) {
    const normalised = crs.name?.trim().toLowerCase() ?? '';
    const wellKnownCode = WELL_KNOWN_CRS[normalised];
    if (wellKnownCode) {
      code = wellKnownCode;
      if (projDefCache.has(code)) {
        return projDefCache.get(code) ?? null;
      }
      try {
        const bundled = await lookupProj4(code);
        if (bundled) {
          const sanitized = sanitizeProj4(bundled);
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
    const fetched = raw ? sanitizeProj4(raw) : null;
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
  coordinateInfo?: CoordinateInfo,
  lengthUnitScale = 1,
): { easting: number; northing: number } {
  const { ifcX, ifcY } = computeLocalIfcCenter(coordinateInfo);

  // Geometry coordinates (ifcX, ifcY) are already in metres — the geometry engine
  // converts from the IFC file's native unit during extraction. Only MapConversion
  // values (eastings, northings) are in the file's native unit and need scaling.
  const scale = conversion.scale ?? 1.0;
  const abscissa = conversion.xAxisAbscissa ?? 1.0;
  const ordinate = conversion.xAxisOrdinate ?? 0.0;

  const easting = conversion.eastings * lengthUnitScale + scale * (abscissa * ifcX - ordinate * ifcY);
  const northing = conversion.northings * lengthUnitScale + scale * (ordinate * ifcX + abscissa * ifcY);

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
  const mapScale = crs.mapUnitScale ?? lengthUnitScale;
  const { easting, northing } = computeProjectedCenter(conversion, coordinateInfo, mapScale);

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
 * Compute the model's local IFC center offset (ifcX, ifcY) from coordinate info.
 * This is the geometry center in IFC Z-up coordinates, before MapConversion is applied.
 */
function computeLocalIfcCenter(coordinateInfo?: CoordinateInfo): { ifcX: number; ifcY: number } {
  if (!coordinateInfo) return { ifcX: 0, ifcY: 0 };

  const bounds = coordinateInfo.originalBounds;
  const shift = coordinateInfo.originShift;
  const rtc = coordinateInfo.wasmRtcOffset;

  const rtcYup = rtc
    ? { x: rtc.x, y: rtc.z, z: -rtc.y }
    : { x: 0, y: 0, z: 0 };

  const cx = (bounds.min.x + bounds.max.x) / 2;
  const cz = (bounds.min.z + bounds.max.z) / 2;

  const worldYupX = cx + shift.x + rtcYup.x;
  const worldYupZ = cz + shift.z + rtcYup.z;

  return { ifcX: worldYupX, ifcY: -worldYupZ };
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
    const mapScale = crs.mapUnitScale ?? lengthUnitScale;
    const invScale = mapScale !== 0 ? 1 / mapScale : 1;
    const { ifcX, ifcY } = computeLocalIfcCenter(coordinateInfo);
    const scale = conversion?.scale ?? 1.0;
    const abscissa = conversion?.xAxisAbscissa ?? 1.0;
    const ordinate = conversion?.xAxisOrdinate ?? 0.0;

    // Result is in IFC native units (the reverse of: E_native * LUS + geom_offset = E_metres)
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

  const scale = conversion.scale ?? 1.0;
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

    // Geometry coords (ifcX/Y) are already in metres; only MapConversion needs scaling
    const mapScale = crs.mapUnitScale ?? lengthUnitScale;
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
  try {
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${latLon.lat}&longitude=${latLon.lon}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    const elev = data?.elevation?.[0];
    return typeof elev === 'number' && Number.isFinite(elev) ? elev : null;
  } catch {
    return null;
  }
}
