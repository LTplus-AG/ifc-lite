/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The snap geometry a section actually leaves on screen (#8659): mesh edges
 * trimmed to the kept half-spaces, plus the cut contour where each plane crosses
 * the mesh, which the GPU never reports back as snap geometry.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { Intersection, Ray, Vec3 } from './raycaster.js';
import { clipHalfSpaces, clipSegmentInterval, type ClipHalfSpace } from './clip-half-spaces.js';
import type { PickClipState } from './pick-types.js';
import { clipIsActive } from './scene-raycaster.js';
import { entityClip } from './section-exclusions.js';
import type { MeshGeometryCache } from './snap-geometry-cache.js';
import { MIN_CORNER_VALENCE, mergeCollinearRuns, type SnapEdge, type WeldedSegment } from './snap-edge-runs.js';
import { snapToleranceFor, weldVertices } from './snap-weld.js';

/** One plane's cross-section of a mesh. */
interface MeshCut {
  plane: ClipHalfSpace;
  /** World-space segment endpoints, `[ax, ay, az, bx, by, bz, ...]`. */
  segments: Float64Array;
  /** Every contour vertex meets an even number of segments: only closed loops bound a filled face. */
  closed: boolean;
}

export interface ClippedGeometryCache extends MeshGeometryCache {
  cuts: MeshCut[];
  tolerance: number;
}

/** The half-spaces clipping entity `id`, empty when it is exempt or nothing clips. */
export function planesFor(id: number, clip?: PickClipState | null): ClipHalfSpace[] {
  const entity = entityClip(clip, id);
  return entity && clipIsActive(entity) ? clipHalfSpaces(entity) : [];
}

export function planesKey(planes: readonly ClipHalfSpace[]): string {
  return planes.map((p) => `${p.n[0]},${p.n[1]},${p.n[2]},${p.limit},${p.capped}`).join(';');
}

/** Views kept at once; a moved plane leaves its old keys behind. */
const MAX_VIEWS = 256;

/** Section views of the snap cache, by clip + mesh key. */
export class ClippedGeometryViews {
  private views = new Map<string, ClippedGeometryCache>();

  get(mesh: MeshData, meshKey: string, base: MeshGeometryCache, planes: readonly ClipHalfSpace[]): ClippedGeometryCache {
    const key = `${planesKey(planes)}|${meshKey}`;
    let view = this.views.get(key);
    if (!view) {
      if (this.views.size >= MAX_VIEWS) this.views.clear();
      view = buildClippedGeometryCache(mesh, base, planes);
      this.views.set(key, view);
    }
    return view;
  }

  clear(): void {
    this.views.clear();
  }
}

const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t,
});

function keeps(planes: readonly ClipHalfSpace[], p: Vec3, tol: number): boolean {
  return planes.every(({ n, limit }) => p.x * n[0] + p.y * n[1] + p.z * n[2] - limit <= tol);
}

/** The edge's kept part, with its junctions re-parameterised; a trimmed end meets the contour, so it is a corner. */
function clipEdge(edge: SnapEdge, planes: readonly ClipHalfSpace[], tol: number, out: SnapEdge[]): void {
  const interval = clipSegmentInterval(edge.v0, edge.v1, planes, tol);
  if (!interval) return;
  const [low, high] = interval;
  const span = high - low;
  if (span * edge.length <= tol) return;
  if (span === 1) {
    out.push({ ...edge, index: out.length });
    return;
  }
  out.push({
    v0: low > 0 ? lerp(edge.v0, edge.v1, low) : edge.v0,
    v1: high < 1 ? lerp(edge.v0, edge.v1, high) : edge.v1,
    index: out.length,
    length: edge.length * span,
    v0Valence: low > 0 ? MIN_CORNER_VALENCE : edge.v0Valence,
    v1Valence: high < 1 ? MIN_CORNER_VALENCE : edge.v1Valence,
    junctions: edge.junctions
      .filter((j) => j.t > low && j.t < high)
      .map((j) => ({ ...j, t: (j.t - low) / span })),
  });
}

/** Triangle-plane crossings in the mesh's local frame. A vertex on the plane counts as kept, so a triangle yields at most one segment. */
function crossSection(mesh: MeshData, plane: ClipHalfSpace, ox: number, oy: number, oz: number): number[] {
  const { positions, indices } = mesh;
  const coords: number[] = [];
  if (!indices) return coords;
  const [nx, ny, nz] = plane.n;
  const limit = plane.limit - (nx * ox + ny * oy + nz * oz);
  const d = (v: number) => positions[v * 3] * nx + positions[v * 3 + 1] * ny + positions[v * 3 + 2] * nz - limit;
  const cross = (a: number, da: number, b: number, db: number) => {
    const t = da / (da - db);
    for (let axis = 0; axis < 3; axis++) {
      coords.push(positions[a * 3 + axis] + (positions[b * 3 + axis] - positions[a * 3 + axis]) * t);
    }
  };
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    const da = d(a), db = d(b), dc = d(c);
    if ((da > 0) === (db > 0) && (db > 0) === (dc > 0)) continue;
    // Rotate so `a` is alone on its side of the plane.
    if ((da > 0) !== (db > 0) && (da > 0) !== (dc > 0)) { cross(a, da, b, db); cross(a, da, c, dc); }
    else if ((db > 0) !== (da > 0)) { cross(b, db, a, da); cross(b, db, c, dc); }
    else { cross(c, dc, a, da); cross(c, dc, b, db); }
  }
  return coords;
}

/** Trim `base` to what `planes` keep and add each plane's cut contour. */
export function buildClippedGeometryCache(
  mesh: MeshData, base: MeshGeometryCache, planes: readonly ClipHalfSpace[],
): ClippedGeometryCache {
  const tolerance = snapToleranceFor(mesh.positions);
  const ox = mesh.origin ? mesh.origin[0] : 0;
  const oy = mesh.origin ? mesh.origin[1] : 0;
  const oz = mesh.origin ? mesh.origin[2] : 0;

  const edges: SnapEdge[] = [];
  for (const edge of base.edges) clipEdge(edge, planes, tolerance, edges);
  const vertices = base.vertices.filter((p) => keeps(planes, p, tolerance));
  const cuts: MeshCut[] = [];

  planes.forEach((plane, planeIndex) => {
    const coords = crossSection(mesh, plane, ox, oy, oz);
    if (coords.length === 0) return;
    const segments = new Float64Array(coords.length);
    for (let i = 0; i < coords.length; i += 3) {
      segments[i] = coords[i] + ox;
      segments[i + 1] = coords[i + 1] + oy;
      segments[i + 2] = coords[i + 2] + oz;
    }

    const { ids, points } = weldVertices(coords, ox, oy, oz, tolerance);
    const welded: WeldedSegment[] = [];
    const degree = new Uint32Array(points.length);
    for (let i = 0; i + 1 < ids.length; i += 2) {
      if (ids[i] < 0 || ids[i + 1] < 0 || ids[i] === ids[i + 1]) continue;
      welded.push({ a: ids[i], b: ids[i + 1] });
      degree[ids[i]]++;
      degree[ids[i + 1]]++;
    }
    cuts.push({ plane, segments, closed: degree.every((count) => count % 2 === 0) });
    // The contour sits on its own plane; only the others can trim it.
    const others = planes.filter((_, i) => i !== planeIndex);
    const contour: SnapEdge[] = [];
    for (const run of mergeCollinearRuns(welded, points, tolerance)) clipEdge(run, others, tolerance, contour);
    for (const edge of contour) {
      edges.push({ ...edge, index: edges.length });
      vertices.push(edge.v0, edge.v1);
    }
  });

  return { vertices, edges, cuts, tolerance };
}

/** Even-odd containment in the plane: is `p` inside this mesh's cross-section? */
function insideCut(cut: MeshCut, p: Vec3): boolean {
  const [nx, ny, nz] = cut.plane.n;
  // Project along the dominant normal axis: a planar polygon stays a polygon.
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  const drop = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
  const u = drop === 0 ? 1 : 0, v = drop === 2 ? 1 : 2;
  const pu = u === 0 ? p.x : p.y, pv = v === 1 ? p.y : p.z;
  const s = cut.segments;
  let inside = false;
  for (let i = 0; i + 5 < s.length; i += 6) {
    const au = s[i + u], av = s[i + v], bu = s[i + 3 + u], bv = s[i + 3 + v];
    if ((av > pv) !== (bv > pv) && pu < au + ((pv - av) / (bv - av)) * (bu - au)) inside = !inside;
  }
  return inside;
}

/**
 * The drawn cut face this ray reaches before `hit`, as a hit of its own. Without
 * it a ray over a cap hits the inside of the solid behind the cap, so the measured
 * point lands at a depth nothing on screen shows and the contour is out of reach.
 * Containment rather than back-face testing: IFC winding is not reliably outward.
 */
export function cutCapIntersection(
  ray: Ray, view: ClippedGeometryCache, planes: readonly ClipHalfSpace[], hit: Intersection,
): Intersection | null {
  const { origin, direction } = ray;
  for (const cut of view.cuts) {
    const { n, limit, capped } = cut.plane;
    if (!capped || !cut.closed) continue;
    const slope = direction.x * n[0] + direction.y * n[1] + direction.z * n[2];
    if (slope >= -1e-12) continue;
    const distance = (limit - (origin.x * n[0] + origin.y * n[1] + origin.z * n[2])) / slope;
    if (distance <= 0 || distance >= hit.distance) continue;
    const point = {
      x: origin.x + direction.x * distance,
      y: origin.y + direction.y * distance,
      z: origin.z + direction.z * distance,
    };
    if (!keeps(planes, point, view.tolerance) || !insideCut(cut, point)) continue;
    const { sourceTriangleIndex: _hiddenTriangle, ...rest } = hit;
    return { ...rest, point, distance, normal: { x: n[0], y: n[1], z: n[2] }, cutCap: true };
  }
  return null;
}
