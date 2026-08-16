/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Geometry cache building for snap detection.
 *
 * Three stages, in order, because each one is what makes the next answerable:
 *
 * 1. WELD by position (`snap-weld.ts`). The wasm mesh is unwelded across
 *    creases, so classifying edges by vertex INDEX made every physical edge
 *    arrive twice with one adjacent triangle each — every edge looked like a
 *    boundary edge, the coplanarity test below could never fire, and the cache
 *    filled with triangulation diagonals (911 of 1755 distinct edges on
 *    `building-architecture.ifc`) that a user can snap to and measure.
 * 2. CLASSIFY: keep boundary and crease edges, drop the diagonals shared by two
 *    coplanar triangles.
 * 3. MERGE collinear runs (`snap-edge-runs.ts`), so a straight model edge that
 *    several triangles cross becomes ONE edge of the length the user sees.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { Vec3 } from './raycaster.js';
import { snapToleranceFor, weldVertices } from './snap-weld.js';
import { mergeCollinearRuns, type SnapEdge, type WeldedSegment } from './snap-edge-runs.js';

export type { SnapEdge } from './snap-edge-runs.js';

export interface MeshGeometryCache {
  vertices: Vec3[];
  edges: SnapEdge[];
}

/**
 * Dot-product threshold above which two triangles sharing an edge count as
 * coplanar, so their shared edge is an internal triangulation diagonal rather
 * than a model edge.
 *
 * NEAR-EXACT on purpose. Measured over every two-manifold welded edge of the
 * three committed samples (the `pnpm test:snap-edges` pipeline), the two
 * populations this constant separates do not overlap for five decades:
 *
 * - triangulation diagonals of flat faces sit at dot >= 1 - 8.1e-8, pure f32
 *   position noise (10k+ edges on building-architecture.ifc and
 *   infra-bridge.ifc);
 * - real creases sit at dot <= 1 - 3.66e-5 (0.49 degrees and steeper).
 *
 * 1 - 1e-6 sits between them: 12x above the diagonal noise floor, 36x below
 * the flattest measured crease (both in 1-dot terms). As an angle it is a
 * 0.081 degree cutoff, flatter than any slope BIM geometry encodes on purpose
 * (a 2% drainage fall is 1.15 degrees, a 0.5% minimum interior fall 0.29
 * degrees), so shallow real creases stay snappable. An earlier 0.98 cutoff
 * (~11.5 degrees) deleted them wholesale: 1093 real creases on
 * infra-bridge.ifc alone, among them a 3.500 m bridge-deck edge whose faces
 * meet at 3.617 degrees (IfcBuildingElementProxy #723) - and it cleared the
 * coarsest shipped circle facet (32 segments = 11.25 degrees, dot 0.98079) by
 * only 0.0008, so tessellated arcs kept their edges by luck.
 *
 * The trade is asymmetric and this errs on the KEEP side deliberately: a
 * sliver triangle noisier than the measured floor slips its diagonal under
 * the cutoff and adds a benign extra snap edge on a flat face, while a cutoff
 * low enough to chase such noise deletes real edges a user has to be able to
 * measure. Keeping more edges on curved geometry is the conservative
 * direction for snapping. Pinned from both sides by
 * `snap-geometry-cache.test.ts`.
 */
const COPLANAR_THRESHOLD = 1 - 1e-6;

const EMPTY_CACHE: MeshGeometryCache = { vertices: [], edges: [] };

/**
 * Build a geometry cache for a mesh: welded vertices plus reconstructed model
 * edges with their corner valences.
 */
export function buildGeometryCache(mesh: MeshData): MeshGeometryCache {
  const positions = mesh.positions;
  if (!positions || positions.length === 0) {
    return { ...EMPTY_CACHE };
  }

  // Positions are stored in the element's local frame (world = origin + local).
  // Snap targets are compared against world-space raycast hit points, so the
  // cache is built in WORLD space by lifting every absolute vertex read by the
  // per-mesh origin. (Triangle-normal math below uses position *differences*,
  // where the origin cancels — those reads are left untouched, and the
  // tolerance is likewise derived from the LOCAL magnitudes.)
  const ox = mesh.origin ? mesh.origin[0] : 0;
  const oy = mesh.origin ? mesh.origin[1] : 0;
  const oz = mesh.origin ? mesh.origin[2] : 0;

  const tolerance = snapToleranceFor(positions);
  const { ids, points } = weldVertices(positions, ox, oy, oz, tolerance);

  const indices = mesh.indices;
  if (!indices) {
    return { vertices: points, edges: [] };
  }

  // Collect each welded edge with the normals of the triangles that use it.
  const edgeData = new Map<string, { segment: WeldedSegment; normals: Vec3[] }>();

  for (let i = 0; i < indices.length; i += 3) {
    const normal = triangleNormal(positions, indices, i);
    // A degenerate triangle has no meaningful normal and its edges are junk;
    // letting one through would make a real crease read as coplanar.
    if (!normal) continue;

    const a = ids[indices[i]];
    const b = ids[indices[i + 1]];
    const c = ids[indices[i + 2]];
    if (a < 0 || b < 0 || c < 0) continue;

    for (const [idx0, idx1] of [[a, b], [b, c], [c, a]]) {
      if (idx0 === idx1) continue;
      const key = idx0 < idx1 ? `${idx0}_${idx1}` : `${idx1}_${idx0}`;
      const existing = edgeData.get(key);
      if (existing) existing.normals.push(normal);
      else edgeData.set(key, { segment: { a: idx0, b: idx1 }, normals: [normal] });
    }
  }

  const segments: WeldedSegment[] = [];
  for (const [, data] of edgeData) {
    if (isModelEdge(data.normals)) segments.push(data.segment);
  }

  return { vertices: points, edges: mergeCollinearRuns(segments, points, tolerance) };
}

/**
 * A model edge is one that is not flat: a boundary edge (a single adjacent
 * triangle), a non-manifold edge (three or more), or a crease where some pair
 * of adjacent triangles meets at more than the coplanar cutoff.
 *
 * `Math.abs` on the dot is deliberate: a mesh with inconsistent winding gives
 * coplanar neighbours a dot of -1, and without it every such diagonal would be
 * kept as a "crease".
 */
function isModelEdge(normals: Vec3[]): boolean {
  if (normals.length !== 2) return true;
  const [n1, n2] = normals;
  const dot = Math.abs(n1.x * n2.x + n1.y * n2.y + n1.z * n2.z);
  return dot <= COPLANAR_THRESHOLD;
}

/** Unit normal of triangle `i`, or null when the triangle is degenerate. */
function triangleNormal(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  i: number
): Vec3 | null {
  const i0 = indices[i] * 3;
  const i1 = indices[i + 1] * 3;
  const i2 = indices[i + 2] * 3;

  const ax = positions[i1] - positions[i0];
  const ay = positions[i1 + 1] - positions[i0 + 1];
  const az = positions[i1 + 2] - positions[i0 + 2];
  const bx = positions[i2] - positions[i0];
  const by = positions[i2 + 1] - positions[i0 + 1];
  const bz = positions[i2 + 2] - positions[i0 + 2];

  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;

  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (!(len > 0) || !isFinite(len)) return null;
  return { x: nx / len, y: ny / len, z: nz / len };
}
