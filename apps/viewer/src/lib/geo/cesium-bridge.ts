/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cesium coordinate bridge — lookAtTransform approach.
 *
 * KEY INSIGHT (from Cesium GitHub #6032): Camera.setView() with direction/up
 * vectors causes drift because it doesn't properly orthonormalize. The fix:
 * use lookAtTransform() which sets a reference frame and keeps the camera
 * matrix clean.
 *
 * APPROACH: Build a single 4x4 matrix that transforms from IFC viewer space
 * to ECEF, pass it to Cesium via lookAtTransform(). Then set camera position,
 * direction, and up in IFC viewer coordinates — Cesium applies the transform
 * internally with full precision.
 *
 * The viewer→ECEF transform is composed of:
 *   1. Translate by (-modelCenter) to center on model origin
 *   2. Rotate via viewerYup→ifcZup axis swap
 *   3. Rotate via Helmert (IFC→projected CRS alignment)
 *   4. Transform ENU→ECEF via Cesium.Transforms.eastNorthUpToFixedFrame()
 *
 * Since this is a SINGLE matrix, it's applied atomically by Cesium — no
 * intermediate rounding or re-orthonormalization. The model stays pinned.
 */

import proj4 from 'proj4';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { queryTerrainElevation, resolveProjection } from './reproject';
import { getEffectiveHorizontalScale } from './effective-georef';

/**
 * Module-level cache for terrain elevation lookups so that bridge rebuilds
 * (georef edits, clamp toggles) re-use the value within the session instead
 * of re-hitting the Open-Meteo API or re-loading 3D-tile depth buffers.
 */
const terrainElevationCache = new Map<string, number>();
function terrainCacheKey(lat: number, lon: number): string {
  // 5 decimal places ≈ 1.1m precision — plenty for site-level elevation.
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

export interface GeodesicPosition {
  longitude: number;
  latitude: number;
  height: number;
}

export interface CesiumBridge {
  modelOrigin: GeodesicPosition;
  rotationAngle: number;

  /**
   * Sync the Cesium camera using lookAtTransform with a viewer→ECEF matrix.
   * The IFC camera position/direction/up are passed in viewer coordinates —
   * Cesium transforms them to ECEF internally using one consistent matrix.
   */
  syncCamera(
    Cesium: typeof import('cesium'),
    viewer: InstanceType<typeof import('cesium').Viewer>,
    camPos: { x: number; y: number; z: number },
    camTarget: { x: number; y: number; z: number },
    camUp: { x: number; y: number; z: number },
    fov: number,
    terrainClampOffset?: number,
  ): void;

  /** Query terrain height at model origin. */
  queryTerrainHeight(
    Cesium: typeof import('cesium'),
    viewer: InstanceType<typeof import('cesium').Viewer>,
  ): Promise<number | null>;

  viewerToGeodetic(vx: number, vy: number, vz: number): GeodesicPosition | null;
}

export async function createCesiumBridge(
  mapConversion: MapConversion,
  projectedCRS: ProjectedCRS,
  coordinateInfo?: CoordinateInfo,
  lengthUnitScale = 1,
  /**
   * If provided, replaces the IFC-derived origin altitude (mapConversion's
   * OrthogonalHeight + viewer-space Z) for the enuToEcef origin used by both
   * the camera frame and the model matrix. Pass the terrain-clamped placement
   * here to bake "model on terrain" into the bridge from creation, so the
   * model never has to be moved after loading into Cesium.
   */
  placementHeightOverride?: number,
): Promise<CesiumBridge | null> {
  const projDef = await resolveProjection(projectedCRS);
  if (!projDef) return null;

  const absc = mapConversion.xAxisAbscissa ?? 1.0;
  const ordi = mapConversion.xAxisOrdinate ?? 0.0;
  const rotAngle = Math.atan2(ordi, absc);

  const shift = coordinateInfo?.originShift ?? { x: 0, y: 0, z: 0 };
  const rtc = coordinateInfo?.wasmRtcOffset;
  const rtcYup = rtc
    ? { x: rtc.x, y: rtc.z, z: -rtc.y }
    : { x: 0, y: 0, z: 0 };

  const bounds = coordinateInfo?.originalBounds;
  const modelVX = bounds ? (bounds.min.x + bounds.max.x) / 2 : 0;
  const modelVY = bounds ? (bounds.min.y + bounds.max.y) / 2 : 0;
  const modelVZ = bounds ? (bounds.min.z + bounds.max.z) / 2 : 0;

  // ── Compute model origin in WGS84 ──
  const owx = modelVX + shift.x + rtcYup.x;
  const owy = modelVY + shift.y + rtcYup.y;
  const owz = modelVZ + shift.z + rtcYup.z;
  // Viewer Y-up → IFC Z-up
  const oIfcX = owx;
  const oIfcY = -owz;
  const oIfcZ = owy;
  // Geometry coordinates (oIfcX/Y/Z) are already in metres (the geometry engine
  // converts from the IFC file's native unit during extraction). MapConversion
  // values use the unit from IfcProjectedCRS.MapUnit; fall back to project unit.
  const mapScale = projectedCRS.mapUnitScale ?? lengthUnitScale;
  // IfcMapConversion.Scale bridges project length unit → map unit (e.g. 0.001
  // for mm→m). Geometry is already in metres, so the effective horizontal
  // scale is (Scale * mapUnitScale) / lengthUnitScale — see issue #595.
  const hScale = getEffectiveHorizontalScale(mapConversion.scale, mapScale, lengthUnitScale);
  const oEasting = mapConversion.eastings * mapScale + hScale * (absc * oIfcX - ordi * oIfcY);
  const oNorthing = mapConversion.northings * mapScale + hScale * (ordi * oIfcX + absc * oIfcY);
  const ifcOHeight = mapConversion.orthogonalHeight * mapScale + oIfcZ;
  // The actual altitude used for the enuToEcef origin. When the caller
  // pre-computes a terrain-clamped placement, we honour it so the bridge,
  // model matrix, and camera frame are all built around the SAME altitude
  // from the start — no post-load shifting required.
  const oHeight = placementHeightOverride ?? ifcOHeight;

  let originLon: number, originLat: number;
  try {
    const [lon, lat] = proj4(projDef, 'WGS84', [oEasting, oNorthing]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    originLon = lon;
    originLat = lat;
  } catch {
    return null;
  }

  const modelOrigin: GeodesicPosition = {
    longitude: originLon,
    latitude: originLat,
    height: oHeight,
  };

  // ── Build the viewer→ENU 3x3 rotation matrix ──
  // This converts a DELTA vector from viewer space to ENU.
  // Step 1: viewer Y-up → IFC Z-up: (vx, vy, vz) → (vx, -vz, vy)
  // Step 2: Helmert rotation: (ifcX, ifcY) → (east, north) with scale
  //
  // Combined as a 3x3 matrix M where [east, north, up] = M * [vx, vy, vz]:
  //   east  = hScale * (absc * vx - ordi * (-vz))  = hScale * (absc*vx + ordi*vz)
  //   north = hScale * (ordi * vx + absc * (-vz))   = hScale * (ordi*vx - absc*vz)
  //   up    = vy  (ifcZ = vy, vertical is viewer Y)
  //
  // So M = [hScale*absc,   0,  hScale*ordi ]
  //        [hScale*ordi,   0, -hScale*absc ]
  //        [0,             1,  0           ]
  // Viewer-space deltas are already in metres (geometry engine converts during
  // extraction), so no lengthUnitScale needed here.
  const m00 = hScale * absc;   // east  from vx
  const m01 = 0;               // east  from vy
  const m02 = hScale * ordi;   // east  from vz
  const m10 = hScale * ordi;   // north from vx
  const m11 = 0;               // north from vy
  const m12 = -hScale * absc;  // north from vz
  const m20 = 0;               // up    from vx
  const m21 = 1;               // up    from vy (vertical = viewer Y, already metres)
  const m22 = 0;               // up    from vz

  // ── Cache for ECEF objects ──
  let viewerToEcefMatrix: InstanceType<typeof import('cesium').Matrix4> | null = null;
  let modelOriginCartesian: InstanceType<typeof import('cesium').Cartesian3> | null = null;
  let cachedClampUp: number | null = null;

  function ensureEcefCache(Cesium: typeof import('cesium'), clampUp: number) {
    if (cachedClampUp === clampUp && viewerToEcefMatrix !== null) return;
    cachedClampUp = clampUp;

    const originWithClamp = Cesium.Cartesian3.fromDegrees(
      originLon, originLat, oHeight + clampUp,
    );
    modelOriginCartesian = originWithClamp;

    // Get ENU→ECEF 4x4 matrix at model origin
    const enuToEcef = Cesium.Transforms.eastNorthUpToFixedFrame(originWithClamp);

    // Build viewer→ECEF = enuToEcef * viewerToENU
    // viewerToENU is: translate(-modelCenter) then rotate by M
    // As a 4x4: columns are the ENU directions of viewer axes, translation is -modelCenter in ENU
    //
    // viewerToENU_4x4 = [ m00  m01  m02  tx ]
    //                    [ m10  m11  m12  ty ]
    //                    [ m20  m21  m22  tz ]
    //                    [ 0    0    0    1  ]
    // where (tx, ty, tz) = M * (-modelVX, -modelVY, -modelVZ)
    const tx = m00 * (-modelVX) + m01 * (-modelVY) + m02 * (-modelVZ);
    const ty = m10 * (-modelVX) + m11 * (-modelVY) + m12 * (-modelVZ);
    const tz = m20 * (-modelVX) + m21 * (-modelVY) + m22 * (-modelVZ);

    // Cesium Matrix4 is column-major
    const viewerToEnu = new Cesium.Matrix4(
      m00, m01, m02, tx,
      m10, m11, m12, ty,
      m20, m21, m22, tz,
      0,   0,   0,   1,
    );

    // Compose: viewerToEcef = enuToEcef * viewerToEnu
    viewerToEcefMatrix = Cesium.Matrix4.multiply(
      enuToEcef, viewerToEnu, new Cesium.Matrix4(),
    );
  }

  function syncCamera(
    Cesium: typeof import('cesium'),
    viewer: InstanceType<typeof import('cesium').Viewer>,
    camPos: { x: number; y: number; z: number },
    camTarget: { x: number; y: number; z: number },
    camUp: { x: number; y: number; z: number },
    fov: number,
    terrainClampOffset?: number,
  ): void {
    const clampUp = terrainClampOffset ?? 0;
    ensureEcefCache(Cesium, clampUp);
    if (!viewerToEcefMatrix) return;

    // Set the camera's reference frame to our viewer→ECEF transform.
    // After this call, all camera properties (position, direction, up)
    // are interpreted in IFC VIEWER coordinates, not ECEF.
    viewer.camera.lookAtTransform(viewerToEcefMatrix);

    // Now set camera in VIEWER coordinates — Cesium applies the transform
    viewer.camera.position = new Cesium.Cartesian3(camPos.x, camPos.y, camPos.z);

    const dirX = camTarget.x - camPos.x;
    const dirY = camTarget.y - camPos.y;
    const dirZ = camTarget.z - camPos.z;
    const dirLen = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
    if (dirLen > 1e-8) {
      viewer.camera.direction = new Cesium.Cartesian3(
        dirX / dirLen, dirY / dirLen, dirZ / dirLen,
      );
    }

    viewer.camera.up = new Cesium.Cartesian3(camUp.x, camUp.y, camUp.z);

    // Recompute right = direction × up (maintain orthonormality)
    const right = Cesium.Cartesian3.cross(
      viewer.camera.direction, viewer.camera.up, new Cesium.Cartesian3(),
    );
    Cesium.Cartesian3.normalize(right, right);
    viewer.camera.right = right;

    // Sync FOV — CRITICAL for preventing model drift.
    // IFC renderer uses `fov` as VERTICAL FOV always.
    // Cesium's PerspectiveFrustum.fov is HORIZONTAL when aspect > 1 (landscape).
    // If we set Cesium's fov = IFC's vertical fov, Cesium treats it as horizontal,
    // producing a completely different projection — the model slides during orbit.
    // Fix: convert vertical FOV → horizontal FOV.
    const frustum = viewer.camera.frustum;
    if (frustum instanceof Cesium.PerspectiveFrustum) {
      const aspect = frustum.aspectRatio || (viewer.canvas.width / viewer.canvas.height);
      if (aspect > 1) {
        // Landscape: Cesium expects horizontal FOV
        // horizontal_fov = 2 * atan(aspect * tan(vertical_fov / 2))
        frustum.fov = 2 * Math.atan(aspect * Math.tan(fov / 2));
      } else {
        // Portrait: Cesium uses fov as vertical — pass through
        frustum.fov = fov;
      }
    }

    viewer.scene.requestRender();
  }

  /**
   * Query terrain elevation at the model's location, trying fast Cesium
   * sources first then falling back to Open-Meteo for environments that
   * have 3D Tiles or Photorealistic tiles instead of a Cesium terrain
   * provider (where globe.getHeight returns 0 and sampleTerrainMostDetailed
   * has nothing to query).
   *
   * Cesium's sync probes occasionally return absurd values (we observed
   * globe.getHeight returning -69184 m on Google Photorealistic 3D Tiles
   * with no Cesium ion terrain — depth-buffer noise from an unrendered
   * area). Every candidate is range-checked against terrestrial bounds
   * before being accepted.
   *
   * Order:
   *   1. Cache (instant — re-bridge after georef edit).
   *   2. globe.getHeight (sync, only useful with a non-ellipsoid terrain
   *      provider AND tiles already loaded for the location).
   *   3. scene.sampleHeight (sync, queries all primitives including 3D
   *      Tiles, only works if tiles for the location are already rendered).
   *   4. Open-Meteo elevation API (~200-500ms, always works online).
   *   5. scene.sampleHeightMostDetailed (async, loads tiles — slow last
   *      resort if Open-Meteo fails).
   */
  async function queryTerrainHeight(
    Cesium: typeof import('cesium'),
    viewer: InstanceType<typeof import('cesium').Viewer>,
  ): Promise<number | null> {
    // Earth's plausible terrestrial elevation range. Mariana Trench is ~−11 km
    // (no buildings there) and Everest summit is ~8.85 km. Anything outside
    // this band is depth-buffer / uninitialised garbage from Cesium and must
    // be discarded so we don't bury the model 70 km underground.
    const ELEV_MIN = -1000;
    const ELEV_MAX = 9000;
    const isPlausibleElevation = (h: number): boolean =>
      Number.isFinite(h) && h > ELEV_MIN && h < ELEV_MAX && Math.abs(h) > 1e-3;

    const cacheKey = terrainCacheKey(originLat, originLon);
    const cached = terrainElevationCache.get(cacheKey);
    if (cached !== undefined) {
      console.debug(`[CesiumBridge] terrain (cached) at ${cacheKey}: ${cached.toFixed(2)}m`);
      return cached;
    }

    const position = Cesium.Cartographic.fromDegrees(originLon, originLat);
    const finish = (h: number, source: string, ms?: number) => {
      terrainElevationCache.set(cacheKey, h);
      const t = ms !== undefined ? ` (${ms.toFixed(0)}ms)` : '';
      console.debug(`[CesiumBridge] terrain via ${source}: ${h.toFixed(2)}m at ${cacheKey}${t}`);
      return h;
    };
    const reject = (h: unknown, source: string) => {
      console.debug(`[CesiumBridge] ${source} returned implausible value ${h}; skipping`);
    };

    // 1. Sync globe.getHeight — useful when a Cesium terrain provider is set
    //    AND its tile for this location is loaded. Often noisy garbage with
    //    Google Photorealistic 3D Tiles + no ion terrain; the range filter
    //    below catches that.
    try {
      const h = viewer.scene.globe.getHeight(position);
      if (h !== undefined && isPlausibleElevation(h)) {
        return finish(h, 'globe.getHeight');
      }
      if (h !== undefined) reject(h, 'globe.getHeight');
    } catch (err) {
      console.warn('[CesiumBridge] globe.getHeight threw:', err);
    }

    // 2. Sync scene.sampleHeight — works with 3D Tiles (Google
    //    Photorealistic, Cesium OSM Buildings) when their tiles are already
    //    rendered. Returns undefined if the area isn't in the depth buffer.
    const sampleHeightSupported = (viewer.scene as { sampleHeightSupported?: boolean }).sampleHeightSupported;
    if (sampleHeightSupported) {
      try {
        const h = (viewer.scene as { sampleHeight: (p: unknown) => number | undefined }).sampleHeight(position);
        if (h !== undefined && isPlausibleElevation(h)) {
          return finish(h, 'scene.sampleHeight');
        }
        if (h !== undefined) reject(h, 'scene.sampleHeight');
      } catch (err) {
        console.warn('[CesiumBridge] scene.sampleHeight threw:', err);
      }
    }

    // 3. Open-Meteo elevation API — reliable network fallback (~300ms with
    //    the 5s timeout we added). Doesn't need any tiles loaded; works for
    //    Google 3D Tiles environments where Cesium has no tile depth yet.
    try {
      const t0 = performance.now();
      const elev = await queryTerrainElevation({ lat: originLat, lon: originLon });
      const ms = performance.now() - t0;
      if (elev !== null && isPlausibleElevation(elev)) {
        return finish(elev, 'Open-Meteo', ms);
      }
      if (elev !== null) reject(elev, 'Open-Meteo');
    } catch (err) {
      console.warn('[CesiumBridge] Open-Meteo elevation threw:', err);
    }

    // 4. Last-resort: force Cesium to load tiles for this location and
    //    sample. Slow (seconds) but the most accurate when 3D Tiles are
    //    the only elevation source and Open-Meteo is unavailable.
    if (sampleHeightSupported) {
      try {
        const t0 = performance.now();
        type SampleHeightDetailed = (positions: unknown[]) => Promise<unknown[]>;
        const fn = (viewer.scene as { sampleHeightMostDetailed: SampleHeightDetailed }).sampleHeightMostDetailed;
        const results = await fn([position]);
        const ms = performance.now() - t0;
        const r0 = (results?.[0] as { height?: number } | undefined);
        if (r0 && r0.height !== undefined && isPlausibleElevation(r0.height)) {
          return finish(r0.height, 'scene.sampleHeightMostDetailed', ms);
        }
        if (r0?.height !== undefined) reject(r0.height, 'scene.sampleHeightMostDetailed');
      } catch (err) {
        console.warn('[CesiumBridge] sampleHeightMostDetailed threw:', err);
      }
    }

    console.warn(`[CesiumBridge] terrain query: no source returned a plausible value at ${cacheKey}`);
    return null;
  }

  function viewerToGeodetic(vx: number, vy: number, vz: number): GeodesicPosition | null {
    const wx = vx + shift.x + rtcYup.x;
    const wy = vy + shift.y + rtcYup.y;
    const wz = vz + shift.z + rtcYup.z;
    const ifcX = wx;
    const ifcY = -wz;
    const ifcZ = wy;
    // Viewer coords (ifcX/Y/Z) are already in metres; only MapConversion values need scaling
    const easting = mapConversion.eastings * mapScale + hScale * (absc * ifcX - ordi * ifcY);
    const northing = mapConversion.northings * mapScale + hScale * (ordi * ifcX + absc * ifcY);
    const height = mapConversion.orthogonalHeight * mapScale + ifcZ;
    try {
      const [lon, lat] = proj4(projDef!, 'WGS84', [easting, northing]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      return { longitude: lon, latitude: lat, height };
    } catch {
      return null;
    }
  }

  return {
    modelOrigin,
    rotationAngle: rotAngle,
    syncCamera,
    queryTerrainHeight,
    viewerToGeodetic,
  };
}
