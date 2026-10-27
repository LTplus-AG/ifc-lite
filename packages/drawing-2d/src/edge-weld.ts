/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Vertex welding and face-normal helpers for `EdgeExtractor` (issue #8161).
 */

import type { Vec3 } from './types.js';
import { vec3 } from './math.js';

/**
 * Vertex weld tolerance as a fraction of the mesh's largest LOCAL coordinate
 * magnitude (issue #8161): 2⁻²², i.e. two to four f32 ULPs at that
 * magnitude, the same scale factor `SectionCutter` applies to its plane-side
 * epsilon (#2622).
 *
 * Adjacency is matched by position, not by buffer index, because the geometry
 * pipeline emits flat-shaded solids with their vertices repeated per face; by
 * index, no two triangles of such a mesh share an edge. Duplicates of one
 * corner are bit-identical when they were rounded from the same f64 point, but
 * can differ in the last bits when they reached f32 along different paths, and
 * that noise scales with the magnitude of the stored values; so must the
 * tolerance:
 *  - `positions` are metres (unit scale applied in the Rust router) in the
 *    element's local frame; `origin` is a pure translation added in f64 that
 *    cannot move two duplicates apart, so it is left out of the magnitude, as
 *    in `SectionCutter`. A mesh without `origin` holds absolute world (or
 *    RTC) coordinates, and the tolerance grows with them: at 4e5 m one ULP is
 *    3 cm and a fixed sub-millimetre epsilon would weld nothing.
 *  - At small magnitudes the tolerance shrinks with the coordinates, so a
 *    50 µm detail near its frame's origin keeps its distinct corners, where
 *    any fixed building-scale epsilon would collapse it.
 * The cost: two genuinely distinct vertices closer than that (2.4 µm in a
 * mesh spanning ±10 m) are merged. The weld is greedy in buffer order, so a
 * chain of vertices each within tolerance of the next is not transitively
 * collapsed beyond the first representative's reach.
 */
const WELD_RELATIVE_TOLERANCE = 2 ** -22;

/**
 * Weld coincident vertices (issue #8161). Returns, for every vertex, the
 * index of its weld representative: the FIRST vertex in buffer order within
 * `tolerance` (per axis) of it, so output coordinates are deterministic and
 * are always a real vertex position, never an average.
 *
 * Vertices are bucketed on a grid of cell size `tolerance`. Two positions
 * within tolerance can straddle a cell boundary, so every vertex searches its
 * own cell and the 26 neighbouring cells, which together cover every position
 * within tolerance of it, and takes the lowest index found. Cells are
 * keyed by an integer hash and every candidate is distance-checked, so a
 * hash collision costs a comparison, never a wrong weld. Linear in the
 * vertex count (27 bucket lookups per vertex).
 */
export function weldVertices(positions: Float32Array): { rep: Uint32Array; tolerance: number } {
  const vertexCount = Math.floor(positions.length / 3);
  let maxAbs = 0;
  for (let i = 0; i < vertexCount * 3; i++) {
    const a = Math.abs(positions[i]);
    if (a > maxAbs) maxAbs = a;
  }
  const tolerance = maxAbs * WELD_RELATIVE_TOLERANCE;
  // With a zero tolerance (all-zero positions) only exact matches weld; any
  // positive cell size keeps those in one cell.
  const cell = tolerance > 0 ? tolerance : 1;

  const rep = new Uint32Array(vertexCount);
  const buckets = new Map<number, number[]>();
  const hash = (ix: number, iy: number, iz: number): number =>
    Math.imul(ix | 0, 73856093) ^ Math.imul(iy | 0, 19349663) ^ Math.imul(iz | 0, 83492791);
  // The lowest-index representative within tolerance, across the vertex's own
  // cell and all 26 neighbours. Stopping at the first hit would let a later
  // representative in the vertex's own cell win over an earlier one next door.
  const findFirst = (ix: number, iy: number, iz: number, x: number, y: number, z: number): number => {
    let best = -1;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = buckets.get(hash(ix + dx, iy + dy, iz + dz));
          if (!bucket) continue;
          for (const r of bucket) {
            if (best >= 0 && r >= best) break; // buckets are ascending
            const b = r * 3;
            if (
              Math.abs(positions[b] - x) <= tolerance &&
              Math.abs(positions[b + 1] - y) <= tolerance &&
              Math.abs(positions[b + 2] - z) <= tolerance
            ) {
              best = r;
              break;
            }
          }
        }
      }
    }
    return best;
  };

  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const ix = Math.floor(x / cell);
    const iy = Math.floor(y / cell);
    const iz = Math.floor(z / cell);

    const found = findFirst(ix, iy, iz, x, y, z);

    if (found >= 0) {
      rep[i] = found;
    } else {
      rep[i] = i;
      const key = hash(ix, iy, iz);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(i);
      else buckets.set(key, [i]);
    }
  }
  return { rep, tolerance };
}

/**
 * Unit normal of triangle (a, b, c) from LOCAL positions, or `null` when the
 * triangle is degenerate: its height over the longest side is within the
 * weld tolerance (collinear as far as the weld can tell), or exactly zero.
 */
export function computeFaceNormal(
  positions: Float32Array,
  a: number,
  b: number,
  c: number,
  tolerance: number,
): Vec3 | null {
  const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
  const e1x = positions[b * 3] - ax, e1y = positions[b * 3 + 1] - ay, e1z = positions[b * 3 + 2] - az;
  const e2x = positions[c * 3] - ax, e2y = positions[c * 3 + 1] - ay, e2z = positions[c * 3 + 2] - az;
  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len === 0) return null;

  const e3x = e2x - e1x, e3y = e2y - e1y, e3z = e2z - e1z;
  const longest = Math.sqrt(
    Math.max(e1x * e1x + e1y * e1y + e1z * e1z, e2x * e2x + e2y * e2y + e2z * e2z, e3x * e3x + e3y * e3y + e3z * e3z),
  );
  // |n| = 2 · area = longest · height.
  if (len <= longest * tolerance) return null;

  return vec3(nx / len, ny / len, nz / len);
}
