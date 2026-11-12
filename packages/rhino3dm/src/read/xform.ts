/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RhinoVector3 } from '../types.js';

/** 16 row-major numbers; the translation sits at indices 3, 7 and 11. */
export type Xform = number[];

/** How far the last row may be from 0 0 0 1: rounding noise, not a projection. */
const AFFINE_TOLERANCE = 1e-12;

/** Largest magnitude a transform entry may have: far beyond any model, far below f32 overflow. */
const LARGEST_ENTRY = 1e15;

/**
 * Finite, small enough that transformed f32 coordinates stay finite, not collapsing space to a
 * plane or a point, and affine: the last row is never applied, so it has to be 0 0 0 1
 * (to rounding noise).
 */
export function isUsable(m: Xform): boolean {
  return m.length === 16 && m.every(v => Math.abs(v) <= LARGEST_ENTRY) && determinant3(m) !== 0
    && Math.max(Math.abs(m[12]), Math.abs(m[13]), Math.abs(m[14]), Math.abs(m[15] - 1)) <= AFFINE_TOLERANCE;
}

/** a · b: apply `b` first, then `a`. */
export function multiply(a: Xform, b: Xform): Xform {
  const out = new Array<number>(16);
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += a[row * 4 + k] * b[k * 4 + col];
    out[row * 4 + col] = sum;
  }
  return out;
}

export function transformPoint(m: Xform, [x, y, z]: RhinoVector3): RhinoVector3 {
  return [
    m[0] * x + m[1] * y + m[2] * z + m[3],
    m[4] * x + m[5] * y + m[6] * z + m[7],
    m[8] * x + m[9] * y + m[10] * z + m[11],
  ];
}

/** True when the 3×3 part is not the identity, so vectors need rotating too. */
export function hasLinearPart(m: Xform): boolean {
  return m[0] !== 1 || m[5] !== 1 || m[10] !== 1
    || m[1] !== 0 || m[2] !== 0 || m[4] !== 0 || m[6] !== 0 || m[8] !== 0 || m[9] !== 0;
}

export function determinant3(m: Xform): number {
  return m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
}

/** Largest finite f32. */
const F32_MAX = 3.4028234663852886e38;

/** The largest |x|, |y| and |z| among xyz triples. */
export function reach(values: Float32Array): RhinoVector3 {
  const out: RhinoVector3 = [0, 0, 0];
  for (let i = 0; i < values.length; i++) out[i % 3] = Math.max(out[i % 3], Math.abs(values[i]));
  return out;
}

/**
 * True when the 3×3 part keeps every xyz triple within `extent` inside the f32 range. The bound
 * is per axis, so it costs the same for any vertex count; it can refuse a part whose own
 * vertices would just fit, by less than a factor of three at 1e38.
 */
export function keepsF32(m: Xform, [x, y, z]: RhinoVector3): boolean {
  const row = (at: number) => Math.abs(m[at]) * x + Math.abs(m[at + 1]) * y + Math.abs(m[at + 2]) * z <= F32_MAX;
  return row(0) && row(4) && row(8);
}

/** Apply the 3×3 part to every xyz triple, returning a new array. */
export function transformVectors(m: Xform, values: Float32Array): Float32Array {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 3) {
    const x = values[i], y = values[i + 1], z = values[i + 2];
    out[i] = m[0] * x + m[1] * y + m[2] * z;
    out[i + 1] = m[4] * x + m[5] * y + m[6] * z;
    out[i + 2] = m[8] * x + m[9] * y + m[10] * z;
  }
  return out;
}

/**
 * Transform unit normals by the inverse transpose of the 3×3 part and
 * renormalize. The cofactor matrix is det · inverse-transpose, so its sign is
 * corrected for a mirroring transform.
 */
export function transformNormals(m: Xform, normals: Float32Array): Float32Array {
  const sign = determinant3(m) < 0 ? -1 : 1;
  const c = [
    m[5] * m[10] - m[6] * m[9], m[6] * m[8] - m[4] * m[10], m[4] * m[9] - m[5] * m[8],
    m[2] * m[9] - m[1] * m[10], m[0] * m[10] - m[2] * m[8], m[1] * m[8] - m[0] * m[9],
    m[1] * m[6] - m[2] * m[5], m[2] * m[4] - m[0] * m[6], m[0] * m[5] - m[1] * m[4],
  ];
  const out = new Float32Array(normals.length);
  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i], y = normals[i + 1], z = normals[i + 2];
    const nx = sign * (c[0] * x + c[1] * y + c[2] * z);
    const ny = sign * (c[3] * x + c[4] * y + c[5] * z);
    const nz = sign * (c[6] * x + c[7] * y + c[8] * z);
    const length = Math.hypot(nx, ny, nz);
    if (length > 0) { out[i] = nx / length; out[i + 1] = ny / length; out[i + 2] = nz / length; }
  }
  return out;
}

/** Parse the exporter's `IFC::WorldFromModel`: 16 row-major numbers separated by spaces. */
export function parseXform(text: string): Xform | null {
  const values = text.trim().split(/\s+/).map(Number);
  return isUsable(values) ? values : null;
}
