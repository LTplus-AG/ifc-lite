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
import { computeModelCenterInIfcMeters, resolveProjection } from './reproject';
import {
  resolveTerrainElevationDetailed,
  type ResolveTerrainElevationOptions,
  type TerrainElevationSample,
} from './terrain-elevation';
import { getEffectiveHorizontalScale } from './geo-scale';

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
    options?: ResolveTerrainElevationOptions,
  ): Promise<TerrainElevationSample | null>;

  viewerToGeodetic(vx: number, vy: number, vz: number): GeodesicPosition | null;
}

export interface CesiumModelOriginInfo extends GeodesicPosition {
  longitude: number;
  latitude: number;
  height: number;
  ifcOriginHeight: number;
  easting: number;
  northing: number;
  horizontalScale: number;
}

export async function computeCesiumModelOrigin(
  mapConversion: MapConversion,
  projectedCRS: ProjectedCRS,
  coordinateInfo?: CoordinateInfo,
  lengthUnitScale = 1,
  placementHeightOverride?: number,
): Promise<CesiumModelOriginInfo | null> {
  const projDef = await resolveProjection(projectedCRS);
  if (!projDef) return null;

  const absc = mapConversion.xAxisAbscissa ?? 1.0;
  const ordi = mapConversion.xAxisOrdinate ?? 0.0;
  const center = computeModelCenterInIfcMeters(coordinateInfo);
  const mapScale = projectedCRS.mapUnitScale ?? lengthUnitScale;
  const horizontalScale = getEffectiveHorizontalScale(
    mapConversion.scale,
    mapScale,
    lengthUnitScale,
  );
  const easting = mapConversion.eastings * mapScale
    + horizontalScale * (absc * center.ifcX - ordi * center.ifcY);
  const northing = mapConversion.northings * mapScale
    + horizontalScale * (ordi * center.ifcX + absc * center.ifcY);
  const ifcOriginHeight = mapConversion.orthogonalHeight * mapScale + center.ifcZ;
  const height = placementHeightOverride ?? ifcOriginHeight;

  try {
    const [lon, lat] = proj4(projDef, 'WGS84', [easting, northing]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return {
      longitude: lon,
      latitude: lat,
      height,
      ifcOriginHeight,
      easting,
      northing,
      horizontalScale,
    };
  } catch {
    return null;
  }
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

  const bounds = coordinateInfo?.originalBounds;
  const modelVX = bounds ? (bounds.min.x + bounds.max.x) / 2 : 0;
  const modelVY = bounds ? (bounds.min.y + bounds.max.y) / 2 : 0;
  const modelVZ = bounds ? (bounds.min.z + bounds.max.z) / 2 : 0;

  const shift = coordinateInfo?.originShift ?? { x: 0, y: 0, z: 0 };
  const rtc = coordinateInfo?.wasmRtcOffset;
  const rtcYup = rtc
    ? { x: rtc.x, y: rtc.z, z: -rtc.y }
    : { x: 0, y: 0, z: 0 };
  const origin = await computeCesiumModelOrigin(
    mapConversion,
    projectedCRS,
    coordinateInfo,
    lengthUnitScale,
    placementHeightOverride,
  );
  if (!origin) return null;
  const modelOrigin: GeodesicPosition = {
    longitude: origin.longitude,
    latitude: origin.latitude,
    height: origin.height,
  };
  const hScale = origin.horizontalScale;
  const mapScale = projectedCRS.mapUnitScale ?? lengthUnitScale;
  const oHeight = origin.height;
  const originLon = origin.longitude;
  const originLat = origin.latitude;

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

  /**
   * Sync the Cesium camera from the IFC viewer's camera state.
   *
   * Best practice for an externally-driven camera: keep Cesium's screen-space
   * controller fully disabled (Effect 1) and write camera state directly in
   * ECEF coordinates. We previously called `lookAtTransform` so we could set
   * position/direction/up in viewer-space, but that locks Cesium's reference
   * frame and constrains certain operations (rotate, tilt, zoom) to the local
   * frame — which manifested as "can't orbit upward, camera stuck to terrain"
   * even though our overlay is supposed to be input-passive.
   *
   * Instead, transform the IFC camera's viewer-space pose to ECEF here and
   * write it. Cesium handles RTC for primitives (Models, 3D Tilesets, terrain)
   * internally so we don't need a local-frame trick for shader precision.
   */
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

    // Make sure no prior lookAtTransform is still in effect — if the
    // overlay was activated from a previous bridge that called it, the
    // camera could still be locked to that frame.
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);

    // Transform IFC viewer-space pose → ECEF.
    // Position uses full matrix (rotation + translation).
    const posECEF = Cesium.Matrix4.multiplyByPoint(
      viewerToEcefMatrix,
      new Cesium.Cartesian3(camPos.x, camPos.y, camPos.z),
      new Cesium.Cartesian3(),
    );
    const targetECEF = Cesium.Matrix4.multiplyByPoint(
      viewerToEcefMatrix,
      new Cesium.Cartesian3(camTarget.x, camTarget.y, camTarget.z),
      new Cesium.Cartesian3(),
    );

    // Direction = (target − position) normalised, in ECEF.
    const dirECEF = Cesium.Cartesian3.subtract(targetECEF, posECEF, new Cesium.Cartesian3());
    const dirLen = Cesium.Cartesian3.magnitude(dirECEF);
    if (dirLen < 1e-8) return; // degenerate: target ≡ position
    Cesium.Cartesian3.normalize(dirECEF, dirECEF);

    // Up: rotate the viewer-space up vector to ECEF (rotation only, no
    // translation — multiplyByPointAsVector ignores the translation column).
    const upECEF = Cesium.Matrix4.multiplyByPointAsVector(
      viewerToEcefMatrix,
      new Cesium.Cartesian3(camUp.x, camUp.y, camUp.z),
      new Cesium.Cartesian3(),
    );
    Cesium.Cartesian3.normalize(upECEF, upECEF);

    // Right = direction × up — recompute fresh each frame so the orthonormal
    // basis stays clean. (The "drift" the previous implementation worried
    // about only matters if we read Cesium's camera state back into our
    // calculations; we always recompute from the IFC source of truth.)
    const rightECEF = Cesium.Cartesian3.cross(dirECEF, upECEF, new Cesium.Cartesian3());
    Cesium.Cartesian3.normalize(rightECEF, rightECEF);

    viewer.camera.position = posECEF;
    viewer.camera.direction = dirECEF;
    viewer.camera.up = upECEF;
    viewer.camera.right = rightECEF;

    // Sync FOV — IFC renderer reports VERTICAL FOV; Cesium's
    // PerspectiveFrustum.fov is HORIZONTAL when aspect > 1 (landscape).
    // Convert vertical → horizontal so the projection matches.
    const frustum = viewer.camera.frustum;
    if (frustum instanceof Cesium.PerspectiveFrustum) {
      const aspect = frustum.aspectRatio || (viewer.canvas.width / viewer.canvas.height);
      if (aspect > 1) {
        frustum.fov = 2 * Math.atan(aspect * Math.tan(fov / 2));
      } else {
        frustum.fov = fov;
      }
    }

    viewer.scene.requestRender();
  }

  /** Resolve terrain elevation at the model origin via the shared pipeline. */
  function queryTerrainHeight(
    Cesium: typeof import('cesium'),
    viewer: InstanceType<typeof import('cesium').Viewer>,
    options: ResolveTerrainElevationOptions = {},
  ): Promise<TerrainElevationSample | null> {
    return resolveTerrainElevationDetailed(Cesium, viewer, originLat, originLon, options);
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
