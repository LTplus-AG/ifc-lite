/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Point reprojection between a resolved CRS and WGS84.
 */

import proj4 from 'proj4';
import { resolveMapUnitToMetreScale } from './map-unit.js';
import { isGeographicProj4, projectedDefinitionInMetres } from './proj4-utils.js';
import { resolveProjection, type CrsDescriptor } from './resolve-projection.js';
import { reportCrsDiagnostic } from './diagnostics.js';
import { isWithinWktDefinitionExtent } from './wkt-projection.js';

export interface LatLon {
  lat: number;
  lon: number;
}

/** Geographic input and WGS84 output use finite longitude/latitude degrees. */
function validLatLon(lon: number, lat: number): boolean {
  return Number.isFinite(lon) && Number.isFinite(lat)
    && lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90;
}

/** Inputs are degrees for geographic CRSs, metres for projected CRSs. */
export function coordinatesToLatLon(definition: string, x: number, y: number): LatLon | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (isGeographicProj4(definition) && !validLatLon(x, y)) return null;
  try {
    const [lon, lat] = proj4(projectedDefinitionInMetres(definition), 'WGS84', [x, y]);
    return validLatLon(lon, lat) && isWithinWktDefinitionExtent(definition, lon, lat) ? { lat, lon } : null;
  } catch (error) {
    reportCrsDiagnostic('[reproject] coordinate transformation failed', error);
    return null;
  }
}

/**
 * WGS84 degrees to the CRS: degrees for a geographic CRS, metres for a
 * projected one. The inverse of {@link coordinatesToLatLon}, with the same
 * refusals: a position outside the extent a WKT declares is `null` in both
 * directions.
 */
export function latLonToCoordinates(definition: string, lon: number, lat: number): { x: number; y: number } | null {
  if (!validLatLon(lon, lat) || !isWithinWktDefinitionExtent(definition, lon, lat)) return null;
  try {
    const [x, y] = proj4('WGS84', projectedDefinitionInMetres(definition), [lon, lat]);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  } catch (error) {
    reportCrsDiagnostic('[reproject] inverse coordinate transformation failed', error);
    return null;
  }
}

/**
 * Reproject an explicit projected point (eastings/northings in the CRS map
 * unit) to WGS84 lat/lon. Unlike a model-centre reprojection, which derives the
 * point from geometry, this takes coordinates already resolved in the map CRS — e.g.
 * a picked point's E/N from the measure geo readout (issue #1657).
 *
 * @param eastings        Easting in the CRS map unit.
 * @param northings       Northing in the CRS map unit.
 * @param crs             IfcProjectedCRS (EPSG code, mapUnitScale).
 * @param lengthUnitScale IFC project length unit to metres (fallback when
 *                        crs.mapUnitScale is absent).
 */
export async function reprojectPointToLatLon(
  eastings: number,
  northings: number,
  crs: CrsDescriptor,
  lengthUnitScale = 1,
): Promise<LatLon | null> {
  const projDef = await resolveProjection(crs);
  if (!projDef) return null;

  // Geographic coordinates remain degrees; projected coordinates enter proj4 in metres.
  const mapScale = isGeographicProj4(projDef)
    ? 1 : resolveMapUnitToMetreScale(crs.mapUnitScale, lengthUnitScale);
  return coordinatesToLatLon(projDef, eastings * mapScale, northings * mapScale);
}

/**
 * Reverse-project a WGS84 point to the declared origin's map-unit coordinates.
 * This is the inverse of reprojectPointToLatLon, independent of mesh placement
 * (#6677). Geometry-aware inverse placement lives in the shared spatial reference.
 */
export async function reprojectFromLatLon(
  latLon: LatLon,
  crs: CrsDescriptor,
  lengthUnitScale = 1,
): Promise<{ easting: number; northing: number } | null> {
  const projDef = await resolveProjection(crs);
  if (!projDef) return null;

  const projected = latLonToCoordinates(projDef, latLon.lon, latLon.lat);
  if (!projected) return null;
  const mapScale = isGeographicProj4(projDef)
    ? 1 : resolveMapUnitToMetreScale(crs.mapUnitScale, lengthUnitScale);
  return { easting: projected.x / mapScale, northing: projected.y / mapScale };
}
