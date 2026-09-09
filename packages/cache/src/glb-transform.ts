/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GLTFNode } from './glb-types.js';
/** Column-major 4x4 (glTF node-transform convention). */
export type Mat4 = number[];

export const MAT4_IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Column-major 4x4 multiply `a * b`. */
export function mat4Mul(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = s;
    }
  }
  return out;
}

/** A node's local transform: its `matrix` (column-major) or a translation matrix. */
export function nodeLocalMat4(nd: GLTFNode): Mat4 {
  const finite = (values: number[] | undefined, count: number) => values === undefined || (values.length === count && values.every(Number.isFinite));
  if (!finite(nd.matrix, 16) || !finite(nd.translation, 3) || !finite(nd.rotation, 4) || !finite(nd.scale, 3)) throw new Error('GLB: invalid node transform');
  if (nd.matrix) {
    if (nd.translation || nd.rotation || nd.scale || nd.matrix[3] !== 0 || nd.matrix[7] !== 0 || nd.matrix[11] !== 0 || nd.matrix[15] !== 1) throw new Error('GLB: invalid affine node matrix');
    return nd.matrix;
  }
  const [x, y, z, w] = nd.rotation ?? [0, 0, 0, 1];
  if (Math.abs(Math.hypot(x, y, z, w) - 1) > 1e-5) throw new Error('GLB: rotation quaternion must be normalized');
  const [sx, sy, sz] = nd.scale ?? [1, 1, 1];
  const t = nd.translation ?? [0, 0, 0];
  return [
    (1 - 2 * (y*y + z*z))*sx, 2*(x*y + z*w)*sx, 2*(x*z - y*w)*sx, 0,
    2*(x*y - z*w)*sy, (1 - 2*(x*x + z*z))*sy, 2*(y*z + x*w)*sy, 0,
    2*(x*z + y*w)*sz, 2*(y*z - x*w)*sz, (1 - 2*(x*x + y*y))*sz, 0,
    t[0], t[1], t[2], 1,
  ];
}

/** True when a 4x4's upper-left 3x3 is the identity (within epsilon) — i.e. the
 *  node carries pure translation, so vertices need no rotation/scale baking. */
export function linearIsIdentity(m: Mat4): boolean {
  const e = 1e-6;
  return (
    Math.abs(m[0] - 1) < e && Math.abs(m[1]) < e && Math.abs(m[2]) < e &&
    Math.abs(m[4]) < e && Math.abs(m[5] - 1) < e && Math.abs(m[6]) < e &&
    Math.abs(m[8]) < e && Math.abs(m[9]) < e && Math.abs(m[10] - 1) < e
  );
}


/** Inverse transpose for normals, including nonuniform scale. */
export function normalMatrix(m: Mat4): number[] {
  const a=m[0], b=m[4], c=m[8], d=m[1], e=m[5], f=m[9], g=m[2], h=m[6], i=m[10];
  const det=a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-15) throw new Error('GLB: singular node scale cannot preserve surface normals');
  return [(e*i-f*h)/det,(c*h-b*i)/det,(b*f-c*e)/det,(f*g-d*i)/det,(a*i-c*g)/det,(c*d-a*f)/det,(d*h-e*g)/det,(b*g-a*h)/det,(a*e-b*d)/det];
}
export function mirrored(m: Mat4): boolean {
  return m[0]*(m[5]*m[10]-m[9]*m[6])-m[4]*(m[1]*m[10]-m[9]*m[2])+m[8]*(m[1]*m[6]-m[5]*m[2]) < 0;
}
