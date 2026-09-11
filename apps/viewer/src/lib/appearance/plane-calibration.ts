/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { AppearanceMapping } from './planner-types.js';

export interface PlaneCalibrationRequest {
  /** Raster pixel edges to stable native source coordinates; PDF pixelToPdf. */
  rasterToSource: [number, number, number, number, number, number];
  rasterSize: [number, number];
  /** Landmarks stay in native source space when the page is cropped or rotated. */
  sourcePoints: [[number, number], [number, number]];
  distanceMetres: number;
  /** IFC Z-up world metres at the first source landmark. */
  worldAnchor: [number, number, number];
  worldDirection: [number, number, number];
  planeNormal: [number, number, number];
}
export interface CalibratedPlane {
  mapping: Extract<AppearanceMapping, { kind: 'planar' }> & { frame: 'world' };
  /** Raster TL, TR, BR, BL in IFC world metres. */
  rasterCorners: Array<[number, number, number]>;
  metresPerSourceUnit: number;
}

/** Rust owns calibration math. This fixed-size calculation does not process IFC
 * geometry or pixels; expensive appearance planning still runs in its worker. */
export async function calibrateAppearancePlane(request: PlaneCalibrationRequest): Promise<CalibratedPlane> {
  const { default: init, IfcAPI } = await import('@ifc-lite/wasm');
  await init();
  const api = new IfcAPI();
  try {
    return JSON.parse(new TextDecoder().decode(api.calibrateAppearancePlane(JSON.stringify(request)))) as CalibratedPlane;
  } finally {
    api.free();
  }
}
