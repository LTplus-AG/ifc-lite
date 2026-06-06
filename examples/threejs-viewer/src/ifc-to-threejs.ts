/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Converts @ifc-lite/geometry MeshData into Three.js objects.
 *
 * Three rendering strategies are provided:
 *
 *  meshDataToThree          — one Mesh per entity (simple, good for picking)
 *  geometryResultToBatched  — merge by color (fewer draw calls, moderate)
 *  batchWithVertexColors    — merge ALL opaque into one draw call via vertex
 *                             colors; transparent grouped by alpha (best perf).
 *                             Returns a triangleMaps index for entity picking.
 */

import * as THREE from 'three';
import type { MeshData, GeometryResult } from '@ifc-lite/geometry';

/** Map from expressId → Three.js mesh, for picking / highlighting */
export type ExpressIdMap = Map<number, THREE.Mesh>;

/**
 * Maps a contiguous triangle range within a merged mesh back to an expressId.
 * `start` and `count` are in triangle units (i.e. faceIndex from Raycaster).
 */
export type TriangleRange = { expressId: number; start: number; count: number };

/**
 * Per-mesh triangle → entity lookup table produced by batchWithVertexColors.
 * Keys are the actual Three.js Mesh objects added to the scene.
 */
export type TriangleMaps = Map<THREE.Mesh, TriangleRange[]>;

/**
 * Convert a single MeshData into a Three.js Mesh.
 */
export function meshDataToThree(mesh: MeshData): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();

  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(mesh.positions, 3),
  );
  geometry.setAttribute(
    'normal',
    new THREE.BufferAttribute(mesh.normals, 3),
  );
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  geometry.computeBoundingSphere();

  const [r, g, b, a] = mesh.color;
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(r, g, b),
    transparent: a < 1,
    opacity: a,
    // DoubleSide even for opaque: IFC triangle winding is not reliably
    // outward (the native renderer draws with cullMode 'none' for the same
    // reason), and culling one side of two coincident coplanar walls — common
    // where a facing wall sits flush on a thicker one — leaves the surviving
    // faces z-fighting into a comb pattern along the seam.
    side: THREE.DoubleSide,
    depthWrite: a >= 1,
  });

  const threeMesh = new THREE.Mesh(geometry, material);
  threeMesh.userData.expressId = mesh.expressId;
  threeMesh.userData.ifcType = mesh.ifcType;

  return threeMesh;
}

/**
 * Convert an entire GeometryResult into a Three.js Group.
 *
 * Returns the group and an expressId→Mesh map for picking.
 */
export function geometryResultToThree(result: GeometryResult): {
  group: THREE.Group;
  expressIdMap: ExpressIdMap;
} {
  const group = new THREE.Group();
  const expressIdMap: ExpressIdMap = new Map();

  for (const mesh of result.meshes) {
    const threeMesh = meshDataToThree(mesh);
    group.add(threeMesh);
    expressIdMap.set(mesh.expressId, threeMesh);
  }

  return { group, expressIdMap };
}

/**
 * Batch meshes by color for fewer draw calls.
 *
 * Groups meshes that share the same RGBA color into merged
 * BufferGeometry objects. For large models this reduces draw calls
 * from thousands to dozens.
 */
export function geometryResultToBatched(result: GeometryResult): {
  group: THREE.Group;
  expressIdMap: ExpressIdMap;
} {
  const group = new THREE.Group();
  const expressIdMap: ExpressIdMap = new Map();

  const colorBuckets = new Map<string, MeshData[]>();
  for (const mesh of result.meshes) {
    const key = mesh.color.join(',');
    let bucket = colorBuckets.get(key);
    if (!bucket) {
      bucket = [];
      colorBuckets.set(key, bucket);
    }
    bucket.push(mesh);
  }

  for (const [, meshes] of colorBuckets) {
    let totalPositions = 0;
    let totalIndices = 0;
    for (const m of meshes) {
      totalPositions += m.positions.length;
      totalIndices += m.indices.length;
    }

    const positions = new Float32Array(totalPositions);
    const normals = new Float32Array(totalPositions);
    const indices = new Uint32Array(totalIndices);

    let posOffset = 0;
    let idxOffset = 0;
    let vertexOffset = 0;

    for (const m of meshes) {
      positions.set(m.positions, posOffset);
      normals.set(m.normals, posOffset);

      for (let i = 0; i < m.indices.length; i++) {
        indices[idxOffset + i] = m.indices[i] + vertexOffset;
      }

      posOffset += m.positions.length;
      idxOffset += m.indices.length;
      vertexOffset += m.positions.length / 3;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingSphere();

    const [r, g, b, a] = meshes[0].color;
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(r, g, b),
      transparent: a < 1,
      opacity: a,
      // DoubleSide for opaque too — see meshDataToThree: IFC winding varies and
      // coincident coplanar walls z-fight if one side is culled.
      side: THREE.DoubleSide,
      depthWrite: a >= 1,
    });

    const batchedMesh = new THREE.Mesh(geometry, material);
    group.add(batchedMesh);

    for (const m of meshes) {
      expressIdMap.set(m.expressId, batchedMesh);
    }
  }

  return { group, expressIdMap };
}

/**
 * Highest-performance batching strategy for large models.
 *
 * Merges ALL opaque meshes into a single draw call using a vertex color
 * attribute. Transparent meshes are grouped by alpha value. Alongside the
 * scene group, returns a `triangleMaps` index so individual entities can be
 * identified by their Three.js Raycaster faceIndex after the fact — enabling
 * object picking without a separate per-entity geometry layer.
 *
 * Trade-off: per-entity color changes require updating the color buffer.
 * Use meshDataToThree for interactive-editing workflows.
 */
export function batchWithVertexColors(meshes: MeshData[]): {
  group: THREE.Group;
  expressIdMap: ExpressIdMap;
  triangleMaps: TriangleMaps;
} {
  const group = new THREE.Group();
  const expressIdMap: ExpressIdMap = new Map();
  const triangleMaps: TriangleMaps = new Map();

  const opaque = meshes.filter((m) => m.color[3] >= 1);
  const transparent = meshes.filter((m) => m.color[3] < 1);

  if (opaque.length > 0) {
    const { mesh, triangleRanges } = mergeWithVertexColors(opaque, false);
    group.add(mesh);
    triangleMaps.set(mesh, triangleRanges);
    for (const m of opaque) expressIdMap.set(m.expressId, mesh);
  }

  if (transparent.length > 0) {
    const alphaGroups = new Map<number, MeshData[]>();
    for (const m of transparent) {
      const alpha = Math.round(m.color[3] * 100) / 100;
      let bucket = alphaGroups.get(alpha);
      if (!bucket) {
        bucket = [];
        alphaGroups.set(alpha, bucket);
      }
      bucket.push(m);
    }
    for (const [alpha, group_] of alphaGroups) {
      const { mesh, triangleRanges } = mergeWithVertexColors(group_, true, alpha);
      group.add(mesh);
      triangleMaps.set(mesh, triangleRanges);
      for (const m of group_) expressIdMap.set(m.expressId, mesh);
    }
  }

  return { group, expressIdMap, triangleMaps };
}

/**
 * Find the expressId for the entity whose triangles contain `faceIndex`.
 * Uses binary search — O(log n) per pick operation.
 * Returns null if not found.
 */
export function findEntityByFace(
  ranges: TriangleRange[],
  faceIndex: number,
): number | null {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const r = ranges[mid];
    if (faceIndex < r.start) {
      hi = mid - 1;
    } else if (faceIndex >= r.start + r.count) {
      lo = mid + 1;
    } else {
      return r.expressId;
    }
  }
  return null;
}

/** Merge an array of MeshData into one Mesh with per-vertex RGB colors. */
function mergeWithVertexColors(
  meshes: MeshData[],
  transparent: boolean,
  opacity = 1,
): { mesh: THREE.Mesh; triangleRanges: TriangleRange[] } {
  let totalVertices = 0;
  let totalIndices = 0;
  for (const m of meshes) {
    totalVertices += m.positions.length / 3;
    totalIndices += m.indices.length;
  }

  const positions = new Float32Array(totalVertices * 3);
  const normals = new Float32Array(totalVertices * 3);
  const colors = new Float32Array(totalVertices * 3);
  const indices = new Uint32Array(totalIndices);

  const triangleRanges: TriangleRange[] = [];
  let vOffset = 0;
  let iOffset = 0;

  for (const m of meshes) {
    const vertCount = m.positions.length / 3;
    const triCount = m.indices.length / 3;

    positions.set(m.positions, vOffset * 3);
    normals.set(m.normals, vOffset * 3);

    const [r, g, b] = m.color;
    for (let v = 0; v < vertCount; v++) {
      colors[(vOffset + v) * 3 + 0] = r;
      colors[(vOffset + v) * 3 + 1] = g;
      colors[(vOffset + v) * 3 + 2] = b;
    }

    for (let i = 0; i < m.indices.length; i++) {
      indices[iOffset + i] = m.indices[i] + vOffset;
    }

    triangleRanges.push({ expressId: m.expressId, start: iOffset / 3, count: triCount });

    vOffset += vertCount;
    iOffset += m.indices.length;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    transparent,
    opacity,
    // DoubleSide for opaque too — see meshDataToThree: IFC winding varies and
    // coincident coplanar walls z-fight if one side is culled.
    side: THREE.DoubleSide,
    depthWrite: !transparent,
  });

  return { mesh: new THREE.Mesh(geometry, material), triangleRanges };
}

/**
 * Process streaming geometry events into Three.js.
 *
 * Call this inside a `for await` loop over GeometryProcessor.processStreaming().
 * Each batch of MeshData is converted and added to the scene incrementally.
 */
export function addStreamingBatchToScene(
  meshes: MeshData[],
  scene: THREE.Scene,
  expressIdMap: ExpressIdMap,
): THREE.Group {
  const batchGroup = new THREE.Group();
  for (const mesh of meshes) {
    const threeMesh = meshDataToThree(mesh);
    batchGroup.add(threeMesh);
    expressIdMap.set(mesh.expressId, threeMesh);
  }
  scene.add(batchGroup);
  return batchGroup;
}
