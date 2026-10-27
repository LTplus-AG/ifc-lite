/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GeoWarp: viewer coordinates to the anchor's east/north/up frame, point by
 * point, through the map projection.
 *
 * The anchor placement (`cesium-bridge`) draws the model in one tangent plane,
 * which ignores Earth curvature (1 m at 5 km), the change of projection scale
 * and convergence across the site, geoid slope and the shape of a datum shift.
 * This module computes where each point is:
 *
 *   viewer → IFC → map (E, N, H) → proj4 → (lon, lat), h = H + ΔN_geoid
 *     → ECEF → anchor ENU
 *
 * `createGeoMapping` does that exactly for one point; `createLatticeWarp`
 * (`geo-lattice.ts`) samples it on a lattice and interpolates per vertex.
 *
 * MAP COORDINATES, by source (the classification is `ground-scale.ts`'s):
 * - Grid-coordinate sources (IfcRigidOperation, map-absolute geometry, a
 *   Scale·Factor equal to k_c) are map coordinates: E = E0 + R·s·x, projected
 *   as authored.
 * - True-length geometry (plain IfcMapConversion, effective scale 1, or any
 *   scale that is not k_c) is in ground lengths about the conversion's origin,
 *   so its grid offset from (E0, N0) is k_c times longer:
 *   E = E0 + k_c·R·s·x, with k_c the combined scale factor at the anchor.
 *   This is the reading recommended for plain IfcMapConversion in the
 *   per-vertex placement research (an E0 + R·x reading would draw it k_c too
 *   small, 32 mm per 100 m on a UTM central meridian). It differs from the
 *   anchor placement, which puts the model centre at E0 + R·x_c, by
 *   (1 − k_c)·|R·x_c|: the anchor approximation's error for a model whose
 *   centre is far from its local origin, not the warp's.
 * - A geographic target CRS: the geometry is ENU metres about the anchor
 *   (`cesium-bridge`), a topocentric frame in which the anchor placement is
 *   already exact, so the mapping is that same linear map.
 *
 * HEIGHTS are anchor-relative: h = anchor.h + (H − H_anchor) + (N(p) − N(anchor)),
 * so an anchor height the bridge chose (terrain clamp, `placementHeightOverride`)
 * carries over to every point, and only the geoid's change across the site is
 * added. Vertical grids are not modelled (proj4 has none).
 */

import proj4 from 'proj4';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { totalYupOffset } from '@ifc-lite/geometry/world-frame';
import type { CesiumModelOriginInfo } from './cesium-bridge';
import { isGeographicProj4, projectedDefinitionInMetres } from './proj4-utils';
import { isWithinWktDefinitionExtent, isWktDefinition } from './wkt-projection';
import { effectiveMapConversionForGeometry, isMapAbsoluteGeometry } from './map-absolute';
import { getEffectiveAxisScales, resolveMapUnitToMetreScale } from './geo-scale';
import { gridCoordinateSource } from './ground-scale';
import { resolveMapAxisDirection } from './map-axis-direction';
import { viewerToEnuRotation } from './viewer-enu-rotation';
import { viewerFrameCenter } from './cesium-viewer-frame';
import { ecefToGeodetic, enuFrameAt, geodeticToEcef } from './geo-ecef';

/** The origin fields the mapping reads, as `computeCesiumModelOrigin` returns them. */
export type GeoWarpOrigin = Pick<CesiumModelOriginInfo,
  'longitude' | 'latitude' | 'height' | 'ifcOriginHeight' | 'easting' | 'northing'
  | 'scaleX' | 'scaleY' | 'scaleZ' | 'combinedScaleFactor' | 'gridSource'>;

export interface GeoMappingInput {
  /**
   * The AUTHORED conversion, the one `createCesiumBridge` passes to
   * `computeCesiumModelOrigin`: map-absolute geometry is detected from its
   * anchor, which a neutralised copy no longer carries.
   */
  mapConversion: MapConversion;
  projectedCRS: Pick<ProjectedCRS, 'mapUnitScale'>;
  /** `resolveProjection(projectedCRS)`: a proj4 string or a registered `IFC-WKT:` name. */
  projDef: string;
  coordinateInfo?: CoordinateInfo;
  lengthUnitScale?: number;
  /** `computeCesiumModelOrigin` for the same conversion, CRS and coordinate info. */
  origin: GeoWarpOrigin;
  /**
   * Geoid undulation N (metres) at (lat, lon) degrees: the model the origin
   * applied (`egm96Undulation`), or `() => 0` when heights are ellipsoidal.
   */
  geoid: (latDeg: number, lonDeg: number) => number;
}

/** One point through the full chain. */
export interface GeoPoint {
  longitude: number;
  latitude: number;
  /** Authored orthometric height H (the IFC contract, before the geoid). */
  orthometricHeight: number;
  /** Ellipsoidal height h as placed on the globe. */
  ellipsoidalHeight: number;
}

export interface GeoMapping {
  /** The ENU frame's origin: the bridge's model origin. */
  readonly anchor: { longitude: number; latitude: number; height: number };
  /** Exact geodetic position, or null when the point cannot be placed. */
  toGeodetic(vx: number, vy: number, vz: number): GeoPoint | null;
  /** Exact anchor-ENU position written to `out` (e, n, u); false when unplaceable. */
  toEnu(vx: number, vy: number, vz: number, out: Float64Array | number[]): boolean;
}

const finite = (...values: number[]) => values.every(Number.isFinite);

/**
 * The exact per-point mapping for a georeference, or null (logged) when it
 * cannot be built: an unusable axis, a non-finite origin, or an origin that
 * was not computed from this conversion.
 */
export function createGeoMapping(input: GeoMappingInput): GeoMapping | null {
  const { origin, projDef } = input;
  if (!finite(origin.longitude, origin.latitude, origin.height, origin.ifcOriginHeight,
    origin.easting, origin.northing, origin.scaleX, origin.scaleY, origin.scaleZ)
    || !(origin.combinedScaleFactor > 0) || !Number.isFinite(origin.combinedScaleFactor)) {
    console.warn('[geo-warp] the model origin is not finite (or k_c is not positive); no per-point mapping.');
    return null;
  }
  return isGeographicProj4(projDef) ? geographicMapping(input) : projectedMapping(input);
}

function projectedMapping(input: GeoMappingInput): GeoMapping | null {
  const { origin, projDef, coordinateInfo } = input;
  const lengthUnitScale = input.lengthUnitScale ?? 1;
  const mapScale = resolveMapUnitToMetreScale(input.projectedCRS.mapUnitScale, lengthUnitScale);
  const mapAbsolute = isMapAbsoluteGeometry(input.mapConversion, mapScale, coordinateInfo);
  const conversion = effectiveMapConversionForGeometry(input.mapConversion, mapScale, coordinateInfo);
  const axis = resolveMapAxisDirection(conversion.xAxisAbscissa, conversion.xAxisOrdinate);
  if (!axis) {
    console.warn('[geo-warp] the conversion has no usable XAxis direction; no per-point mapping.');
    return null;
  }
  const { x: sx, y: sy, z: sz } = getEffectiveAxisScales(conversion, mapScale, lengthUnitScale);
  const kc = origin.combinedScaleFactor;
  const gridSource = gridCoordinateSource(conversion, { x: sx, y: sy }, mapAbsolute, kc);
  if (gridSource !== origin.gridSource) {
    // The two formulae differ by k_c (metres over a site) and, for
    // map-absolute geometry, by the whole anchor offset: never guess.
    console.warn(`[geo-warp] the origin reads the geometry as ${origin.gridSource ?? 'true-length'} but this `
      + `conversion as ${gridSource ?? 'true-length'}; pass the authored conversion the origin was computed from.`);
    return null;
  }
  const k = gridSource ? 1 : kc;
  const e0 = conversion.eastings * mapScale;
  const n0 = conversion.northings * mapScale;
  const h0 = conversion.orthogonalHeight * mapScale;
  if (!finite(e0, n0, h0, sx, sy, sz)) {
    console.warn('[geo-warp] the conversion is not finite; no per-point mapping.');
    return null;
  }
  const { a, b } = axis;
  const shift = totalYupOffset(coordinateInfo);
  const toWgs84 = proj4(projectedDefinitionInMetres(projDef), 'WGS84');
  const anchor = { longitude: origin.longitude, latitude: origin.latitude, height: origin.height };
  const frame = enuFrameAt(anchor.latitude, anchor.longitude, anchor.height);
  const anchorUndulation = input.geoid(anchor.latitude, anchor.longitude);
  const ecef = [0, 0, 0];
  let warned = false;

  function toGeodetic(vx: number, vy: number, vz: number): GeoPoint | null {
    if (!finite(vx, vy, vz)) return null;
    const x = vx + shift.x;
    const y = -(vz + shift.z);
    const z = vy + shift.y;
    const easting = e0 + k * (a * sx * x - b * sy * y);
    const northing = n0 + k * (b * sx * x + a * sy * y);
    const height = h0 + sz * z;
    let lon: number, lat: number;
    try {
      [lon, lat] = toWgs84.forward([easting, northing]);
    } catch (error) {
      if (!warned) console.warn('[geo-warp] projection failed', error);
      warned = true;
      return null;
    }
    if (!finite(lon, lat, height) || !isWithinWktDefinitionExtent(projDef, lon, lat)) return null;
    const h = anchor.height + (height - origin.ifcOriginHeight) + (input.geoid(lat, lon) - anchorUndulation);
    return Number.isFinite(h) ? { longitude: lon, latitude: lat, orthometricHeight: height, ellipsoidalHeight: h } : null;
  }

  function toEnu(vx: number, vy: number, vz: number, out: Float64Array | number[]): boolean {
    const g = toGeodetic(vx, vy, vz);
    if (!g) return false;
    geodeticToEcef(g.latitude, g.longitude, g.ellipsoidalHeight, ecef);
    frame.fromEcef(ecef[0], ecef[1], ecef[2], out);
    return true;
  }

  return { anchor, toGeodetic, toEnu };
}

/**
 * Geographic target: the anchor placement's own linear map (`buildViewerToEcefMatrix`
 * with convergence 0 and ground scale 1), which is exact in a topocentric frame.
 */
function geographicMapping(input: GeoMappingInput): GeoMapping | null {
  const { origin, projDef, coordinateInfo, mapConversion } = input;
  const axis = resolveMapAxisDirection(mapConversion.xAxisAbscissa, mapConversion.xAxisOrdinate);
  if (!axis) {
    console.warn('[geo-warp] the conversion has no usable XAxis direction; no per-point mapping.');
    return null;
  }
  const mapScale = resolveMapUnitToMetreScale(input.projectedCRS.mapUnitScale, input.lengthUnitScale ?? 1);
  const rot = viewerToEnuRotation(origin.scaleX, axis.a, axis.b, 0, origin.scaleY);
  const center = viewerFrameCenter(coordinateInfo);
  const shiftY = totalYupOffset(coordinateInfo).y;
  // Only a registered WKT carries an extent to refuse against; skip the geodetic round trip otherwise.
  const guarded = isWktDefinition(projDef);
  const anchor = { longitude: origin.longitude, latitude: origin.latitude, height: origin.height };
  const frame = enuFrameAt(anchor.latitude, anchor.longitude, anchor.height);
  const ecef = [0, 0, 0];

  function enuOf(vx: number, vy: number, vz: number, out: Float64Array | number[]): boolean {
    if (!finite(vx, vy, vz)) return false;
    const dx = vx - center.x, dz = vz - center.z;
    out[0] = rot.eastFromVx * dx + rot.eastFromVz * dz;
    out[1] = rot.northFromVx * dx + rot.northFromVz * dz;
    out[2] = origin.scaleZ * (vy - center.y);
    return true;
  }

  function geodeticOf(enu: ArrayLike<number>) {
    frame.toEcef(enu[0], enu[1], enu[2], ecef);
    const g = ecefToGeodetic(ecef[0], ecef[1], ecef[2]);
    return isWithinWktDefinitionExtent(projDef, g.longitude, g.latitude) ? g : null;
  }

  function toEnu(vx: number, vy: number, vz: number, out: Float64Array | number[]): boolean {
    return enuOf(vx, vy, vz, out) && (!guarded || geodeticOf(out) !== null);
  }

  function toGeodetic(vx: number, vy: number, vz: number): GeoPoint | null {
    const enu = [0, 0, 0];
    const g = enuOf(vx, vy, vz, enu) ? geodeticOf(enu) : null;
    if (!g) return null;
    return {
      longitude: g.longitude,
      latitude: g.latitude,
      // The authored height, as `CesiumBridge.viewerToGeodetic` reports it.
      orthometricHeight: mapConversion.orthogonalHeight * mapScale + origin.scaleZ * (vy + shiftY),
      ellipsoidalHeight: g.height,
    };
  }

  return { anchor, toGeodetic, toEnu };
}
