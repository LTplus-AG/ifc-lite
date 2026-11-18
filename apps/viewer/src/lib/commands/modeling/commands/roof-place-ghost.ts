/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { planFootprintRoof, roofPlaneHeightAt } from '@ifc-lite/create';
import type { MeshData } from '@ifc-lite/geometry';
import type { Vec2 } from '@/lib/snap/types';
import type { Workplane } from '../types';
import { prismGhostMesh } from '../ghost-shapes';
import { roofEdgeSlopes, type RoofGesture } from './roof-place-params';
/** Preview uses the same planes as the IFC builder, including concave footprints and overhangs. */
export function roofGhostMeshes(plane: Workplane, outline: readonly Vec2[], roof: RoofGesture, thickness: number, firstId: number): MeshData[] {
  if (outline.length < 3) return [];
  try {
    const plan = planFootprintRoof(outline.map(p => [p[0], p[1]]), roofEdgeSlopes(roof, outline), roof.overhang);
    if (!plan.planes.length) {
      const flat = prismGhostMesh(plane, plan.eaves, 0, thickness, firstId);
      return flat ? [flat] : [];
    }
    return plan.planes.flatMap((face, index) => {
      const mesh = prismGhostMesh(plane, face.outline, 0, thickness / Math.cos(face.slope), firstId + index);
      if (!mesh) return [];
      for (let i = 0; i < mesh.positions.length; i += 3) {
        const local = plane.renderToLocal([mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]);
        const lifted = plane.localToRender([local[0], local[1], local[2] + roofPlaneHeightAt(face, [local[0], local[1]])]);
        mesh.positions.set(lifted, i);
      }
      for (let i = 0; i < mesh.indices.length; i += 3) {
        const a = mesh.indices[i] * 3, b = mesh.indices[i + 1] * 3, c = mesh.indices[i + 2] * 3;
        const p = mesh.positions;
        const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
        const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
        const normal = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
        const length = Math.hypot(...normal) || 1;
        for (const v of [a, b, c]) mesh.normals.set(normal.map(n => n / length), v);
      }
      return [mesh];
    });
  } catch (error) {
    // Half-drawn or crossed polygons are not roofs yet; never keep a stale ghost.
    console.debug('[roof preview] footprint not ready', error);
    return [];
  }
}
