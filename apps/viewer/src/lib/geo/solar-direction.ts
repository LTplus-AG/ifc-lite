/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Map sun positions from the solar package's ENU frame into the WebGPU
 * viewer's world space, and shape the sun's photometric properties from its
 * altitude (warm low sun, twilight fade, night).
 *
 * Frame math: the exact inverse of the bridge's viewer-to-ENU rotation
 * (`viewerToEnuRotation`): the Helmert grid alignment (IfcMapConversion
 * XAxisAbscissa/Ordinate) composed with the meridian convergence R(gamma).
 * That rotation is orthonormal, so the ENU-to-viewer inverse is its transpose:
 *
 *   vx = eastFromVx*e + northFromVx*n
 *   vy = u
 *   vz = eastFromVz*e + northFromVz*n
 *
 * Sanity check at no rotation (absc=1, ordi=0, gamma=0): east->+X, up->+Y,
 * north->-Z. Passing gamma keeps the WebGPU sun consistent with the model
 * placement and the Cesium sun (which drives the sun through true-ENU);
 * omitting it left the sun off true north by ~gamma on high-convergence CRSs.
 * See #1408.
 */

import type { Enu } from '@ifc-lite/solar';
import { viewerToEnuRotation } from './viewer-enu-rotation';

/** IFC's "no rotation" grid alignment: XAxisAbscissa = 1, XAxisOrdinate = 0. */
const IDENTITY_GRID: readonly [number, number] = [1, 0];

/** Sun straight overhead — the substitute when no direction can be derived. */
const ZENITH: readonly [number, number, number] = [0, 1, 0];

/**
 * Reduce an `IfcMapConversion` XAxisAbscissa/Ordinate pair to the unit
 * direction cosines the rotation needs.
 *
 * The pair carries a *direction*, so the only question that matters is whether
 * it has one — not how long it is. The previous `Math.hypot(a, o) || 1` asked
 * about length and got two answers wrong (#2495, the same blind spot #2489 /
 * #2494 closed inside the renderer):
 *
 *  - a non-finite component (a REAL the file spells `1E400`, or a NaN) has
 *    `hypot = Infinity`, which is truthy, so the divisor sailed through and
 *    `Infinity / Infinity` produced NaN direction cosines. Those flowed into
 *    `RenderOptions.environment.sunDirection` as `[NaN, u, NaN]`;
 *  - the all-zero pair took `|| 1` and divided by 1, producing cosines
 *    `(0, 0)` — a *zero* rotation, not the identity — which collapsed the sun
 *    to the zenith at every hour of the day.
 *
 * Both degrade to IFC's documented default pair instead, which is also the
 * default this function's own signature declares.
 */
function unitGridAlignment(
  xAxisAbscissa: number,
  xAxisOrdinate: number,
): [number, number] {
  const len = Math.hypot(xAxisAbscissa, xAxisOrdinate);
  if (!Number.isFinite(len) || len === 0) return [IDENTITY_GRID[0], IDENTITY_GRID[1]];
  return [xAxisAbscissa / len, xAxisOrdinate / len];
}

/**
 * Convert an ENU unit direction to viewer/world space (Y-up) using the inverse
 * of the model's viewer-to-ENU rotation: the IfcMapConversion XAxisAbscissa/
 * Ordinate grid alignment plus the meridian convergence `gamma`. Defaults match
 * IFC's "no rotation" convention (cos=1, sin=0) with zero convergence.
 *
 * Total by construction: every input that carries no usable direction degrades
 * to a documented substitute rather than to NaN. This is the last gate before
 * the value reaches `RenderOptions.environment`, and it is file-driven — the
 * abscissa/ordinate pair comes straight off `IfcMapConversion` (#2495).
 */
export function enuToViewerDirection(
  enu: Enu,
  xAxisAbscissa = 1,
  xAxisOrdinate = 0,
  gamma = 0,
): [number, number, number] {
  // The IFC pair may be unnormalized direction cosines; normalize so the
  // rotation is orthonormal and its transpose is the exact inverse.
  const [cosA, sinA] = unitGridAlignment(xAxisAbscissa, xAxisOrdinate);
  // A non-finite convergence would make cos/sin NaN and poison every
  // coefficient; no convergence is the honest fallback for "unknown".
  const conv = Number.isFinite(gamma) ? gamma : 0;
  const rot = viewerToEnuRotation(1, cosA, sinA, conv);
  // ENU -> viewer is the transpose of the viewer -> ENU rotation.
  const vx = rot.eastFromVx * enu.e + rot.northFromVx * enu.n;
  const vy = enu.u;
  const vz = rot.eastFromVz * enu.e + rot.northFromVz * enu.n;
  const vlen = Math.hypot(vx, vy, vz);
  // `vlen > 0` alone would wave `Infinity` through and hand back NaN; a
  // non-finite or zero-length ENU input (a NaN clock, a zero sun vector) has
  // no direction to report, so name one instead of manufacturing NaN.
  if (!Number.isFinite(vlen) || vlen === 0) return [ZENITH[0], ZENITH[1], ZENITH[2]];
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
