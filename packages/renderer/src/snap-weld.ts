/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Position welding and the one tolerance every stage of the snap geometry
 * cache measures with.
 *
 * Mesh positions arrive UNWELDED: `rust/geometry/src/mesh_weld.rs` keys vertex
 * identity on (exact f32 position bits, quantized normal, quantized UV), so the
 * two triangles meeting at a crease keep separate vertex indices on purpose
 * (flat shading needs the split normals). Anything that classifies mesh edges
 * by vertex INDEX therefore sees each physical edge twice, once per side, each
 * with a single adjacent triangle — every real edge looks like a boundary edge
 * and no coplanarity test can ever fire. Welding by POSITION first is what makes
 * "is this edge a real model edge or a triangulation diagonal?" answerable.
 */

import type { Vec3 } from './raycaster.js';

/**
 * Relative quantum of an f32 coordinate (2^-22).
 *
 * The same scale `packages/clash/src/analysis.ts` uses for `F32_ULP_SCALE` and
 * `rust/geometry/src/kernel/retriangulate_cleanup.rs` uses for its extent-scaled
 * epsilon. A fixed absolute epsilon is only valid near the origin, so the
 * tolerance has to grow with coordinate magnitude.
 */
const F32_ULP_SCALE = 1 / 4_194_304;

/**
 * Floor of the tolerance: 1/65536 m (15.3 um), the CSG kernel's own reconcile-grid
 * resolution (`rust/geometry/src/mesh.rs`), measured there as flat in triangle
 * count from 10-50 um and only touching real geometry at ~100 um.
 *
 * Deliberately NOT raised to a round 1e-4/1e-3: `rust/geometry/src/router/voids/
 * prism_cut/vertex_dedup.rs` records that welding at 1e-4 m collapsed real
 * geometry and took corpus defects from 76 to 90.
 */
const MIN_SNAP_TOLERANCE = 1 / 65536;

/**
 * The tolerance for one mesh, as a perpendicular DISTANCE (never an angle).
 *
 * Derived from the LOCAL coordinate magnitude: `MeshData.origin` is f64 and
 * shifts every vertex of the mesh identically, so it cancels in every
 * within-mesh difference and the f32 quantum lives at the local magnitude, not
 * the world one. (When `origin` is absent the positions themselves carry the
 * magnitude, which this same read picks up.)
 *
 * An angle tolerance would be the wrong primitive here: the direction noise of
 * a segment built from two f32 points scales with coordinate magnitude divided
 * by segment length, so any fixed angle is simultaneously too tight for short
 * segments far from the origin and too loose for long ones near it.
 */
export function snapToleranceFor(positions: ArrayLike<number>): number {
  let maxAbs = 0;
  for (let i = 0; i < positions.length; i++) {
    const a = Math.abs(positions[i]);
    if (isFinite(a) && a > maxAbs) maxAbs = a;
  }
  return Math.max(MIN_SNAP_TOLERANCE, maxAbs * F32_ULP_SCALE);
}

export interface WeldedVertices {
  /** Welded vertex id per source vertex; -1 where the source vertex was non-finite. */
  ids: Int32Array;
  /** World-space representative point per welded id. */
  points: Vec3[];
}

/**
 * Weld mesh positions to world-space points, merging anything within `tol`.
 *
 * Uses a uniform hash grid of cell size `2 * tol` and probes the (at most two
 * per axis) cells that can hold a point within `tol` — the pattern
 * `vertex_dedup.rs` uses in the kernel, and the reason this cannot silently drop
 * a pair straddling a cell boundary the way a plain `Math.floor` bucket does.
 *
 * Welding is a transitive-chaining merge (a-b and b-c within tol pulls a and c
 * together even if they are not), which is inherent to any tolerance weld; at
 * 15 um over one element it is not reachable by real geometry.
 */
export function weldVertices(
  positions: ArrayLike<number>,
  ox: number,
  oy: number,
  oz: number,
  tol: number
): WeldedVertices {
  const count = Math.floor(positions.length / 3);
  const ids = new Int32Array(count).fill(-1);
  const points: Vec3[] = [];
  const cell = 2 * tol;
  const buckets = new Map<string, number[]>();

  for (let i = 0; i < count; i++) {
    const x = positions[i * 3] + ox;
    const y = positions[i * 3 + 1] + oy;
    const z = positions[i * 3 + 2] + oz;
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;

    const xLo = Math.floor((x - tol) / cell);
    const xHi = Math.floor((x + tol) / cell);
    const yLo = Math.floor((y - tol) / cell);
    const yHi = Math.floor((y + tol) / cell);
    const zLo = Math.floor((z - tol) / cell);
    const zHi = Math.floor((z + tol) / cell);

    let hit = -1;
    for (let cx = xLo; cx <= xHi && hit < 0; cx++) {
      for (let cy = yLo; cy <= yHi && hit < 0; cy++) {
        for (let cz = zLo; cz <= zHi && hit < 0; cz++) {
          const bucket = buckets.get(`${cx}_${cy}_${cz}`);
          if (!bucket) continue;
          for (const id of bucket) {
            const p = points[id];
            const dx = p.x - x, dy = p.y - y, dz = p.z - z;
            if (dx * dx + dy * dy + dz * dz <= tol * tol) {
              hit = id;
              break;
            }
          }
        }
      }
    }

    if (hit >= 0) {
      ids[i] = hit;
      continue;
    }

    const id = points.length;
    points.push({ x, y, z });
    ids[i] = id;
    const key = `${Math.floor(x / cell)}_${Math.floor(y / cell)}_${Math.floor(z / cell)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(id);
    else buckets.set(key, [id]);
  }

  return { ids, points };
}
