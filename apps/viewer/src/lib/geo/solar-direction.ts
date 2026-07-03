/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Map sun positions from the solar package's ENU frame into the WebGPU
 * viewer's world space, and shape the sun's photometric properties from its
 * altitude (warm low sun, twilight fade, night).
 *
 * Frame math: the inverse of the Helmert grid alignment (IfcMapConversion
 * XAxisAbscissa/Ordinate):
 *
 *   east  = absc·vx + ordi·vz
 *   north = ordi·vx − absc·vz
 *   up    = vy
 *
 * With (absc, ordi) normalized that matrix is orthonormal, so the inverse is
 * the transpose:
 *
 *   vx = absc·e + ordi·n
 *   vy = u
 *   vz = ordi·e − absc·n
 *
 * Sanity check at no rotation (absc=1, ordi=0): east→+X, up→+Y, north→−Z.
 *
 * NOTE: this is the GRID-only inverse; it does NOT include the meridian
 * convergence R(gamma) that `cesium-bridge.ts` (viewerToEnuRotation) folds into
 * the camera and model placement. So on high-convergence CRSs the WebGPU-viewer
 * sun azimuth is off true north by ~gamma. The Cesium sun (cesium-sun.ts) is
 * unaffected: it drives the sun through true-ENU (eastNorthUpToFixedFrame).
 * Threading gamma here is a tracked follow-up.
 */

import type { Enu } from '@ifc-lite/solar';

/**
 * Convert an ENU unit direction to viewer/world space (Y-up) using the
 * model's IfcMapConversion XAxisAbscissa/Ordinate rotation. Defaults match
 * IFC's "no rotation" convention (cos=1, sin=0).
 */
export function enuToViewerDirection(
  enu: Enu,
  xAxisAbscissa = 1,
  xAxisOrdinate = 0,
): [number, number, number] {
  // The IFC pair may be unnormalized direction cosines — normalize first.
  const len = Math.hypot(xAxisAbscissa, xAxisOrdinate) || 1;
  const a = xAxisAbscissa / len;
  const o = xAxisOrdinate / len;
  const vx = a * enu.e + o * enu.n;
  const vy = enu.u;
  const vz = o * enu.e - a * enu.n;
  const vlen = Math.hypot(vx, vy, vz) || 1;
  return [vx / vlen, vy / vlen, vz / vlen];
}

export interface SunLighting {
  /** Multiplier 0..1 on the preset's sun intensity. */
  intensityFactor: number;
  /** Sun light colour (warm at low altitudes, cool residual at night). */
  color: [number, number, number];
  /** Multiplier 0..~1 on the preset's hemisphere-ambient strength. */
  ambientFactor: number;
}

function smooth(x: number, lo: number, hi: number): number {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Photometric shaping of the sun by altitude (degrees above horizon):
 * full warm-white sun by ~15°, golden tint near the horizon, fading to
 * zero through civil twilight (0…−6°), with ambient dimming to a small
 * night floor so the model stays barely readable.
 */
export function sunLightingForAltitude(altitudeDeg: number): SunLighting {
  // Direct sun: none below the horizon, ramping in over the first ~10°.
  const dayness = smooth(altitudeDeg, -1, 10);
  // Twilight ambient: holds through −6° (civil twilight), then night floor.
  const twilight = smooth(altitudeDeg, -10, 2);

  // Warmth peaks at the horizon: white overhead → amber at 0°.
  const warmth = 1 - smooth(altitudeDeg, 2, 25);
  const color: [number, number, number] = [
    1.0,
    mix(0.98, 0.72, warmth),
    mix(0.95, 0.45, warmth),
  ];

  return {
    intensityFactor: dayness,
    color,
    // Night keeps 18% ambient so geometry silhouettes stay visible.
    ambientFactor: mix(0.18, 1.0, twilight),
  };
}
