/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The per-vertex half of GeoWarp: sample a `GeoMapping` on a lattice over the
 * model's box and interpolate, so a whole model is warped at a few
 * nanoseconds per vertex instead of one proj4 call (0.4-0.6 µs) each.
 *
 * The warp is linear in viewer height at fixed viewer x/z: a point's lat/lon
 * depends on its map E/N only, h is H plus a function of lat/lon, and ECEF is
 * linear in h at fixed lat/lon. Two height levels are therefore exact
 * vertically. Horizontally the bilinear residual of the Earth's curvature
 * r²/(2R) is c²/(8R) per axis for cell size c, so c²/(4R) at a cell centre:
 * 0.4 mm at 100 m cells.
 */

import type { GeoMapping } from './geo-warp';

/** Axis-aligned viewer-space box (Y up). */
export interface ViewerBounds {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

export interface LatticeWarp {
  /** Interpolated anchor-ENU position (e, n, u) of a viewer point, written to `out`. */
  warp(vx: number, vy: number, vz: number, out: Float64Array | number[]): void;
  /** Lattice spacing actually used (metres of viewer x/z). */
  readonly cellSize: number;
  readonly nodeCount: number;
}

/** Nodes above this make the cell grow: 1e6 proj4 calls is about half a second. */
const MAX_LATTICE_NODES = 1_000_000;
const DEFAULT_LATTICE_CELL_M = 100;

/**
 * Sample `mapping` on a lattice over `bounds` (horizontal cells of `cellSize`,
 * grown by 1.5x until the node budget holds; two height levels) and return
 * the interpolating warp. Points outside the box extrapolate from the edge
 * cell, which stays exact vertically and degrades horizontally like c·d/R.
 *
 * Returns null when the box is not finite or any node cannot be placed (out
 * of the projection's domain or a WKT's declared extent): a partly placed
 * model is worse than the anchor placement the caller falls back to.
 */
export function createLatticeWarp(
  mapping: GeoMapping,
  bounds: ViewerBounds,
  cellSize = DEFAULT_LATTICE_CELL_M,
): LatticeWarp | null {
  const { min, max } = bounds;
  if (![min.x, min.y, min.z, max.x, max.y, max.z, cellSize].every(Number.isFinite) || !(cellSize > 0)) return null;
  const x0 = min.x, z0 = min.z;
  const w = Math.max(max.x - x0, 0), d = Math.max(max.z - z0, 0);
  let cell = cellSize;
  while ((Math.ceil(w / cell) + 1) * (Math.ceil(d / cell) + 1) * 2 > MAX_LATTICE_NODES) cell *= 1.5;
  const nx = Math.ceil(w / cell) + 1;
  const nz = Math.ceil(d / cell) + 1;
  // Two levels at least a metre apart, so the vertical slope is well conditioned.
  const y0 = min.y;
  const dy = Math.max(max.y - y0, 1);
  // Node (i, j, level) at ((j·nx + i)·2 + level)·3.
  const nodes = new Float64Array(nx * nz * 6);
  const tmp = [0, 0, 0];
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      for (let l = 0; l < 2; l++) {
        if (!mapping.toEnu(x0 + i * cell, y0 + l * dy, z0 + j * cell, tmp)) return null;
        const o = ((j * nx + i) * 2 + l) * 3;
        nodes[o] = tmp[0]; nodes[o + 1] = tmp[1]; nodes[o + 2] = tmp[2];
      }
    }
  }
  const imax = Math.max(nx - 2, 0);
  const jmax = Math.max(nz - 2, 0);
  const stepI = nx > 1 ? 6 : 0;
  const stepJ = nz > 1 ? nx * 6 : 0;

  function warp(vx: number, vy: number, vz: number, out: Float64Array | number[]): void {
    const gx = (vx - x0) / cell;
    const gz = (vz - z0) / cell;
    const i = Math.min(Math.max(Math.floor(gx), 0), imax);
    const j = Math.min(Math.max(Math.floor(gz), 0), jmax);
    const fx = nx > 1 ? gx - i : 0;
    const fz = nz > 1 ? gz - j : 0;
    const fy = (vy - y0) / dy;
    const b00 = (j * nx + i) * 6;
    const b10 = b00 + stepI;
    const b01 = b00 + stepJ;
    const b11 = b01 + stepI;
    const w00 = (1 - fx) * (1 - fz), w10 = fx * (1 - fz), w01 = (1 - fx) * fz, w11 = fx * fz;
    for (let c = 0; c < 3; c++) {
      const lo = w00 * nodes[b00 + c] + w10 * nodes[b10 + c] + w01 * nodes[b01 + c] + w11 * nodes[b11 + c];
      const hi = w00 * nodes[b00 + 3 + c] + w10 * nodes[b10 + 3 + c] + w01 * nodes[b01 + 3 + c] + w11 * nodes[b11 + 3 + c];
      out[c] = lo + (hi - lo) * fy;
    }
  }

  return { warp, cellSize: cell, nodeCount: nx * nz * 2 };
}
