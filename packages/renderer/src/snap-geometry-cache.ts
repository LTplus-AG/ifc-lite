/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Geometry cache building for snap detection.
 *
 * Extracts vertices, edges, and connectivity information from mesh data
 * for efficient snap-target lookups.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { Vec3 } from './raycaster.js';

export interface MeshGeometryCache {
  vertices: Vec3[];
  edges: Array<{ v0: Vec3; v1: Vec3; index: number }>;
  // Vertex valence map: vertex key -> number of edges connected
  vertexValence: Map<string, number>;
  // Edges at each vertex: vertex key -> array of edge indices
  vertexEdges: Map<string, number[]>;
}

/**
 * Build a geometry cache for a mesh: deduplicated vertices, filtered edges,
 * and vertex-valence / vertex-edge connectivity maps.
 */
export function buildGeometryCache(mesh: MeshData): MeshGeometryCache {
  const positions = mesh.positions;

  // Validate input
  if (!positions || positions.length === 0) {
    return {
      vertices: [],
      edges: [],
      vertexValence: new Map(),
      vertexEdges: new Map(),
    };
  }

  const vertexMap = new Map<string, Vec3>();

  for (let i = 0; i < positions.length; i += 3) {
    const vertex: Vec3 = {
      x: positions[i],
      y: positions[i + 1],
      z: positions[i + 2],
    };

    // Skip invalid vertices
    if (!isFinite(vertex.x) || !isFinite(vertex.y) || !isFinite(vertex.z)) {
      continue;
    }

    // Use reduced precision for deduplication
    const key = `${vertex.x.toFixed(4)}_${vertex.y.toFixed(4)}_${vertex.z.toFixed(4)}`;
    vertexMap.set(key, vertex);
  }

  const vertices = Array.from(vertexMap.values());

  // Compute and cache edges + vertex valence for corner detection
  // Filter out internal triangulation edges (diagonals) - only keep real model edges
  const edges: Array<{ v0: Vec3; v1: Vec3; index: number }> = [];
  const vertexValence = new Map<string, number>();
  const vertexEdges = new Map<string, number[]>();
  const indices = mesh.indices;

  if (indices) {
    // First pass: collect edges and their adjacent triangle normals
    const edgeData = new Map<string, {
      v0: Vec3; v1: Vec3; idx0: number; idx1: number;
      normals: Vec3[]; // Normals of triangles sharing this edge
    }>();

    // Helper to compute triangle normal
    const computeTriangleNormal = (i: number): Vec3 => {
      const i0 = indices[i] * 3;
      const i1 = indices[i + 1] * 3;
      const i2 = indices[i + 2] * 3;

      const ax = positions[i1] - positions[i0];
      const ay = positions[i1 + 1] - positions[i0 + 1];
      const az = positions[i1 + 2] - positions[i0 + 2];
      const bx = positions[i2] - positions[i0];
      const by = positions[i2 + 1] - positions[i0 + 1];
      const bz = positions[i2 + 2] - positions[i0 + 2];

      // Cross product
      const nx = ay * bz - az * by;
      const ny = az * bx - ax * bz;
      const nz = ax * by - ay * bx;

      // Normalize
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      return len > 0 ? { x: nx / len, y: ny / len, z: nz / len } : { x: 0, y: 1, z: 0 };
    };

    for (let i = 0; i < indices.length; i += 3) {
      const triNormal = computeTriangleNormal(i);
      const triangleEdges = [
        [indices[i], indices[i + 1]],
        [indices[i + 1], indices[i + 2]],
        [indices[i + 2], indices[i]],
      ];

      for (const [idx0, idx1] of triangleEdges) {
        const i0 = idx0 * 3;
        const i1 = idx1 * 3;

        const v0: Vec3 = {
          x: positions[i0],
          y: positions[i0 + 1],
          z: positions[i0 + 2],
        };
        const v1: Vec3 = {
          x: positions[i1],
          y: positions[i1 + 1],
          z: positions[i1 + 2],
        };

        // Create canonical edge key (smaller index first)
        const key = idx0 < idx1 ? `${idx0}_${idx1}` : `${idx1}_${idx0}`;

        if (!edgeData.has(key)) {
          edgeData.set(key, { v0, v1, idx0, idx1, normals: [triNormal] });
        } else {
          const existing = edgeData.get(key);
          if (existing) {
            existing.normals.push(triNormal);
          }
        }
      }
    }

    // Second pass: filter to only real edges (boundary or crease edges)
    // Skip internal triangulation edges (shared by coplanar triangles)
    const COPLANAR_THRESHOLD = 0.98; // Dot product threshold for coplanar check

    for (const [, data] of edgeData) {
      const { v0, v1, normals } = data;

      // Boundary edge: only one triangle uses it - always a real edge
      if (normals.length === 1) {
        const edgeIndex = edges.length;
        edges.push({ v0, v1, index: edgeIndex });

        // Track vertex valence
        const v0Key = `${v0.x.toFixed(4)}_${v0.y.toFixed(4)}_${v0.z.toFixed(4)}`;
        const v1Key = `${v1.x.toFixed(4)}_${v1.y.toFixed(4)}_${v1.z.toFixed(4)}`;
        vertexValence.set(v0Key, (vertexValence.get(v0Key) || 0) + 1);
        vertexValence.set(v1Key, (vertexValence.get(v1Key) || 0) + 1);
        if (!vertexEdges.has(v0Key)) vertexEdges.set(v0Key, []);
        if (!vertexEdges.has(v1Key)) vertexEdges.set(v1Key, []);
        const v0Edges = vertexEdges.get(v0Key);
        const v1Edges = vertexEdges.get(v1Key);
        if (v0Edges) v0Edges.push(edgeIndex);
        if (v1Edges) v1Edges.push(edgeIndex);
        continue;
      }

      // Shared edge: check if triangles are coplanar (internal triangulation edge)
      if (normals.length >= 2) {
        const n1 = normals[0];
        const n2 = normals[1];
        const dot = Math.abs(n1.x * n2.x + n1.y * n2.y + n1.z * n2.z);

        // If normals are nearly parallel, triangles are coplanar - skip this edge
        // (it's an internal triangulation diagonal, not a real model edge)
        if (dot > COPLANAR_THRESHOLD) {
          continue; // Skip internal edge
        }

        // Crease edge: triangles meet at an angle - this is a real edge
        const edgeIndex = edges.length;
        edges.push({ v0, v1, index: edgeIndex });

        // Track vertex valence
        const v0Key = `${v0.x.toFixed(4)}_${v0.y.toFixed(4)}_${v0.z.toFixed(4)}`;
        const v1Key = `${v1.x.toFixed(4)}_${v1.y.toFixed(4)}_${v1.z.toFixed(4)}`;
        vertexValence.set(v0Key, (vertexValence.get(v0Key) || 0) + 1);
        vertexValence.set(v1Key, (vertexValence.get(v1Key) || 0) + 1);
        if (!vertexEdges.has(v0Key)) vertexEdges.set(v0Key, []);
        if (!vertexEdges.has(v1Key)) vertexEdges.set(v1Key, []);
        const v0CreaseEdges = vertexEdges.get(v0Key);
        const v1CreaseEdges = vertexEdges.get(v1Key);
        if (v0CreaseEdges) v0CreaseEdges.push(edgeIndex);
        if (v1CreaseEdges) v1CreaseEdges.push(edgeIndex);
      }
    }
  }

  return { vertices, edges, vertexValence, vertexEdges };
}
