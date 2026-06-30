/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Vec3 } from "./types.js";

export const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length3 = (a: Vec3): number => Math.sqrt(dot3(a, a));
export const normalize3 = (a: Vec3): Vec3 => {
  const n = length3(a);
  if (n === 0) return [0, 0, 0];
  return [a[0] / n, a[1] / n, a[2] / n];
};
export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** True when vectors are numerically equal within absolute tolerance. */
export const near3 = (a: Vec3, b: Vec3, eps = 1e-9): boolean =>
  Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps && Math.abs(a[2] - b[2]) <= eps;

/**
 * Anti-parallel within angular tolerance: `normalize(a) · normalize(b) < -cos(angleDeg)`.
 * Both vectors must be non-zero; a zero-length input returns false.
 */
export function antiParallel(a: Vec3, b: Vec3, angleDeg = 1): boolean {
  const la = length3(a);
  const lb = length3(b);
  if (la === 0 || lb === 0) return false;
  const cosA = Math.cos((angleDeg * Math.PI) / 180);
  const d = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
  return d <= -cosA;
}

/** Parallel (same direction) within angular tolerance. */
export function parallel(a: Vec3, b: Vec3, angleDeg = 1): boolean {
  const la = length3(a);
  const lb = length3(b);
  if (la === 0 || lb === 0) return false;
  const cosA = Math.cos((angleDeg * Math.PI) / 180);
  const d = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
  return d >= cosA;
}
