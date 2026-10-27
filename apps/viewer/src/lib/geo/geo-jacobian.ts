/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * First-order views of a GeoWarp (`geo-warp.ts`, `geo-lattice.ts`): its
 * linearisation at a point, for the Exact camera frame (`bridge-globe.ts`),
 * and the normal transform of that linear map, for the baked GLB's normals
 * (`globe-glb.ts`).
 */

/** A warp written to `out`; returning `false` means the point cannot be placed. */
export type WarpFn = (vx: number, vy: number, vz: number, out: number[]) => boolean | void;

/** The warp's value at a point and its Jacobian there (rows e, n, u; columns vx, vy, vz). */
export interface WarpLinearization {
  value: number[];
  jacobian: number[][];
}

/**
 * Central differences of `warp` at (vx, vy, vz), `step` viewer metres either
 * side. The warp is smooth over kilometres, so a 1 m step is exact to well
 * under a micrometre per metre. Null when any sample cannot be placed.
 */
export function linearizeWarp(warp: WarpFn, vx: number, vy: number, vz: number, step = 1): WarpLinearization | null {
  const value = [0, 0, 0];
  if (warp(vx, vy, vz, value) === false) return null;
  const jacobian = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const plus = [0, 0, 0], minus = [0, 0, 0];
  for (let col = 0; col < 3; col++) {
    const p = [vx, vy, vz], m = [vx, vy, vz];
    p[col] += step; m[col] -= step;
    if (warp(p[0], p[1], p[2], plus) === false || warp(m[0], m[1], m[2], minus) === false) return null;
    for (let row = 0; row < 3; row++) jacobian[row][col] = (plus[row] - minus[row]) / (2 * step);
  }
  return { value, jacobian };
}

/**
 * Normal transform for a linear map J: the cofactor matrix, det(J)·J^-T. It
 * maps surface normals correctly under non-uniform scale (Scale x FactorZ) and
 * needs no inversion; callers normalise the result.
 */
export function normalMatrix(j: number[][]): number[][] {
  const c = (r0: number, r1: number, c0: number, c1: number) => j[r0][c0] * j[r1][c1] - j[r0][c1] * j[r1][c0];
  return [
    [c(1, 2, 1, 2), -c(1, 2, 0, 2), c(1, 2, 0, 1)],
    [-c(0, 2, 1, 2), c(0, 2, 0, 2), -c(0, 2, 0, 1)],
    [c(0, 1, 1, 2), -c(0, 1, 0, 2), c(0, 1, 0, 1)],
  ];
}
