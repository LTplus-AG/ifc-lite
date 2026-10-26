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

/**
 * Scale-relative floor for trusting the signed-volume winding test (issue
 * #2682).
 *
 * The silhouette test is NOT symmetric under a global winding flip: it keeps
 * an edge whose faces differ in "is front-facing", and the deadband lumps
 * perpendicular faces in with back-facing ones. For an outward-wound box in
 * plan that yields the TOP rim (the face pointing at the viewer against the
 * four perpendicular sides); flip the winding and the same test yields the
 * BOTTOM rim instead — the far side of the solid. Both project to the same
 * square, so the defect hides until the far rim falls outside the projection
 * band, at which point the line work is simply GONE (a blank sheet, produced
 * successfully). See `windingSign`.
 *
 * The fix orients the mesh by its signed volume before classifying, which is
 * only meaningful when the volume is decisively non-zero. An open shell or a
 * flat sheet integrates to ~0 and an inconsistently wound mesh to something
 * arbitrary, so the sign is only trusted when |V| clears this fraction of the
 * mesh's bounding-box volume (diagonal³). A closed box sits around 0.19 of
 * that; a 1 mm sheet spanning 4 m sits near 1e-4. 1e-6 is far below any real
 * solid and far above f32 integration noise.
 */
const WINDING_VOLUME_EPSILON = 1e-6;

/**
 * Vertex weld tolerance as a fraction of the mesh's largest LOCAL coordinate
 * magnitude (issue #8161): 2⁻²², i.e. two to four f32 ULPs at that
 * magnitude, the same scale factor `SectionCutter` applies to its plane-side
 * epsilon (#2622).
 *
 * Adjacency is matched by position, not by buffer index, because the geometry
 * pipeline emits flat-shaded solids with their vertices repeated per face; by
 * index, no two triangles of such a mesh share an edge. Duplicates of one
 * corner are bit-identical when they were rounded from the same f64 point, but
 * can differ in the last bits when they reached f32 along different paths, and
 * that noise scales with the magnitude of the stored values; so must the
 * tolerance:
 *  - `positions` are metres (unit scale applied in the Rust router) in the
 *    element's local frame; `origin` is a pure translation added in f64 that
 *    cannot move two duplicates apart, so it is left out of the magnitude, as
 *    in `SectionCutter`. A mesh without `origin` holds absolute world (or
 *    RTC) coordinates, and the tolerance grows with them: at 4e5 m one ULP is
 *    3 cm and a fixed sub-millimetre epsilon would weld nothing.
 *  - At small magnitudes the tolerance shrinks with the coordinates, so a
 *    50 µm detail near its frame's origin keeps its distinct corners, where
 *    any fixed building-scale epsilon would collapse it.
 * The cost: two genuinely distinct vertices closer than that (2.4 µm in a
 * mesh spanning ±10 m) are merged. The weld is greedy in buffer order, so a
 * chain of vertices each within tolerance of the next is not transitively
 * collapsed beyond the first representative's reach.
 */
const WELD_RELATIVE_TOLERANCE = 2 ** -22;

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

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
    const { positions, indices, expressId, ifcType, modelIndex, origin } = mesh;

    // Weld coincident vertices first (issue #8161): adjacency is keyed by the
    // weld representative, so per-face duplicates share their edges.
    const { rep, tolerance } = this.weldVertices(positions);

    // Build edge-to-face adjacency map
    const edgeMap = new Map<number, EdgeInfo>();
    const faceNormals: Vec3[] = [];
    const vertexCount = positions.length / 3;

    const triangleCount = Math.floor(indices.length / 3);

    // First pass: compute face normals and build edge adjacency
    for (let t = 0; t < triangleCount; t++) {
      const r0 = rep[indices[t * 3]];
      const r1 = rep[indices[t * 3 + 1]];
      const r2 = rep[indices[t * 3 + 2]];

      // A triangle that welds down to a segment or a point has no face.
      if (r0 === r1 || r1 === r2 || r2 === r0) continue;

      // Face normal from the triangle's own (welded) corners, in the LOCAL
      // frame: `origin` is a translation and cannot change a normal.
      const faceNormal = this.computeFaceNormal(positions, r0, r1, r2, tolerance);
      // Zero-area (collinear within tolerance) triangle: skip it rather than
      // let it register as a second face with a meaningless normal.
      if (!faceNormal) continue;

      const face = faceNormals.length;
      faceNormals.push(faceNormal);

      this.registerEdge(edgeMap, vertexCount, r0, r1, face);
      this.registerEdge(edgeMap, vertexCount, r1, r2, face);
      this.registerEdge(edgeMap, vertexCount, r2, r0, face);
    }

    // Orient the face normals OUTWARD before classification (issue #2682).
    // ifc-lite's winding is explicitly unreliable (see `MeshData.indices`), and
    // the silhouette test is winding-sensitive, so an inward-wound solid
    // silhouettes its far side and can lose its line work entirely. Negating
    // every normal is exactly what reversing every triangle does, so a mesh and
    // its reversed twin now classify identically. Crease classification is
    // unaffected: the dihedral angle between two normals is invariant under
    // negating both.
    if (this.windingSign(positions, indices) < 0) {
      for (let f = 0; f < faceNormals.length; f++) {
        const n = faceNormals[f];
        faceNormals[f] = vec3(-n.x, -n.y, -n.z);
      }
    }

    // Second pass: classify edges
    const edges: EdgeData[] = [];

    for (const [, edgeInfo] of edgeMap) {
      const v0 = this.getVertex(positions, edgeInfo.v0Idx, origin);
      const v1 = this.getVertex(positions, edgeInfo.v1Idx, origin);

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

      // Flip-adjusted depths at the clipped endpoints: signedDepth is affine
      // along the segment, so lerp d0/d1 by the clip parameters.
      const dA = d0 + (d1 - d0) * clip[0];
      const dB = d0 + (d1 - d0) * clip[1];

      lines.push({
        line: { start, end },
        category: 'projection',
        visibility,
        entityId: edge.entityId,
        ifcType: edge.ifcType,
        modelIndex: edge.modelIndex,
        // Per-endpoint VIEW depth (issue #2639, see projection-bands.ts):
        // negated flip-adjusted depth, clamped at the cut plane. The
        // classifier lerps depth..depthEnd along the line.
        depth: Math.max(0, -dA),
        depthEnd: Math.max(0, -dB),
      });
    }

    return lines;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  private getVertex(
    positions: Float32Array,
    index: number,
    origin?: [number, number, number],
  ): Vec3 {
    const base = index * 3;
    return origin
      ? vec3(
          positions[base] + origin[0],
          positions[base + 1] + origin[1],
          positions[base + 2] + origin[2],
        )
      : vec3(positions[base], positions[base + 1], positions[base + 2]);
  }

  /**
   * `-1` when the mesh is a closed solid wound INWARD, `+1` otherwise
   * (issue #2682).
   *
   * Six times the enclosed signed volume is `Σ v0 · (v1 × v2)`, positive for
   * outward winding. It is translation-invariant for a closed mesh, so the sum
   * is taken relative to the first vertex to keep the terms small and the
   * cancellation honest on RTC-shifted coordinates.
   *
   * `+1` is the deliberate answer whenever the test is inconclusive — an open
   * shell, a flat sheet, or an inconsistently wound mesh integrates to ~0 (or
   * to an arbitrary number) and gets the pre-existing behaviour rather than a
   * coin-flip reorientation. Positions are read directly rather than through
   * `getVertex` because the per-element `origin` is a pure translation and
   * therefore cannot change the result.
   */
  private windingSign(positions: Float32Array, indices: Uint32Array): 1 | -1 {
    const triangleCount = Math.floor(indices.length / 3);
    if (triangleCount === 0 || positions.length < 3) return 1;

    const rx = positions[indices[0] * 3];
    const ry = positions[indices[0] * 3 + 1];
    const rz = positions[indices[0] * 3 + 2];

    let volume6 = 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    const track = (x: number, y: number, z: number): void => {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    };

    for (let t = 0; t < triangleCount; t++) {
      const b0 = indices[t * 3] * 3;
      const b1 = indices[t * 3 + 1] * 3;
      const b2 = indices[t * 3 + 2] * 3;

      const ax = positions[b0] - rx, ay = positions[b0 + 1] - ry, az = positions[b0 + 2] - rz;
      const bx = positions[b1] - rx, by = positions[b1 + 1] - ry, bz = positions[b1 + 2] - rz;
      const cx = positions[b2] - rx, cy = positions[b2 + 1] - ry, cz = positions[b2 + 2] - rz;

      // a · (b × c)
      volume6 += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);

      track(ax, ay, az);
      track(bx, by, bz);
      track(cx, cy, cz);
    }

    const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
    const diagonal = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const floor = WINDING_VOLUME_EPSILON * diagonal * diagonal * diagonal;

    return volume6 / 6 < -floor ? -1 : 1;
  }

  /**
   * Weld coincident vertices (issue #8161). Returns, for every vertex, the
   * index of its weld representative: the FIRST vertex in buffer order within
   * `tolerance` (per axis) of it, so output coordinates are deterministic and
   * are always a real vertex position, never an average.
   *
   * Vertices are bucketed on a grid of cell size `tolerance`. Two positions
   * within tolerance can straddle a cell boundary, so a vertex that finds no
   * representative in its own cell also searches the 26 neighbouring cells,
   * which together cover every position within tolerance of it. Cells are
   * keyed by an integer hash and every candidate is distance-checked, so a
   * hash collision costs a comparison, never a wrong weld. Linear in the
   * vertex count; the common exact-duplicate case is one lookup.
   */
  private weldVertices(positions: Float32Array): { rep: Uint32Array; tolerance: number } {
    const vertexCount = Math.floor(positions.length / 3);
    let maxAbs = 0;
    for (let i = 0; i < vertexCount * 3; i++) {
      const a = Math.abs(positions[i]);
      if (a > maxAbs) maxAbs = a;
    }
    const tolerance = maxAbs * WELD_RELATIVE_TOLERANCE;
    // With a zero tolerance (all-zero positions) only exact matches weld; any
    // positive cell size keeps those in one cell.
    const cell = tolerance > 0 ? tolerance : 1;

    const rep = new Uint32Array(vertexCount);
    const buckets = new Map<number, number[]>();
    const hash = (ix: number, iy: number, iz: number): number =>
      Math.imul(ix | 0, 73856093) ^ Math.imul(iy | 0, 19349663) ^ Math.imul(iz | 0, 83492791);
    const find = (ix: number, iy: number, iz: number, x: number, y: number, z: number): number => {
      const bucket = buckets.get(hash(ix, iy, iz));
      if (!bucket) return -1;
      for (const r of bucket) {
        const b = r * 3;
        if (
          Math.abs(positions[b] - x) <= tolerance &&
          Math.abs(positions[b + 1] - y) <= tolerance &&
          Math.abs(positions[b + 2] - z) <= tolerance
        ) {
          return r;
        }
      }
      return -1;
    };

    for (let i = 0; i < vertexCount; i++) {
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];
      const ix = Math.floor(x / cell);
      const iy = Math.floor(y / cell);
      const iz = Math.floor(z / cell);

      let found = find(ix, iy, iz, x, y, z);
      for (let dx = -1; dx <= 1 && found < 0; dx++) {
        for (let dy = -1; dy <= 1 && found < 0; dy++) {
          for (let dz = -1; dz <= 1 && found < 0; dz++) {
            if (dx === 0 && dy === 0 && dz === 0) continue;
            found = find(ix + dx, iy + dy, iz + dz, x, y, z);
          }
        }
      }

      if (found >= 0) {
        rep[i] = found;
      } else {
        rep[i] = i;
        const key = hash(ix, iy, iz);
        const bucket = buckets.get(key);
        if (bucket) bucket.push(i);
        else buckets.set(key, [i]);
      }
    }
    return { rep, tolerance };
  }

  /**
   * Unit normal of triangle (a, b, c) from LOCAL positions, or `null` when the
   * triangle is degenerate: its height over the longest side is within the
   * weld tolerance (collinear as far as the weld can tell), or exactly zero.
   */
  private computeFaceNormal(
    positions: Float32Array,
    a: number,
    b: number,
    c: number,
    tolerance: number,
  ): Vec3 | null {
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
    const e1x = positions[b * 3] - ax, e1y = positions[b * 3 + 1] - ay, e1z = positions[b * 3 + 2] - az;
    const e2x = positions[c * 3] - ax, e2y = positions[c * 3 + 1] - ay, e2z = positions[c * 3 + 2] - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len === 0) return null;

    const e3x = e2x - e1x, e3y = e2y - e1y, e3z = e2z - e1z;
    const longest = Math.sqrt(
      Math.max(e1x * e1x + e1y * e1y + e1z * e1z, e2x * e2x + e2y * e2y + e2z * e2z, e3x * e3x + e3y * e3y + e3z * e3z),
    );
    // |n| = 2 · area = longest · height.
    if (len <= longest * tolerance) return null;

    return vec3(nx / len, ny / len, nz / len);
  }

  private registerEdge(
    edgeMap: Map<number, EdgeInfo>,
    vertexCount: number,
    rep0: number,
    rep1: number,
    faceIndex: number
  ): void {
    // Canonical key over weld representatives (smaller first). Exact for any
    // vertex count below 2^26.5, far beyond a single element's mesh.
    const minIdx = Math.min(rep0, rep1);
    const maxIdx = Math.max(rep0, rep1);
    const key = minIdx * vertexCount + maxIdx;

    let info = edgeMap.get(key);
    if (!info) {
      info = { v0Idx: minIdx, v1Idx: maxIdx, faceIndices: [] };
      edgeMap.set(key, info);
    }
    info.faceIndices.push(faceIndex);
  }
}
