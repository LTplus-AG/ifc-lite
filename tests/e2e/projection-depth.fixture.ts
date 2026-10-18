/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Independent geometric visibility oracle for #6729, not a nudge formula. */
export const DEPTH_SIZE = 64;
export const PROBE_MIN = 28;
export const PROBE_MAX = 36;
export const ORBIT_ANGLES = [-60, -30, 0, 30, 60] as const;
export const DEPTH_RANGES = [5.201668158, 40, 1000] as const;
export const DEPTH_GAPS = [0.004, 0.03] as const;
export const EYE_DISTANCE = 2;
export const FOV = Math.PI / 4;
export const HALF_HEIGHT = EYE_DISTANCE * Math.tan(FOV / 2);
export type Projection = 'perspective' | 'orthographic';

export function orbitEye(angle: number): [number, number, number] {
  const theta = angle * Math.PI / 180;
  return [EYE_DISTANCE * Math.sin(theta), 0, EYE_DISTANCE * Math.cos(theta)];
}

/**
 * Two opaque squares, x/y in [-1,1], at z=0 and z=-gap. Every ray in the
 * central probe must hit BOTH squares, front first. Check the four corners
 * of the entire pixel region (not just centers), so unspecified hardware
 * MSAA sample positions cannot straddle a silhouette. Ray/plane coordinates
 * are affine or linear-fractional over this convex region, with one signed
 * denominator; corner inclusion therefore bounds its interior as well.
 *
 * Derive rays directly from eye/right/forward and the camera cone in f64;
 * do not invert the production matrix or copy its depth/nudge equations.
 */
export function geometricOracle(projection: Projection, angle: number, gap: number) {
  const theta = angle * Math.PI / 180;
  const sin = Math.sin(theta), cos = Math.cos(theta);
  const eye = orbitEye(angle);
  let minRayGap = Infinity;
  let minEdgeMargin = Infinity;
  for (const px of [PROBE_MIN, PROBE_MAX]) for (const py of [PROBE_MIN, PROBE_MAX]) {
    const u = 2 * px / DEPTH_SIZE - 1, v = 1 - 2 * py / DEPTH_SIZE;
    const dx = projection === 'perspective' ? -sin + u * Math.tan(FOV / 2) * cos : -sin;
    const dy = projection === 'perspective' ? v * Math.tan(FOV / 2) : 0;
    const dz = projection === 'perspective' ? -cos - u * Math.tan(FOV / 2) * sin : -cos;
    const ox = eye[0] + (projection === 'orthographic' ? u * HALF_HEIGHT * cos : 0);
    const oy = projection === 'orthographic' ? v * HALF_HEIGHT : eye[1];
    const oz = eye[2] - (projection === 'orthographic' ? u * HALF_HEIGHT * sin : 0);
    if (!(dz < 0)) throw new Error('Oracle ray does not face both squares');
    const front = -oz / dz, rear = (-gap - oz) / dz;
    if (!(front > 0 && rear > front)) throw new Error('Oracle did not establish front-first visibility');
    minRayGap = Math.min(minRayGap, (rear - front) * Math.hypot(dx, dy, dz));
    for (const t of [front, rear]) {
      minEdgeMargin = Math.min(minEdgeMargin, 1 - Math.abs(ox + t * dx), 1 - Math.abs(oy + t * dy));
    }
  }
  if (!(minEdgeMargin > 0.1)) throw new Error('Probe approaches a silhouette; cannot judge all MSAA samples');
  return { expected: 'front' as const, minRayGapMetres: minRayGap, minEdgeMarginMetres: minEdgeMargin };
}

export function squarePositions(z: number): Float32Array {
  return new Float32Array([-1, -1, z, 1, -1, z, -1, 1, z, 1, 1, z]);
}
