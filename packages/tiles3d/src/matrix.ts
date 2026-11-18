/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Column-major 4x4 affine matrices as plain 16-number arrays (glTF / 3D Tiles layout). */
export type Mat4 = readonly number[];

export const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * glTF y-up to 3D Tiles z-up: rotate +90 degrees about x, (x, y, z) -> (x, -z, y).
 * 3D Tiles 1.0 and 1.1 both give this matrix (row-major in the spec text).
 */
export const Y_UP_TO_Z_UP: Mat4 = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];

export function multiply(a: Mat4, b: Mat4): number[] {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

export function translation(x: number, y: number, z: number): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

export function isIdentity(m: Mat4): boolean {
  for (let i = 0; i < 16; i++) if (m[i] !== IDENTITY[i]) return false;
  return true;
}

export function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

export function transformVector(m: Mat4, x: number, y: number, z: number): [number, number, number] {
  return [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
}

/** Largest column scale of the linear part (3D Tiles 1.1 scales geometricError by it). */
export function maxScale(m: Mat4): number {
  let best = 0;
  for (let c = 0; c < 3; c++) {
    best = Math.max(best, Math.hypot(m[c * 4], m[c * 4 + 1], m[c * 4 + 2]));
  }
  return best;
}

/**
 * Inverse-transpose of the upper 3x3, column-major 9 numbers, for transforming
 * normals. Returns null for a singular matrix.
 */
export function normalMatrix(m: Mat4): number[] | null {
  const a = m[0], b = m[4], c = m[8];
  const d = m[1], e = m[5], f = m[9];
  const g = m[2], h = m[6], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) return null;
  const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
  const G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d;
  // inverse = adj / det (adj = cofactor^T); inverse-transpose = cofactor / det.
  // Cofactor rows are (A B C), (D E F), (G H I); column-major column 0 = (A, D, G).
  return [A / det, D / det, G / det, B / det, E / det, H / det, C / det, F / det, I / det];
}

/** Local matrix of a glTF node: `matrix`, or T * R * S from its TRS properties. */
export function nodeMatrix(node: {
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}): number[] {
  if (node.matrix && node.matrix.length === 16) return node.matrix.slice();
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const xx = qx * qx, yy = qy * qy, zz = qz * qz;
  const xy = qx * qy, xz = qx * qz, yz = qy * qz;
  const wx = qw * qx, wy = qw * qy, wz = qw * qz;
  return [
    (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
    2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}
