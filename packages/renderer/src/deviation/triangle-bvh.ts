/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-triangle BVH for closest-point queries (BIM ↔ scan deviation).
 *
 * Distinct from `bvh.ts` which is a per-mesh BVH used for raycasting:
 * for closest-point we want fine-grained pruning, so each leaf holds
 * a contiguous range of triangles. The build also flattens the tree
 * to a `Float32Array` ready for direct GPU upload — no second pass.
 *
 * Node layout (32 bytes = 8 floats per node, packed Float32 + bitcast u32):
 *   [0..2] aabbMin       (vec3<f32>)
 *   [3]    childA / triStart      (u32 bitcast: leaf flag = high bit)
 *   [4..6] aabbMax       (vec3<f32>)
 *   [7]    childB / triCount      (u32 bitcast)
 *
 * Triangle layout (48 bytes = 12 floats per triangle):
 *   [0..2]   v0 (vec3)
 *   [3..5]   v1 (vec3)
 *   [6..8]   v2 (vec3)
 *   [9..11]  normalised face normal (vec3) — sign convention: outward
 *            from mesh interior assuming CCW winding (right-hand rule)
 *
 * Maximum supported triangles: ~2³¹ (one bit reserved for the leaf
 * flag). Real BIMs top out around 10⁷ triangles before other bottle-
 * necks kick in.
 */

import type { MeshData } from '@ifc-lite/geometry';

export interface TriangleBVHResult {
  /** Flat node buffer (Float32Array). Each node is 8 floats. */
  nodes: Float32Array;
  /** Flat triangle buffer (Float32Array). Each triangle is 12 floats. */
  triangles: Float32Array;
  /** Total number of triangles. */
  triangleCount: number;
  /** Total number of nodes (root at index 0). */
  nodeCount: number;
  /** Number of source meshes folded into this BVH. */
  meshCount: number;
  /** Aggregate bounds of all triangles. */
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

/** High bit of the u32-packed slot 3 marks a leaf node. */
const LEAF_FLAG = 0x80000000;

/**
 * Build the per-triangle BVH.
 *
 * Splits leaves until each holds at most `maxTrisPerLeaf` triangles
 * (default 16, balancing tree depth vs. per-leaf work). Median split
 * along the longest AABB axis — fast O(n log n) build, no SAH for v1.
 *
 * For typical BIMs (1M triangles) the build runs in ~1–3 seconds on
 * the main thread. Acceptable since it only re-runs when the mesh
 * set changes (load / federation update).
 */
export function buildTriangleBVH(
  meshes: ReadonlyArray<MeshData>,
  options: { maxTrisPerLeaf?: number } = {},
): TriangleBVHResult {
  const maxTrisPerLeaf = options.maxTrisPerLeaf ?? 16;

  // Pass 1: flatten meshes into a triangle list with precomputed
  // centroids + AABBs. This array stays in CPU memory only long
  // enough to drive the build; the final output is a packed Float32
  // buffer suitable for GPU upload.
  const triCount = countTriangles(meshes);
  const triBuf = new Float32Array(triCount * 12);
  const centroids = new Float32Array(triCount * 3);
  const triAabb = new Float32Array(triCount * 6); // min(x,y,z) + max(x,y,z)
  let triIndex = 0;
  let bxMin = Infinity, byMin = Infinity, bzMin = Infinity;
  let bxMax = -Infinity, byMax = -Infinity, bzMax = -Infinity;

  for (const mesh of meshes) {
    const positions = mesh.positions;
    const indices = mesh.indices;
    if (!positions || positions.length === 0) continue;
    const n = indices ? indices.length : positions.length / 3;
    for (let i = 0; i + 2 < n; i += 3) {
      const i0 = indices ? indices[i]     * 3 : (i)     * 3;
      const i1 = indices ? indices[i + 1] * 3 : (i + 1) * 3;
      const i2 = indices ? indices[i + 2] * 3 : (i + 2) * 3;
      const x0 = positions[i0], y0 = positions[i0 + 1], z0 = positions[i0 + 2];
      const x1 = positions[i1], y1 = positions[i1 + 1], z1 = positions[i1 + 2];
      const x2 = positions[i2], y2 = positions[i2 + 1], z2 = positions[i2 + 2];
      const off = triIndex * 12;
      triBuf[off]      = x0; triBuf[off + 1]  = y0; triBuf[off + 2]  = z0;
      triBuf[off + 3]  = x1; triBuf[off + 4]  = y1; triBuf[off + 5]  = z1;
      triBuf[off + 6]  = x2; triBuf[off + 7]  = y2; triBuf[off + 8]  = z2;
      // Face normal — cross((v1-v0), (v2-v0)), normalised.
      const ex = x1 - x0, ey = y1 - y0, ez = z1 - z0;
      const fx = x2 - x0, fy = y2 - y0, fz = z2 - z0;
      let nx = ey * fz - ez * fy;
      let ny = ez * fx - ex * fz;
      let nz = ex * fy - ey * fx;
      const len = Math.hypot(nx, ny, nz);
      if (len > 1e-12) {
        nx /= len; ny /= len; nz /= len;
      } else {
        // Degenerate triangle (zero area) — keep a default so we
        // don't poison the GPU with NaN. Sign on these is meaningless.
        nx = 0; ny = 1; nz = 0;
      }
      triBuf[off + 9]  = nx;
      triBuf[off + 10] = ny;
      triBuf[off + 11] = nz;

      // Centroid + AABB for the BVH builder.
      const cx = (x0 + x1 + x2) / 3;
      const cy = (y0 + y1 + y2) / 3;
      const cz = (z0 + z1 + z2) / 3;
      centroids[triIndex * 3]     = cx;
      centroids[triIndex * 3 + 1] = cy;
      centroids[triIndex * 3 + 2] = cz;
      const tMinX = Math.min(x0, x1, x2);
      const tMinY = Math.min(y0, y1, y2);
      const tMinZ = Math.min(z0, z1, z2);
      const tMaxX = Math.max(x0, x1, x2);
      const tMaxY = Math.max(y0, y1, y2);
      const tMaxZ = Math.max(z0, z1, z2);
      triAabb[triIndex * 6]     = tMinX;
      triAabb[triIndex * 6 + 1] = tMinY;
      triAabb[triIndex * 6 + 2] = tMinZ;
      triAabb[triIndex * 6 + 3] = tMaxX;
      triAabb[triIndex * 6 + 4] = tMaxY;
      triAabb[triIndex * 6 + 5] = tMaxZ;

      if (tMinX < bxMin) bxMin = tMinX;
      if (tMinY < byMin) byMin = tMinY;
      if (tMinZ < bzMin) bzMin = tMinZ;
      if (tMaxX > bxMax) bxMax = tMaxX;
      if (tMaxY > byMax) byMax = tMaxY;
      if (tMaxZ > bzMax) bzMax = tMaxZ;

      triIndex++;
    }
  }

  // Build a permutation: tris[outOrder[k]] is the k-th triangle in
  // the BVH layout. The final emit re-orders `triBuf` in place via
  // a temporary copy so leaves can store [start, count) ranges
  // instead of an index list.
  const outOrder = new Uint32Array(triIndex);
  for (let i = 0; i < triIndex; i++) outOrder[i] = i;

  // Allocate node buffer with worst-case size: 2N - 1 nodes for N
  // leaves (binary tree). Trim at the end.
  const maxNodes = Math.max(1, 2 * triIndex - 1);
  const nodes = new Float32Array(maxNodes * 8);
  const nodesU32 = new Uint32Array(nodes.buffer);
  let nodeCursor = 0;

  // Iterative build to avoid JS recursion limits on big BIMs.
  // Stack entries hold the [start, end) range in `outOrder` and the
  // node index to populate.
  interface Frame { start: number; end: number; nodeIdx: number; }
  const allocNode = (): number => {
    const idx = nodeCursor++;
    return idx;
  };
  const setNodeAabb = (nodeIdx: number, mn: [number, number, number], mx: [number, number, number]): void => {
    const off = nodeIdx * 8;
    nodes[off]     = mn[0]; nodes[off + 1] = mn[1]; nodes[off + 2] = mn[2];
    nodes[off + 4] = mx[0]; nodes[off + 5] = mx[1]; nodes[off + 6] = mx[2];
  };
  const setLeaf = (nodeIdx: number, triStart: number, triCount: number): void => {
    const off = nodeIdx * 8;
    // High bit set on slot 3 marks "leaf"; remaining 31 bits hold start index.
    nodesU32[off + 3] = LEAF_FLAG | (triStart >>> 0);
    nodesU32[off + 7] = triCount >>> 0;
  };
  const setInternal = (nodeIdx: number, leftIdx: number, rightIdx: number): void => {
    const off = nodeIdx * 8;
    nodesU32[off + 3] = leftIdx >>> 0;
    nodesU32[off + 7] = rightIdx >>> 0;
  };

  const stack: Frame[] = [];
  if (triIndex > 0) {
    stack.push({ start: 0, end: triIndex, nodeIdx: allocNode() });
  } else {
    // Empty BVH — single zero-bound leaf so traversal can early-out.
    allocNode();
    setNodeAabb(0, [0, 0, 0], [0, 0, 0]);
    setLeaf(0, 0, 0);
  }

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const { start, end, nodeIdx } = frame;
    const count = end - start;

    // Compute AABB across the range.
    let nMinX = Infinity, nMinY = Infinity, nMinZ = Infinity;
    let nMaxX = -Infinity, nMaxY = -Infinity, nMaxZ = -Infinity;
    let cMinX = Infinity, cMinY = Infinity, cMinZ = Infinity;
    let cMaxX = -Infinity, cMaxY = -Infinity, cMaxZ = -Infinity;
    for (let k = start; k < end; k++) {
      const t = outOrder[k];
      const aOff = t * 6;
      const cOff = t * 3;
      if (triAabb[aOff]     < nMinX) nMinX = triAabb[aOff];
      if (triAabb[aOff + 1] < nMinY) nMinY = triAabb[aOff + 1];
      if (triAabb[aOff + 2] < nMinZ) nMinZ = triAabb[aOff + 2];
      if (triAabb[aOff + 3] > nMaxX) nMaxX = triAabb[aOff + 3];
      if (triAabb[aOff + 4] > nMaxY) nMaxY = triAabb[aOff + 4];
      if (triAabb[aOff + 5] > nMaxZ) nMaxZ = triAabb[aOff + 5];
      if (centroids[cOff]     < cMinX) cMinX = centroids[cOff];
      if (centroids[cOff + 1] < cMinY) cMinY = centroids[cOff + 1];
      if (centroids[cOff + 2] < cMinZ) cMinZ = centroids[cOff + 2];
      if (centroids[cOff]     > cMaxX) cMaxX = centroids[cOff];
      if (centroids[cOff + 1] > cMaxY) cMaxY = centroids[cOff + 1];
      if (centroids[cOff + 2] > cMaxZ) cMaxZ = centroids[cOff + 2];
    }
    setNodeAabb(nodeIdx, [nMinX, nMinY, nMinZ], [nMaxX, nMaxY, nMaxZ]);

    // Stop splitting when we hit the leaf threshold.
    if (count <= maxTrisPerLeaf) {
      setLeaf(nodeIdx, start, count);
      continue;
    }

    // Pick the longest centroid-bbox axis and median-split.
    const dx = cMaxX - cMinX, dy = cMaxY - cMinY, dz = cMaxZ - cMinZ;
    const axis = (dx > dy && dx > dz) ? 0 : (dy > dz ? 1 : 2);
    // Quickselect-ish median split: in-place sort of `outOrder[start:end]`
    // by centroid on the chosen axis. JS Array.sort is good enough here.
    const slice = Array.from(outOrder.subarray(start, end));
    slice.sort((a, b) => centroids[a * 3 + axis] - centroids[b * 3 + axis]);
    for (let i = 0; i < slice.length; i++) outOrder[start + i] = slice[i];
    const mid = start + (count >> 1);
    if (mid === start || mid === end) {
      // Centroid degeneracy → can't split, fall back to leaf even
      // though it exceeds the threshold. Rare in practice.
      setLeaf(nodeIdx, start, count);
      continue;
    }

    const leftIdx = allocNode();
    const rightIdx = allocNode();
    setInternal(nodeIdx, leftIdx, rightIdx);
    // Right first, left second → left popped first → DFS left-leaning.
    stack.push({ start: mid, end, nodeIdx: rightIdx });
    stack.push({ start, end: mid, nodeIdx: leftIdx });
  }

  // Emit triangles in BVH order so leaves can store [start, count).
  const reordered = new Float32Array(triIndex * 12);
  for (let k = 0; k < triIndex; k++) {
    const src = outOrder[k] * 12;
    const dst = k * 12;
    for (let i = 0; i < 12; i++) reordered[dst + i] = triBuf[src + i];
  }

  return {
    nodes: nodes.subarray(0, nodeCursor * 8),
    triangles: reordered,
    triangleCount: triIndex,
    nodeCount: nodeCursor,
    meshCount: meshes.length,
    bounds: {
      min: triIndex > 0 ? [bxMin, byMin, bzMin] : [0, 0, 0],
      max: triIndex > 0 ? [bxMax, byMax, bzMax] : [0, 0, 0],
    },
  };
}

function countTriangles(meshes: ReadonlyArray<MeshData>): number {
  let count = 0;
  for (const mesh of meshes) {
    const positions = mesh.positions;
    if (!positions || positions.length === 0) continue;
    const indices = mesh.indices;
    const n = indices ? indices.length : positions.length / 3;
    count += Math.floor(n / 3);
  }
  return count;
}
