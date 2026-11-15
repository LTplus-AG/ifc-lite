/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Model reprojection for the viewer: where a loaded model's geometry sits in
 * its projected CRS, and from there on a WGS84 map.
 *
 * CRS resolution and point reprojection are `@ifc-lite/geo`; this module adds
 * what needs the render frame (`CoordinateInfo`) and re-exports the engine
 * entry points under the viewer's long-standing import path.
 */

import { isFeatureEnabled } from '../features/index.js';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { coordinatesToLatLon, isGeographicProj4, resolveProjection, type LatLon } from '@ifc-lite/geo/proj4';
import './crs-network';
import { getEffectiveAxisScales, resolveMapUnitToMetreScale } from './geo-scale';
import { computeModelCenterInIfcMeters, effectiveMapConversionForGeometry } from './map-absolute';
import { ifcToViewerAxes } from './coordinate-frame';
import { resolveMapAxisDirection } from './map-axis-direction';

export { computeModelCenterInIfcMeters, effectiveMapConversionForGeometry } from './map-absolute';
export {
  reprojectFromLatLon,
  reprojectPointToLatLon,
  resolveProjection,
  resolveProjectionId,
  resolveProjectionOperation,
  type LatLon,
} from '@ifc-lite/geo/proj4';

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
 *
 * (cos, sin) is the UNIT direction of XAxisAbscissa/XAxisOrdinate
 * ({@link resolveMapAxisDirection}); the vector's length is not a scale (#6700).
 * Returns null when the authored vector carries no direction.
 */
function computeProjectedCenter(
  rawConversion: MapConversion,
  coordinateInfo: CoordinateInfo | undefined,
  mapUnitScale: number,
  lengthUnitScale: number,
): { easting: number; northing: number } | null {
  // Map-absolute geometry (#2526): neutralise a conversion the geometry
  // already carries, or the offsets/rotation get applied twice.
  const conversion = effectiveMapConversionForGeometry(rawConversion, mapUnitScale, coordinateInfo);
  const { ifcX, ifcY } = computeModelCenterInIfcMeters(coordinateInfo);

  // Geometry coordinates (ifcX, ifcY) are already in metres — the geometry engine
  // converts from the IFC file's native unit during extraction. Only MapConversion
  // values (eastings, northings) are in the file's native unit and need scaling.
  // IfcMapConversion.Scale converts project length unit → map unit (e.g. 0.001
  // for mm→m); since geometry is already in metres, use the effective scale —
  // see issue #595.
  const { x: scaleX, y: scaleY } = getEffectiveAxisScales(conversion, mapUnitScale, lengthUnitScale);
  const axis = resolveMapAxisDirection(conversion.xAxisAbscissa, conversion.xAxisOrdinate);
  if (!axis) return null;
  const { a: abscissa, b: ordinate } = axis;

  const easting = conversion.eastings * mapUnitScale + abscissa * scaleX * ifcX - ordinate * scaleY * ifcY;
  const northing = conversion.northings * mapUnitScale + ordinate * scaleX * ifcX + abscissa * scaleY * ifcY;

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

  // Geographic CRS offsets are source-datum angles, transformed separately.
  // Don't add the model's geometry center (in meters) to degree-based coordinates.
  if (isGeographicProj4(projDef)) {
    return coordinatesToLatLon(projDef, conversion.eastings, conversion.northings);
  }

  // MapConversion values use the unit from IfcProjectedCRS.MapUnit. If MapUnit
  // is not specified, the IFC spec defaults to the project's length unit.
  const mapScale = resolveMapUnitToMetreScale(crs.mapUnitScale, lengthUnitScale);
  const center = computeProjectedCenter(conversion, coordinateInfo, mapScale, lengthUnitScale);
  if (!center) return null;
  const { easting, northing } = center;

  return coordinatesToLatLon(projDef, easting, northing);
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
  rawConversion: MapConversion,
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
  // Map-absolute geometry (#2526): same neutralisation as the centre pin.
  const conversion = effectiveMapConversionForGeometry(rawConversion, mapScale, coordinateInfo);
  const { x: scaleX, y: scaleY } = getEffectiveAxisScales(conversion, mapScale, lengthUnitScale);
  const axis = resolveMapAxisDirection(conversion.xAxisAbscissa, conversion.xAxisOrdinate);
  if (!axis) {
    console.warn('[footprint] IfcMapConversion axis has no usable direction:', conversion.xAxisAbscissa, conversion.xAxisOrdinate);
    return null;
  }
  const { a: abscissa, b: ordinate } = axis;

  const shift = coordinateInfo.originShift;
  const rtcYup = ifcToViewerAxes(coordinateInfo.wasmRtcOffset ?? { x: 0, y: 0, z: 0 });

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
    const easting = conversion.eastings * mapScale + abscissa * scaleX * ifcX - ordinate * scaleY * ifcY;
    const northing = conversion.northings * mapScale + ordinate * scaleX * ifcX + abscissa * scaleY * ifcY;

    // Projected CRS → WGS84
    const point = coordinatesToLatLon(projDef, easting, northing);
    if (!point) return null;
    ring.push([point.lon, point.lat]);
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
  if (!isFeatureEnabled('privacy.third-party')) return null;
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
