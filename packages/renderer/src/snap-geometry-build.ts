/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The snap geometry cache of one mesh as a resumable build (#11504): the three
 * stages described in `snap-geometry-cache.ts` (weld, classify, merge runs),
 * each advanced in bounded `step`s so the idle pipeline can stop between them.
 * `buildGeometryCache` is this class run to completion, so a pick that needs a
 * cache now and an idle slice that builds it over many steps cannot disagree.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { Vec3 } from './raycaster.js';
import { snapToleranceFor, WeldBuild, type WeldedVertices } from './snap-weld.js';
import type { WeldedSegment } from './snap-edge-runs.js';
import { RunMergeBuild } from './snap-edge-merge.js';
import type { MeshGeometryCache } from './snap-geometry-cache.js';

/** Triangles one step classifies (three string-keyed map writes each) and edges one step tests. */
const TRIANGLE_CHUNK = 256;
const EDGE_CHUNK = 2048;

/** A build that advances in bounded steps. */
export interface StepBuild<T> {
  readonly done: boolean;
  /** Do one bounded piece of work; true once finished. */
  step(): boolean;
  /** The finished value; only valid once `step` returned true. */
  result(): T;
}

/** A finished build holding `value`, for something that was already cached. */
export function finishedBuild<T>(value: T): StepBuild<T> {
  return { done: true, step: () => true, result: () => value };
}

type Phase = 'weld' | 'triangles' | 'classify' | 'merge' | 'done';

export class GeometryCacheBuild implements StepBuild<MeshGeometryCache> {
  private phase: Phase = 'weld';
  private readonly positions: ArrayLike<number> | undefined;
  private readonly indices: ArrayLike<number> | undefined;
  private readonly tolerance: number = 0;
  private weld: WeldBuild | null = null;
  private welded: WeldedVertices | null = null;
  private next = 0;
  private readonly edgeData = new Map<string, { segment: WeldedSegment; normals: Vec3[] }>();
  private edgeList: Array<{ segment: WeldedSegment; normals: Vec3[] }> = [];
  private readonly segments: WeldedSegment[] = [];
  private merge: RunMergeBuild | null = null;
  private value: MeshGeometryCache | null = null;

  constructor(mesh: MeshData) {
    this.positions = mesh.positions;
    this.indices = mesh.indices;
    if (!this.positions || this.positions.length === 0) {
      this.value = { vertices: [], edges: [] };
      this.phase = 'done';
      return;
    }
    // Positions are stored in the element's local frame (world = origin + local).
    // Snap targets are compared against world-space raycast hit points, so the
    // cache is built in WORLD space by lifting every absolute vertex read by the
    // per-mesh origin. (Triangle-normal math uses position *differences*, where
    // the origin cancels, and the tolerance is derived from the LOCAL magnitudes.)
    const ox = mesh.origin ? mesh.origin[0] : 0;
    const oy = mesh.origin ? mesh.origin[1] : 0;
    const oz = mesh.origin ? mesh.origin[2] : 0;
    this.tolerance = snapToleranceFor(this.positions);
    this.weld = new WeldBuild(this.positions, ox, oy, oz, this.tolerance);
  }

  get done(): boolean { return this.phase === 'done'; }

  step(): boolean {
    switch (this.phase) {
      case 'weld': this.stepWeld(); break;
      case 'triangles': this.stepTriangles(); break;
      case 'classify': this.stepClassify(); break;
      case 'merge': this.stepMerge(); break;
      case 'done': break;
    }
    return this.phase === 'done';
  }

  result(): MeshGeometryCache { return this.value!; }

  private stepWeld(): void {
    if (!this.weld!.step()) return;
    this.welded = this.weld!.result();
    this.weld = null;
    if (!this.indices) {
      this.value = { vertices: this.welded.points, edges: [] };
      this.phase = 'done';
      return;
    }
    this.phase = 'triangles';
  }

  // Collect each welded edge with the normals of the triangles that use it.
  private stepTriangles(): void {
    const { positions, indices, edgeData } = this;
    const ids = this.welded!.ids;
    const end = Math.min(indices!.length, this.next + TRIANGLE_CHUNK * 3);
    for (let i = this.next; i < end; i += 3) {
      const normal = triangleNormal(positions!, indices!, i);
      // A degenerate triangle has no meaningful normal and its edges are junk;
      // letting one through would make a real crease read as coplanar.
      if (!normal) continue;

      const a = ids[indices![i]];
      const b = ids[indices![i + 1]];
      const c = ids[indices![i + 2]];
      if (a < 0 || b < 0 || c < 0) continue;
      // Welding can collapse a triangle even when its PRE-weld positions gave a
      // valid normal. Skipping only the collapsed edge is not enough: if a === b
      // then (b,c) and (c,a) are the SAME pair, so the survivor is registered
      // twice and receives two normals from one degenerate triangle. It then
      // reads as a two-manifold edge whose crease angle is computed against a
      // duplicate of itself, which can turn a boundary edge into a false crease.
      if (a === b || b === c || c === a) continue;

      for (const [idx0, idx1] of [[a, b], [b, c], [c, a]]) {
        const key = idx0 < idx1 ? `${idx0}_${idx1}` : `${idx1}_${idx0}`;
        const existing = edgeData.get(key);
        if (existing) existing.normals.push(normal);
        else edgeData.set(key, { segment: { a: idx0, b: idx1 }, normals: [normal] });
      }
    }
    this.next = end;
    if (end < indices!.length) return;
    this.edgeList = [...edgeData.values()];
    this.edgeData.clear();
    this.next = 0;
    this.phase = 'classify';
  }

  private stepClassify(): void {
    const end = Math.min(this.edgeList.length, this.next + EDGE_CHUNK);
    for (let i = this.next; i < end; i++) {
      if (isModelEdge(this.edgeList[i].normals)) this.segments.push(this.edgeList[i].segment);
    }
    this.next = end;
    if (end < this.edgeList.length) return;
    this.edgeList = [];
    this.merge = new RunMergeBuild(this.segments, this.welded!.points, this.tolerance);
    this.phase = 'merge';
  }

  private stepMerge(): void {
    if (!this.merge!.step()) return;
    this.value = { vertices: this.welded!.points, edges: this.merge!.result() };
    this.merge = null;
    this.welded = null;
    this.phase = 'done';
  }
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
