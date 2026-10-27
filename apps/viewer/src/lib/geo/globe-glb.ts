/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bake the GeoWarp into the world-view meshes ("Exact" globe placement).
 *
 * Every vertex is moved to its anchor-ENU position (`geo-warp.ts`), so the
 * Cesium model matrix becomes a pure `eastNorthUpToFixedFrame(anchor)`.
 *
 * FLOAT32: glTF positions are 32-bit. ENU metres 10 km from the anchor carry
 * about 1 mm of rounding, so meshes are grouped into tiles of
 * {@link GLOBE_TILE_M} by their warped centre, and each tile's positions are
 * stored relative to the tile centre, which travels as the glTF node
 * translation (a double in the JSON, composed in double precision by Cesium).
 * A vertex then sits within about a tile's half-diagonal plus its own mesh's
 * extent of the node origin: 0.1 mm of rounding for 2 km tiles. A single mesh
 * longer than a tile (one alignment solid) keeps its own extent's rounding.
 *
 * NORMALS: rotated per mesh by the cofactor of the warp's Jacobian at the mesh
 * centre (`normalMatrix`), which carries the viewer-to-ENU rotation, Scale x
 * FactorZ, and the local tilt of up (r/R: 1.6 mrad at 10 km). One matrix per
 * mesh is exact to that tilt's change across the mesh, which no mesh notices.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { GeoMapping } from './geo-warp';
import { createLatticeWarp, type LatticeWarp, type ViewerBounds } from './geo-lattice';
import { linearizeWarp, normalMatrix } from './geo-jacobian';

/** Tile edge, metres of anchor ENU. */
export const GLOBE_TILE_M = 2000;

export interface GlobeTile {
  /** Anchor-ENU node translation of this tile's positions. */
  translation: [number, number, number];
  meshes: MeshData[];
}

/** Viewer-space bounds of the meshes, origins folded in; null when there are no vertices. */
function meshViewerBounds(meshes: readonly MeshData[]): ViewerBounds | null {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const m of meshes) {
    const p = m.positions;
    if (!p?.length) continue;
    const ox = m.origin?.[0] ?? 0, oy = m.origin?.[1] ?? 0, oz = m.origin?.[2] ?? 0;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i] + ox, y = p[i + 1] + oy, z = p[i + 2] + oz;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}

/** Warp `meshes` through a lattice built over their own bounds; null when the lattice cannot be built. */
export function bakeGlobeTiles(meshes: readonly MeshData[], mapping: GeoMapping, tileSize = GLOBE_TILE_M): GlobeTile[] | null {
  const bounds = meshViewerBounds(meshes);
  if (!bounds) return [];
  const lattice = createLatticeWarp(mapping, bounds);
  return lattice ? warpMeshesForGlobe(meshes, lattice, tileSize) : null;
}

function warpMeshesForGlobe(meshes: readonly MeshData[], lattice: LatticeWarp, tileSize = GLOBE_TILE_M): GlobeTile[] {
  const tiles = new Map<string, GlobeTile>();
  const out = [0, 0, 0];
  for (const m of meshes) {
    const p = m.positions;
    if (!p?.length) continue;
    const nv = p.length / 3;
    const ox = m.origin?.[0] ?? 0, oy = m.origin?.[1] ?? 0, oz = m.origin?.[2] ?? 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i] < minX) minX = p[i]; if (p[i] > maxX) maxX = p[i];
      if (p[i + 1] < minY) minY = p[i + 1]; if (p[i + 1] > maxY) maxY = p[i + 1];
      if (p[i + 2] < minZ) minZ = p[i + 2]; if (p[i + 2] > maxZ) maxZ = p[i + 2];
    }
    const cx = (minX + maxX) / 2 + ox, cy = (minY + maxY) / 2 + oy, cz = (minZ + maxZ) / 2 + oz;
    const lin = linearizeWarp(lattice.warp, cx, cy, cz);
    if (!lin) continue;
    const ti = Math.floor(lin.value[0] / tileSize), tj = Math.floor(lin.value[1] / tileSize);
    const key = `${ti}:${tj}`;
    let tile = tiles.get(key);
    if (!tile) {
      tile = { translation: [(ti + 0.5) * tileSize, (tj + 0.5) * tileSize, 0], meshes: [] };
      tiles.set(key, tile);
    }
    const [tx, ty] = tile.translation;
    const positions = new Float32Array(p.length);
    for (let i = 0; i < nv; i++) {
      const s = i * 3;
      lattice.warp(p[s] + ox, p[s + 1] + oy, p[s + 2] + oz, out);
      positions[s] = out[0] - tx;
      positions[s + 1] = out[1] - ty;
      positions[s + 2] = out[2];
    }
    let normals: Float32Array | undefined;
    if (m.normals?.length === p.length) {
      const c = normalMatrix(lin.jacobian);
      normals = new Float32Array(p.length);
      const n = m.normals;
      for (let i = 0; i < nv; i++) {
        const s = i * 3;
        const x = c[0][0] * n[s] + c[0][1] * n[s + 1] + c[0][2] * n[s + 2];
        const y = c[1][0] * n[s] + c[1][1] * n[s + 1] + c[1][2] * n[s + 2];
        const z = c[2][0] * n[s] + c[2][1] * n[s + 1] + c[2][2] * n[s + 2];
        const len = Math.hypot(x, y, z) || 1;
        normals[s] = x / len; normals[s + 1] = y / len; normals[s + 2] = z / len;
      }
    }
    tile.meshes.push({ ...m, positions, normals: normals ?? m.normals, origin: undefined });
  }
  return [...tiles.values()];
}
