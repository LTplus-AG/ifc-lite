/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The bridge's per-vertex half: the GeoWarp mapping for a projected
 * georeference, the Anchor/Exact decision, and the Exact camera frame.
 * Kept out of `cesium-bridge.ts`, which already carries the anchor frame.
 */

import type { MapConversion } from '@ifc-lite/parser';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { CesiumModelOriginInfo, GeodesicPosition } from './cesium-bridge';
import { createGeoMapping, linearizeWarp, type GeoMapping } from './geo-warp';
import { planGlobePlacement, type GlobePlacementMode, type GlobePlacementPlan } from './globe-placement';
import { buildLinearizedViewerToEcefMatrix } from './cesium-viewer-frame';
import { shouldApplyGeoidUndulation } from './cesium-placement';
import { egm96Undulation } from './egm96-undulation';

export interface BridgeGlobe {
  mapping: GeoMapping;
  plan: GlobePlacementPlan;
}

/** `conversion` is the effective one (map-absolute neutralised); projected CRSs only. */
export function createBridgeGlobe(args: {
  projDef: string;
  conversion: MapConversion;
  mapScale: number;
  axis: { a: number; b: number };
  origin: CesiumModelOriginInfo;
  coordinateInfo: CoordinateInfo | undefined;
  heightsAreEllipsoidal: boolean | undefined;
  requested: GlobePlacementMode;
}): BridgeGlobe {
  const { origin, conversion, mapScale } = args;
  const geoid = shouldApplyGeoidUndulation(args.heightsAreEllipsoidal) ? egm96Undulation : () => 0;
  const gridCoordinates = origin.gridSource !== null;
  const mapping = createGeoMapping({
    projDef: args.projDef,
    eastingsM: conversion.eastings * mapScale,
    northingsM: conversion.northings * mapScale,
    orthogonalHeightM: conversion.orthogonalHeight * mapScale,
    axis: args.axis,
    scales: { x: origin.scaleX, y: origin.scaleY, z: origin.scaleZ },
    coordinateInfo: args.coordinateInfo,
    anchor: {
      longitude: origin.longitude,
      latitude: origin.latitude,
      height: origin.height,
      ifcOriginHeight: origin.ifcOriginHeight,
      geoidUndulation: origin.geoidUndulation,
      easting: origin.easting,
      northing: origin.northing,
    },
    combinedScaleFactor: origin.combinedScaleFactor,
    gridCoordinates,
    geoid,
  });
  const info = args.coordinateInfo;
  const plan = planGlobePlacement(args.requested, mapping, info?.shiftedBounds, {
    projDef: args.projDef,
    gridCoordinates,
    geoid,
    mappingKey: [args.projDef, conversion, mapScale, origin, info?.originShift, info?.wasmRtcOffset, geoid === egm96Undulation],
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
