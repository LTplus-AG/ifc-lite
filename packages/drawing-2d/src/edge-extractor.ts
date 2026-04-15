/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Edge Extractor - Extract feature edges from triangle meshes
 *
 * Identifies:
 * - Crease edges (sharp angles between adjacent faces)
 * - Boundary edges (mesh borders)
 * - Silhouette edges (contour edges for a given view direction)
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { Vec3, EdgeData, Point2D, DrawingLine, LineCategory } from './types.js';
import {
  vec3,
  vec3Sub,
  vec3Cross,
  vec3Normalize,
  vec3Dot,
  vec3Length,
  EPSILON,
  projectTo2D,
} from './math.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

interface EdgeKey {
  minIdx: number;
  maxIdx: number;
}

interface EdgeInfo {
  v0Idx: number;
  v1Idx: number;
  faceIndices: number[];
}

// ═══════════════════════════════════════════════════════════════════════════
// EDGE EXTRACTOR CLASS
// ═══════════════════════════════════════════════════════════════════════════

export class EdgeExtractor {
  /** Crease angle threshold in radians */
  private creaseAngle: number;

  constructor(creaseAngleDegrees: number = 30) {
    this.creaseAngle = (creaseAngleDegrees * Math.PI) / 180;
  }

  /**
   * Extract all feature edges from a mesh
   */
  extractEdges(mesh: MeshData): EdgeData[] {
    const { positions, indices, expressId, ifcType, modelIndex } = mesh;

    // Build edge-to-face adjacency map
    const edgeMap = new Map<string, EdgeInfo>();
    const faceNormals: Vec3[] = [];

    const triangleCount = indices.length / 3;

    // First pass: compute face normals and build edge adjacency
    for (let t = 0; t < triangleCount; t++) {
      const i0 = indices[t * 3];
      const i1 = indices[t * 3 + 1];
      const i2 = indices[t * 3 + 2];

      // Get vertices
      const v0 = this.getVertex(positions, i0);
      const v1 = this.getVertex(positions, i1);
      const v2 = this.getVertex(positions, i2);

      // Compute face normal
      const faceNormal = this.computeFaceNormal(v0, v1, v2);
      faceNormals.push(faceNormal);

      // Register edges
      this.registerEdge(edgeMap, i0, i1, t);
      this.registerEdge(edgeMap, i1, i2, t);
      this.registerEdge(edgeMap, i2, i0, t);
    }

    // Second pass: classify edges
    const edges: EdgeData[] = [];

    for (const [, edgeInfo] of edgeMap) {
      const v0 = this.getVertex(positions, edgeInfo.v0Idx);
      const v1 = this.getVertex(positions, edgeInfo.v1Idx);

      let face0Normal: Vec3 | null = null;
      let face1Normal: Vec3 | null = null;
      let dihedralAngle = 0;
      let type: EdgeData['type'] = 'smooth';

      if (edgeInfo.faceIndices.length === 1) {
        // Boundary edge (only one adjacent face)
        type = 'boundary';
        face0Normal = faceNormals[edgeInfo.faceIndices[0]];
      } else if (edgeInfo.faceIndices.length >= 2) {
        face0Normal = faceNormals[edgeInfo.faceIndices[0]];
        face1Normal = faceNormals[edgeInfo.faceIndices[1]];

        // Compute dihedral angle
        const dot = Math.max(-1, Math.min(1, vec3Dot(face0Normal, face1Normal)));
        dihedralAngle = Math.acos(dot);

        // Classify as crease if angle exceeds threshold
        if (dihedralAngle > this.creaseAngle) {
          type = 'crease';
        }
      }

      // Only include non-smooth edges
      if (type !== 'smooth') {
        edges.push({
          v0,
          v1,
          face0Normal,
          face1Normal,
          dihedralAngle,
          type,
          entityId: expressId,
          ifcType: ifcType || 'Unknown',
          modelIndex: modelIndex || 0,
        });
      }
    }

    return edges;
  }

  /**
   * Extract edges from multiple meshes
   */
  extractEdgesFromMeshes(meshes: MeshData[]): EdgeData[] {
    const allEdges: EdgeData[] = [];
    for (const mesh of meshes) {
      const edges = this.extractEdges(mesh);
      allEdges.push(...edges);
    }
    return allEdges;
  }

  /**
   * Extract silhouette edges for a given view direction
   * Silhouette edges are where one adjacent face is front-facing and the other is back-facing
   */
  extractSilhouettes(edges: EdgeData[], viewDirection: Vec3): EdgeData[] {
    const normalizedView = vec3Normalize(viewDirection);

    return edges.filter((edge) => {
      // Boundary edges are always silhouettes
      if (edge.type === 'boundary') {
        return true;
      }

      // Need both face normals for silhouette test
      if (!edge.face0Normal || !edge.face1Normal) {
        return false;
      }

      const dot0 = vec3Dot(edge.face0Normal, normalizedView);
      const dot1 = vec3Dot(edge.face1Normal, normalizedView);

      // Silhouette: one face toward viewer (dot < 0), one away (dot > 0)
      return (dot0 < 0) !== (dot1 < 0);
    });
  }

  /**
   * Convert edges to 2D drawing lines
   */
  edgesToDrawingLines(
    edges: EdgeData[],
    axis: 'x' | 'y' | 'z',
    flipped: boolean,
    category: LineCategory,
    sectionPosition: number
  ): DrawingLine[] {
    return edges.map((edge) => {
      const start = projectTo2D(edge.v0, axis, flipped);
      const end = projectTo2D(edge.v1, axis, flipped);

      // Compute depth as distance from section plane
      const depthAxis = axis;
      const depth = Math.min(
        Math.abs(edge.v0[depthAxis] - sectionPosition),
        Math.abs(edge.v1[depthAxis] - sectionPosition)
      );

      return {
        line: { start, end },
        category,
        visibility: 'visible' as const,
        entityId: edge.entityId,
        ifcType: edge.ifcType,
        modelIndex: edge.modelIndex,
        depth,
      };
    });
  }

  /**
   * Filter edges that are within a depth range from the section plane.
   * Includes edges where:
   * - Either endpoint is within range
   * - The edge crosses through the depth band (one endpoint before, one after)
   */
  filterEdgesByDepth(
    edges: EdgeData[],
    axis: 'x' | 'y' | 'z',
    sectionPosition: number,
    maxDepth: number,
    flipped: boolean
  ): EdgeData[] {
    return edges.filter((edge) => {
      const d0 = edge.v0[axis] - sectionPosition;
      const d1 = edge.v1[axis] - sectionPosition;

      // Define the valid depth range
      // When not flipped: [0, maxDepth] (positive direction from plane)
      // When flipped: [-maxDepth, 0] (negative direction from plane)
      const rangeMin = flipped ? -maxDepth : 0;
      const rangeMax = flipped ? 0 : maxDepth;

      // Check if endpoints are within range
      const inRange0 = d0 >= rangeMin && d0 <= rangeMax;
      const inRange1 = d1 >= rangeMin && d1 <= rangeMax;

      // Check if edge crosses the depth band
      // This happens when one endpoint is before rangeMin and the other is after rangeMax
      const crossesBand = (d0 < rangeMin && d1 > rangeMax) || (d1 < rangeMin && d0 > rangeMax);

      return inRange0 || inRange1 || crossesBand;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  private getVertex(positions: Float32Array, index: number): Vec3 {
    const base = index * 3;
    return vec3(positions[base], positions[base + 1], positions[base + 2]);
  }

  private computeFaceNormal(v0: Vec3, v1: Vec3, v2: Vec3): Vec3 {
    const edge1 = vec3Sub(v1, v0);
    const edge2 = vec3Sub(v2, v0);
    const cross = vec3Cross(edge1, edge2);
    return vec3Normalize(cross);
  }

  private registerEdge(
    edgeMap: Map<string, EdgeInfo>,
    idx0: number,
    idx1: number,
    faceIndex: number
  ): void {
    // Use canonical edge key (smaller index first)
    const minIdx = Math.min(idx0, idx1);
    const maxIdx = Math.max(idx0, idx1);
    const key = `${minIdx}:${maxIdx}`;

    if (!edgeMap.has(key)) {
      edgeMap.set(key, {
        v0Idx: minIdx,
        v1Idx: maxIdx,
        faceIndices: [],
      });
    }
    edgeMap.get(key)!.faceIndices.push(faceIndex);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get view direction from section axis
 */
export function getViewDirection(axis: 'x' | 'y' | 'z', flipped: boolean): Vec3 {
  const sign = flipped ? 1 : -1;
  switch (axis) {
    case 'x':
      return { x: sign, y: 0, z: 0 };
    case 'y':
      return { x: 0, y: sign, z: 0 };
    case 'z':
      return { x: 0, y: 0, z: sign };
  }
}
