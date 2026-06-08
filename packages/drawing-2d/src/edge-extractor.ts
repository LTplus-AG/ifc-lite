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
import type { Vec3, EdgeData, DrawingLine, SectionPlaneConfig } from './types.js';
import {
  vec3,
  vec3Sub,
  vec3Cross,
  vec3Normalize,
  vec3Dot,
  vec3Lerp,
  EPSILON,
} from './math.js';

/**
 * Clip a segment to the depth window `[lo, hi]` in flip-adjusted depth.
 * `d0`/`d1` are the endpoint depths; returns the `[t0, t1]` parameter range
 * (0 = start, 1 = end) inside the window, or `null` if the segment is entirely
 * outside it. A segment parallel to the plane is in-or-out as a whole.
 */
function clipSegmentDepth(d0: number, d1: number, lo: number, hi: number): [number, number] | null {
  const dd = d1 - d0;
  if (Math.abs(dd) < 1e-12) {
    return d0 >= lo && d0 <= hi ? [0, 1] : null;
  }
  const ta = (lo - d0) / dd;
  const tb = (hi - d0) / dd;
  const t0 = Math.max(0, Math.min(ta, tb));
  const t1 = Math.min(1, Math.max(ta, tb));
  return t0 <= t1 ? [t0, t1] : null;
}
import {
  type ProjectionBandDepths,
  classifySegmentBand,
  bandVisibility,
  projectPointForPlane,
  signedDepth,
} from './projection-bands.js';

/**
 * Dot-product deadband for the silhouette test (issue #979).
 *
 * A silhouette edge separates a face that is front-facing (normal points
 * toward the viewer, `dot < -ε`) from one that is NOT front-facing. For an
 * axis-aligned box viewed straight down — the common floor-plan case — the top
 * face is front-facing while the four side faces are exactly perpendicular
 * (`dot ≈ 0`); the footprint outline is precisely the top-vs-side edges, so
 * "not front-facing" must include the perpendicular (deadband) faces, not just
 * strictly-back ones.
 *
 * The deadband must be larger than f32 normal noise so two perpendicular side
 * faces (`dot ≈ 0`) are classified identically and their shared vertical edge
 * doesn't flicker as a spurious silhouette. 1e-4 (~0.006°) absorbs the noise
 * without excluding any genuinely tilted face (e.g. a pitched roof).
 */
const SILHOUETTE_EPSILON = 1e-4;

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

      // Silhouette: exactly one adjacent face is front-facing (normal toward
      // the viewer). "Not front-facing" deliberately includes perpendicular
      // (deadband) faces so the top-vs-side outline edges of an axis-aligned
      // box survive, while two perpendicular side faces (both not-front) don't
      // flicker into a spurious silhouette under f32 noise. See
      // SILHOUETTE_EPSILON.
      const front0 = dot0 < -SILHOUETTE_EPSILON;
      const front1 = dot1 < -SILHOUETTE_EPSILON;
      return front0 !== front1;
    });
  }

  /**
   * Convert silhouette edges into band-classified construction-projection
   * lines (issue #979). Each edge is classified by its own endpoints:
   *  - below the cut → `visibility: 'visible'` (thin solid)
   *  - above the cut → `visibility: 'hidden'`  (dashed)
   *  - outside both bands → dropped
   *
   * Projection uses the SAME basis as the section cutter
   * (`projectPointForPlane`), so silhouette lines coincide with cut polygons.
   * Emitted as `category: 'projection'` (the issue's "thin solid projected
   * edge"), not the heavier `silhouette` weight.
   */
  edgesToProjectionLines(
    edges: EdgeData[],
    plane: SectionPlaneConfig,
    depths: ProjectionBandDepths,
  ): DrawingLine[] {
    const lines: DrawingLine[] = [];
    // Band window in flip-adjusted depth: visible [-below, 0] ∪ overhead [0, above].
    const windowLo = -depths.below;
    const windowHi = depths.above;

    for (const edge of edges) {
      const d0 = signedDepth(edge.v0, plane);
      const d1 = signedDepth(edge.v1, plane);

      // Clip the 3D segment to the band window first, so a long sloped roof /
      // stair / ramp edge with only a small in-band overlap doesn't get
      // projected full-length outside the configured projection window.
      const clip = clipSegmentDepth(d0, d1, windowLo, windowHi);
      if (!clip) continue;

      const a = vec3Lerp(edge.v0, edge.v1, clip[0]);
      const b = vec3Lerp(edge.v0, edge.v1, clip[1]);

      const visibility = bandVisibility(classifySegmentBand(a, b, plane, depths));
      if (visibility === null) continue;

      const start = projectPointForPlane(a, plane);
      const end = projectPointForPlane(b, plane);

      // Skip degenerate (zero-length) projected segments.
      if (Math.abs(start.x - end.x) < EPSILON && Math.abs(start.y - end.y) < EPSILON) {
        continue;
      }

      lines.push({
        line: { start, end },
        category: 'projection',
        visibility,
        entityId: edge.entityId,
        ifcType: edge.ifcType,
        modelIndex: edge.modelIndex,
        depth: 0,
      });
    }

    return lines;
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

