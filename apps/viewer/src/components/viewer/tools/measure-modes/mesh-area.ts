/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sum a `MeshData`'s triangulated surface area — the "mesh analysis reachable
 * from TypeScript" prerequisite issue #2199 names for element surface area,
 * geometry-face area and coplanar-face area alike.
 *
 * `positions`/`indices` are already on every `MeshData` (`packages/geometry/
 * src/types.ts`); what was missing was a reusable triangle-area primitive —
 * `triangleArea` existed only inside `@ifc-lite/clash`'s contact solver and
 * was not re-exported from that package's public surface (packages/clash/src/
 * index.ts). This module is the other half: read one mesh's positions in
 * triples, hand each to the now-exported `triangleArea`, sum.
 *
 * WebGL Y-up metres, same frame as `MeshData.positions` — so the result is
 * already SI square metres, exactly like `MeshData.geometryVolume` is already
 * SI cubic metres. No unit conversion happens here; callers still run the
 * total through `resolveQuantityDisplay`/`convertValue` for display, same as
 * every other quantity in this panel.
 */

import { triangleArea, type Triangle } from '@ifc-lite/clash';

export interface MeshLike {
  /**
   * Absent for a mesh record that carries no render geometry (e.g. a test
   * double, or a future metadata-only piece) — treated as "no triangles to
   * measure", never as a crash. A real `MeshData` off the wasm pipeline
   * always has both.
   */
  readonly positions?: ArrayLike<number>;
  readonly indices?: ArrayLike<number>;
}

function readVertex(positions: ArrayLike<number>, index: number): [number, number, number] {
  const b = index * 3;
  return [positions[b] as number, positions[b + 1] as number, positions[b + 2] as number];
}

/**
 * Sum of every triangle's area in one mesh piece.
 *
 * This is the TOTAL triangulated surface of the piece — every face, not one
 * side — so it must never be presented as a `NetSideArea`/`GrossSideArea`
 * equivalent. Degenerate triangles (duplicate/collinear vertices) contribute
 * ~0 by construction (`triangleArea` = half the cross-product magnitude), so
 * they need no special-casing here.
 */
export function meshSurfaceArea(mesh: MeshLike): number {
  const indices = mesh.indices;
  if (!indices || !mesh.positions) return 0;
  const triCount = Math.floor(indices.length / 3);
  let total = 0;
  for (let i = 0; i < triCount; i++) {
    const i0 = indices[i * 3] as number;
    const i1 = indices[i * 3 + 1] as number;
    const i2 = indices[i * 3 + 2] as number;
    const t: Triangle = {
      v0: readVertex(mesh.positions, i0),
      v1: readVertex(mesh.positions, i1),
      v2: readVertex(mesh.positions, i2),
    };
    total += triangleArea(t);
  }
  return total;
}
