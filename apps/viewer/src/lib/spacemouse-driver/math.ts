/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Small vector helpers and the pose <-> matrix conversions. Pure functions, no DOM, no SDK.
 *
 * Conventions (those of the 3Dconnexion navigation library): right-handed, Y up, a camera looks down its own -Z axis,
 * and matrices are 16-element, column-major arrays that map camera space to world space.
 */

export type V3 = [number, number, number];

export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);

/** Unit vector; the zero vector for (near-)zero input. */
export const norm = (a: V3): V3 => {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};

/** Camera -> world matrix, column-major: the columns are right, up, back (-forward) and the position. */
export function poseToMatrix(pos: V3, target: V3, up: V3): number[] {
  const f = norm(sub(target, pos));
  let r = norm(cross(f, up));
  if (len(r) < 1e-9) r = norm(cross(f, [0, 0, 1])); // looking straight along `up`
  const u = cross(r, f);
  return [r[0], r[1], r[2], 0, u[0], u[1], u[2], 0, -f[0], -f[1], -f[2], 0, pos[0], pos[1], pos[2], 1];
}

/**
 * Inverse of {@link poseToMatrix}.
 *
 * A matrix holds no target, so one is rebuilt: `dist` ahead of the new position along the new view direction. `dist` is
 * the distance to the old target measured along that direction, so a dolly keeps the same point in front of the camera.
 * When the camera has moved past the old target (or `dist` would be tiny), `fallback` is used instead.
 */
export function matrixToPose(m: ArrayLike<number>, oldTarget: V3, fallback: number): { pos: V3; target: V3; up: V3 } {
  const pos: V3 = [m[12], m[13], m[14]];
  const f = norm([-m[8], -m[9], -m[10]]);
  const up: V3 = [m[4], m[5], m[6]];
  let d = dot(sub(oldTarget, pos), f);
  if (!(d > fallback * 0.02)) d = fallback;
  return { pos, target: add(pos, mul(f, d)), up };
}
