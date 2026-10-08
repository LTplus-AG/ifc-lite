/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One mesh piece as the collision world holds it: the scene's own position
 * and index arrays (never copied) plus, for anything past a few dozen
 * triangles, a tree over its triangles in the piece's local frame. Queries
 * shift the box or ray into that frame once instead of shifting vertices.
 */

import { buildAabbTree, queryAabbTree, rayQueryAabbTree, raySlab, type AabbTree, type IndexList } from './aabbTree.js';
import { rayTriangle } from './walkGeometry.js';

/** Meshes at or under this many triangles are scanned rather than indexed. */
const SCAN_LIMIT = 48;

export interface PreparedPiece {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly ox: number; readonly oy: number; readonly oz: number;
  readonly tree: AabbTree | null;
}

export interface PieceHit {
  t: number;
  /** Unit face normal, flipped to face the ray origin. */
  nx: number; ny: number; nz: number;
}

export function preparePiece(
  piece: { readonly positions: Float32Array; readonly indices: Uint32Array; readonly origin?: ArrayLike<number> },
  count: number,
): PreparedPiece {
  const o = piece.origin;
  return {
    positions: piece.positions,
    indices: piece.indices,
    ox: o ? o[0] : 0, oy: o ? o[1] : 0, oz: o ? o[2] : 0,
    tree: count > SCAN_LIMIT ? buildTriangleTree(piece.positions, piece.indices, count) : null,
  };
}

/** Sink for gathered triangles: 9 world-space floats per triangle. */
export class TriangleList {
  data = new Float64Array(9 * 256);
  length = 0;

  clear(): void { this.length = 0; }

  push(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): void {
    const o = this.length * 9;
    if (o + 9 > this.data.length) {
      const grown = new Float64Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    const d = this.data;
    d[o] = ax; d[o + 1] = ay; d[o + 2] = az;
    d[o + 3] = bx; d[o + 4] = by; d[o + 5] = bz;
    d[o + 6] = cx; d[o + 7] = cy; d[o + 8] = cz;
    this.length++;
  }
}

export function gatherPiece(
  piece: PreparedPiece,
  minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number,
  out: TriangleList,
  local: IndexList,
): void {
  const { positions: p, indices: idx, ox, oy, oz } = piece;
  // Query in the piece's local frame: one subtraction per query, not per vertex.
  const lx0 = minX - ox, ly0 = minY - oy, lz0 = minZ - oz;
  const lx1 = maxX - ox, ly1 = maxY - oy, lz1 = maxZ - oz;
  const visit = (t: number): void => {
    const i = t * 3;
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const ax = p[a], ay = p[a + 1], az = p[a + 2];
    const bx = p[b], by = p[b + 1], bz = p[b + 2];
    const cx = p[c], cy = p[c + 1], cz = p[c + 2];
    if (Math.max(ax, bx, cx) < lx0 || Math.min(ax, bx, cx) > lx1) return;
    if (Math.max(ay, by, cy) < ly0 || Math.min(ay, by, cy) > ly1) return;
    if (Math.max(az, bz, cz) < lz0 || Math.min(az, bz, cz) > lz1) return;
    out.push(ax + ox, ay + oy, az + oz, bx + ox, by + oy, bz + oz, cx + ox, cy + oy, cz + oz);
  };
  if (piece.tree) {
    local.clear();
    queryAabbTree(piece.tree, lx0, ly0, lz0, lx1, ly1, lz1, local);
    for (let k = 0; k < local.length; k++) visit(local.items[k]);
  } else {
    const count = Math.floor(idx.length / 3);
    for (let t = 0; t < count; t++) visit(t);
  }
}

export function raycastPiece(
  piece: PreparedPiece,
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tMax: number,
  local: IndexList,
): PieceHit | null {
  const { positions: p, indices: idx } = piece;
  const lx = ox - piece.ox, ly = oy - piece.oy, lz = oz - piece.oz;
  let bestT = tMax;
  let bestTri = -1;
  const test = (t: number): void => {
    const i = t * 3;
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const hit = rayTriangle(lx, ly, lz, dx, dy, dz,
      p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2], p[c], p[c + 1], p[c + 2], bestT);
    if (hit >= 0 && hit < bestT) { bestT = hit; bestTri = t; }
  };
  if (piece.tree) {
    local.clear();
    rayQueryAabbTree(piece.tree, lx, ly, lz, dx, dy, dz, tMax, local);
    for (let k = 0; k < local.length; k++) test(local.items[k]);
  } else {
    const count = Math.floor(idx.length / 3);
    const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
    // Cheap whole-piece reject before scanning a small mesh.
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < idx.length; k++) {
      const v = idx[k] * 3;
      const x = p[v], y = p[v + 1], z = p[v + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    if (!raySlab(lx, ly, lz, ix, iy, iz, tMax, x0, y0, z0, x1, y1, z1)) return null;
    for (let t = 0; t < count; t++) test(t);
  }
  if (bestTri < 0) return null;
  const i = bestTri * 3;
  const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
  const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
  const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
  let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  if (nx * dx + ny * dy + nz * dz > 0) { nx = -nx; ny = -ny; nz = -nz; }
  return { t: bestT, nx, ny, nz };
}

/** Index one mesh's triangles by their local-frame boxes. The boxes are dropped after the build. */
function buildTriangleTree(p: Float32Array, idx: Uint32Array, count: number): AabbTree {
  const boxes = new Float32Array(count * 6);
  for (let t = 0; t < count; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const o = t * 6;
    boxes[o] = Math.min(p[a], p[b], p[c]);
    boxes[o + 1] = Math.min(p[a + 1], p[b + 1], p[c + 1]);
    boxes[o + 2] = Math.min(p[a + 2], p[b + 2], p[c + 2]);
    boxes[o + 3] = Math.max(p[a], p[b], p[c]);
    boxes[o + 4] = Math.max(p[a + 1], p[b + 1], p[c + 1]);
    boxes[o + 5] = Math.max(p[a + 2], p[b + 2], p[c + 2]);
  }
  return buildAabbTree(boxes, count);
}
