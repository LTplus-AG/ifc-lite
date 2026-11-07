/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8567: deterministic camera poses, never geometry/scale calibration.
// Input center/radius MUST come from the integrated viewer after placement.
// Coordinates are viewer Y-up. Radius describes visual framing, not metres.
export const DEMO_DURATION_SECONDS = 30;
const keys = [
  // seconds, azimuth degrees, elevation degrees, distance/radius
  [0, 0, 22, 2.8], [3, 0, 22, 2.8],
  [15, 110, 18, 2.4], [22, 135, 12, 1.65],
  [27, 155, 22, 2.8], [30, 155, 22, 2.8],
];
export function demoCameraAt(seconds, { center, radius, initialAzimuth = 0 }) {
  if (!Array.isArray(center) || center.length !== 3 || !center.every(Number.isFinite) ||
      !Number.isFinite(radius) || radius <= 0 || !Number.isFinite(seconds) || !Number.isFinite(initialAzimuth)) {
    throw new Error('finite viewer center, positive radius, time and azimuth required');
  }
  const time = Math.min(DEMO_DURATION_SECONDS, Math.max(0, seconds));
  const next = keys.findIndex(key => key[0] >= time);
  const a = keys[Math.max(0, next - 1)], b = keys[next];
  const t = a === b ? 0 : (time - a[0]) / (b[0] - a[0]);
  const eased = t * t * (3 - 2 * t);
  const mix = i => a[i] + (b[i] - a[i]) * eased;
  const azimuth = (initialAzimuth + mix(1)) * Math.PI / 180;
  const elevation = mix(2) * Math.PI / 180;
  const distance = radius * mix(3);
  return {
    position: [center[0] + distance * Math.cos(elevation) * Math.sin(azimuth),
      center[1] + distance * Math.sin(elevation),
      center[2] + distance * Math.cos(elevation) * Math.cos(azimuth)],
    target: [...center], fovDegrees: 55,
  };
}
