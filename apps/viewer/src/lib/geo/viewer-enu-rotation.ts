/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewer-to-ENU rotation shared by everything that has to agree on which
 * way is north on the basemap: the Cesium camera frame, the 3D model
 * placement, and the WebGPU-viewer sun. Kept as a zero-dependency leaf so both
 * `cesium-bridge.ts` (heavyweight, pulls proj4/terrain/...) and the lightweight
 * `solar-direction.ts` can reuse it without coupling. See #1408 / #1557.
 */

/**
 * In-plane coefficients of the viewer-to-ENU rotation. `vy` maps straight to
 * ENU up, so only the East/North rows depend on (vx, vz).
 */
export interface ViewerToEnuRotation {
  eastFromVx: number;
  eastFromVz: number;
  northFromVx: number;
  northFromVz: number;
}

/**
 * Build the viewer-to-ENU rotation: the Helmert grid alignment (IfcMapConversion
 * XAxisAbscissa/Ordinate, scaled by hScale) composed with the meridian
 * convergence R(gamma) that turns grid axes into the true-north ENU frame
 * Cesium uses (east = R(gamma) applied to the Helmert grid vectors).
 *
 * SINGLE SOURCE OF TRUTH: the camera frame (`createCesiumBridge`), the model
 * placement (`buildModelMatrix`, via `bridge.viewerRotation`) and the WebGPU
 * sun (`enuToViewerDirection`, which transposes it) all derive their rotation
 * from this one function, so they can never disagree on north. See #1408.
 */
export function viewerToEnuRotation(
  hScale: number,
  absc: number,
  ordi: number,
  gamma: number,
): ViewerToEnuRotation {
  const cg = Math.cos(gamma);
  const sg = Math.sin(gamma);
  const ce = hScale * absc;
  const co = hScale * ordi;
  return {
    eastFromVx: cg * ce - sg * co,
    eastFromVz: cg * co + sg * ce,
    northFromVx: sg * ce + cg * co,
    northFromVz: sg * co - cg * ce,
  };
}
