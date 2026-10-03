/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Mesh-to-plan adapter; candidate occupancy policy is shared in create. */
import type { MeshData } from '@ifc-lite/geometry';
import type { Pt } from './room-layout-core.js';
type Tri = [Pt, Pt, Pt];

const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/**
 * The plan triangles of the IfcSpace meshes whose height range overlaps the
 * render-Y band `[lo, hi]`. `toPlan` maps a render-frame vertex to the plan
 * frame the rooms are in; `live` drops meshes of deleted spaces.
 */
export function spaceMeshTriangles(
  meshes: readonly MeshData[],
  band: { lo: number; hi: number },
  toPlan: (x: number, y: number, z: number) => Pt,
  live: (mesh: MeshData) => boolean,
): Tri[] {
  const out: Tri[] = [];
  for (const mesh of meshes) {
    if (mesh.ifcType !== 'IfcSpace' || !live(mesh)) continue;
    const pos = mesh.positions;
    const o = mesh.origin ?? [0, 0, 0];
    let ymin = Infinity, ymax = -Infinity;
    for (let i = 1; i < pos.length; i += 3) {
      const y = o[1] + pos[i];
      if (y < ymin) ymin = y;
      if (y > ymax) ymax = y;
    }
    if (!(ymax > band.lo && ymin < band.hi)) continue;
    const at = (v: number): Pt => toPlan(o[0] + pos[v * 3], o[1] + pos[v * 3 + 1], o[2] + pos[v * 3 + 2]);
    const idx = mesh.indices;
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const tri: Tri = [at(idx[t]), at(idx[t + 1]), at(idx[t + 2])];
      // Walls of the volume project to slivers; only its floor and ceiling cover plan area.
      if (Math.abs(cross(tri[0], tri[1], tri[2])) > 1e-9) out.push(tri);
    }
  }
  return out;
}
