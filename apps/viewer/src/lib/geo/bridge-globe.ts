/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The bridge's per-vertex half: the GeoWarp mapping for a projected
 * georeference, the Anchor/Exact decision, and the Exact camera frame.
 * Kept out of `cesium-bridge.ts`, which already carries the anchor frame.
 */

import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { totalYupOffset } from '@ifc-lite/geometry/world-frame';
import type { CesiumModelOriginInfo, GeodesicPosition } from './cesium-bridge';
import { createGeoMapping, type GeoMapping } from './geo-warp';
import { linearizeWarp } from './geo-jacobian';
import { planGlobePlacement, type GlobePlacementMode, type GlobePlacementPlan } from './globe-placement';
import { buildLinearizedViewerToEcefMatrix } from './cesium-viewer-frame';
import { shouldApplyGeoidUndulation } from './cesium-placement';
import { egm96Undulation } from './egm96-undulation';

export interface BridgeGlobe {
  mapping: GeoMapping;
  plan: GlobePlacementPlan;
}

/**
 * Projected CRSs only. `mapConversion` is the AUTHORED conversion, the one
 * `computeCesiumModelOrigin` was given (`GeoMappingInput`); null when the
 * mapping cannot be built, which leaves the bridge on its anchor.
 */
export function createBridgeGlobe(args: {
  projDef: string;
  mapConversion: MapConversion;
  projectedCRS: Pick<ProjectedCRS, 'mapUnitScale'>;
  lengthUnitScale: number;
  origin: CesiumModelOriginInfo;
  coordinateInfo: CoordinateInfo | undefined;
  heightsAreEllipsoidal: boolean | undefined;
  requested: GlobePlacementMode;
}): BridgeGlobe | null {
  const { origin, projDef, coordinateInfo: info } = args;
  // The same geoid decision `computeCesiumModelOrigin` made for the anchor.
  const geoid = shouldApplyGeoidUndulation(args.heightsAreEllipsoidal) ? egm96Undulation : () => 0;
  const mapping = createGeoMapping({
    mapConversion: args.mapConversion,
    projectedCRS: args.projectedCRS,
    projDef,
    coordinateInfo: info,
    lengthUnitScale: args.lengthUnitScale,
    origin,
    geoid,
  });
  if (!mapping) return null;
  const plan = planGlobePlacement(args.requested, mapping, info?.shiftedBounds, {
    projDef,
    gridCoordinates: origin.gridSource !== null,
    geoid,
    anchorMap: origin,
    mappingKey: [projDef, args.mapConversion, args.projectedCRS.mapUnitScale, args.lengthUnitScale, origin,
      totalYupOffset(info), geoid === egm96Undulation],
  });
  return { mapping, plan };
}

/** Re-linearise once the camera target has moved this far (viewer metres). */
const EXACT_CAMERA_REANCHOR_M = 250;

/**
 * The Exact camera frame: the warp linearised at the camera target, rebuilt
 * when the target moves more than {@link EXACT_CAMERA_REANCHOR_M}. Between
 * rebuilds the matrix is fixed, so the camera frame does not change on every
 * small orbit; at a rebuild, the frame near the target moves by d²/(2R), 5 mm
 * at 250 m, which nobody sees.
 */
export function createExactCameraFrame(mapping: GeoMapping, origin: GeodesicPosition) {
  let cached: { at: { x: number; y: number; z: number }; clampUp: number; matrix: import('cesium').Matrix4 } | null = null;
  return (Cesium: typeof import('cesium'), target: { x: number; y: number; z: number }, clampUp: number) => {
    if (cached && cached.clampUp === clampUp
      && Math.hypot(target.x - cached.at.x, target.y - cached.at.y, target.z - cached.at.z) <= EXACT_CAMERA_REANCHOR_M) {
      return cached.matrix;
    }
    const lin = linearizeWarp(mapping.toEnu, target.x, target.y, target.z);
    if (!lin) return cached?.matrix ?? null;
    const at = { ...target };
    const matrix = buildLinearizedViewerToEcefMatrix(Cesium, { ...origin, height: origin.height + clampUp }, lin, at);
    cached = { at, clampUp, matrix };
    return matrix;
  };
}
