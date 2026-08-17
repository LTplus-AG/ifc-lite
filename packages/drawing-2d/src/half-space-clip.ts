/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CPU half-space clipping of render meshes, for exporting a sectioned 3D
 * viewport to a to-scale vector PDF (issue #2042).
 *
 * The on-screen section plane is a GPU clip: the fragment shader discards
 * pixels, and no geometry ever changes. An exported drawing has no fragment
 * stage, so the same cut has to be applied to the triangles themselves —
 * otherwise the PDF shows the whole model while the screen shows half of it.
 *
 * # Defect class this module guards against
 * **The `MeshData.origin` double-fold** (and its mirror, the un-folded
 * comparison). `positions` are stored in the element's LOCAL frame, with
 * `world = origin + local`; `origin` exists purely so building-scale
 * coordinates survive f32. A half-space test is defined in WORLD space, so a
 * naive implementation either
 *
 *   1. tests LOCAL positions against a WORLD offset — clipping a wall 100 m
 *      from the model origin at completely the wrong place, or
 *   2. bakes world coordinates back into `positions` and leaves `origin`
 *      set — folding the offset in twice and translating the element by
 *      `origin` again downstream.
 *
 * Both produce a drawing that looks like geometry and is in the wrong
 * place. This module converts the plane ONCE into the mesh's local frame
 * (`localOffset = offset − dot(origin, normal)`), leaves every emitted
 * position local, and carries `origin` through untouched — so a mesh with an
 * `origin` and a baked-positions twin of the same element clip to the same
 * world result.
 *
 * The kept half is `dot(worldPoint, normal) <= offset` (the side the normal
 * points AWAY from). `rimSegments` are the new edges created on the cut
 * plane, returned in WORLD space so they can be projected straight into
 * drawing lines (see `world-line-seeds.ts`).
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { Vec3 } from './types.js';
import { vec3Length } from './math.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/** A world-space 3D segment created by the cut. */
export interface WorldSegment {
  start: Vec3;
  end: Vec3;
  /** Source element, carried so the drawing can style/filter the rim. */
  entityId: number;
  ifcType: string;
  modelIndex: number;
}

export interface HalfSpaceClipResult {
  /**
   * The clipped mesh, or `null` when no triangle survived. When NOTHING was
   * cut or dropped this is the INPUT mesh by reference (no copy) — the
   * common case for a model where only a handful of elements straddle the
   * plane.
   */
  mesh: MeshData | null;
  /** New edges on the cut plane, world space. Empty when nothing was cut. */
  rimSegments: WorldSegment[];
}

export interface HalfSpaceClipBatchResult {
  /** Surviving meshes, in input order; fully-clipped meshes are omitted. */
  meshes: MeshData[];
  rimSegments: WorldSegment[];
}

/** One polygon corner during clipping — LOCAL position + its attributes. */
interface ClipVertex {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  entityId: number;
  /** Signed distance to the plane in the local frame (negative = kept). */
  d: number;
}

const MIN_NORMAL_LENGTH = 1e-12;

// ═══════════════════════════════════════════════════════════════════════════
// SINGLE MESH
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Clip one mesh to the half-space `dot(worldPoint, normal) <= offset`.
 *
 * @param normal Plane normal (world). Need not be unit — it is normalised
 *        internally, and `offset` is rescaled with it, so the half-space is
 *        the same set either way.
 * @param offset Plane offset: `dot(pointOnPlane, normal)`.
 *
 * @throws when `normal` is (numerically) the zero vector — that defines no
 *         half-space at all, and silently keeping everything would print a
 *         model the screen is showing cut.
 */
export function clipMeshToHalfSpace(
  mesh: MeshData,
  normal: Vec3,
  offset: number,
): HalfSpaceClipResult {
  const len = vec3Length(normal);
  if (!Number.isFinite(len) || len < MIN_NORMAL_LENGTH) {
    throw new Error('Cannot clip to a half-space with a zero-length or non-finite normal.');
  }
  if (!Number.isFinite(offset)) {
    throw new Error('Cannot clip to a half-space with a non-finite offset.');
  }
  const nx = normal.x / len;
  const ny = normal.y / len;
  const nz = normal.z / len;
  const worldOffset = offset / len;

  const { positions, normals, indices, origin, entityIds } = mesh;
  const ox = origin ? origin[0] : 0;
  const oy = origin ? origin[1] : 0;
  const oz = origin ? origin[2] : 0;

  // The plane, expressed once in this mesh's LOCAL frame. This is the whole
  // point of the module: every comparison and every emitted coordinate below
  // stays local, and `origin` is never folded into `positions`.
  const localOffset = worldOffset - (ox * nx + oy * ny + oz * nz);

  const vertexCount = Math.floor(positions.length / 3);
  const planeEps = planeEpsilonFor(positions, vertexCount);

  const outPositions: number[] = [];
  const outNormals: number[] = [];
  const outEntityIds: number[] = [];
  const rimSegments: WorldSegment[] = [];

  const entityId = mesh.expressId;
  const ifcType = mesh.ifcType ?? 'Unknown';
  const modelIndex = mesh.modelIndex ?? 0;
  const hasNormals = normals.length >= positions.length;

  const triangleCount = Math.floor(indices.length / 3);
  let modified = false;

  const poly: ClipVertex[] = [];
  const clipped: ClipVertex[] = [];

  for (let t = 0; t < triangleCount; t++) {
    poly.length = 0;
    let inside = 0;
    for (let k = 0; k < 3; k++) {
      const idx = indices[t * 3 + k];
      const base = idx * 3;
      const x = positions[base];
      const y = positions[base + 1];
      const z = positions[base + 2];
      const d = x * nx + y * ny + z * nz - localOffset;
      if (d <= planeEps) inside++;
      poly.push({
        x,
        y,
        z,
        nx: hasNormals ? normals[base] : 0,
        ny: hasNormals ? normals[base + 1] : 0,
        nz: hasNormals ? normals[base + 2] : 0,
        entityId: entityIds ? entityIds[idx] : entityId,
        d,
      });
    }

    if (inside === 3) {
      // Fully kept — emit verbatim.
      for (const v of poly) pushVertex(outPositions, outNormals, outEntityIds, v);
      continue;
    }

    modified = true;
    if (inside === 0) continue; // fully dropped

    // ── Sutherland–Hodgman against the single kept half-space ────────────
    clipped.length = 0;
    const newVertices: ClipVertex[] = [];
    for (let k = 0; k < 3; k++) {
      const cur = poly[k];
      const nxt = poly[(k + 1) % 3];
      const curIn = cur.d <= planeEps;
      const nxtIn = nxt.d <= planeEps;
      if (curIn) clipped.push(cur);
      if (curIn !== nxtIn) {
        const denom = cur.d - nxt.d;
        // `curIn !== nxtIn` means the two distances straddle the plane, so
        // the denominator cannot be zero; clamp anyway rather than emit NaN.
        const s = Math.abs(denom) < Number.EPSILON ? 0 : cur.d / denom;
        const cut = lerpVertex(cur, nxt, Math.min(1, Math.max(0, s)));
        clipped.push(cut);
        newVertices.push(cut);
      }
    }

    // Fan-triangulate the clipped polygon (convex by construction: a convex
    // triangle intersected with a half-space).
    for (let k = 1; k + 1 < clipped.length; k++) {
      const a = clipped[0];
      const b = clipped[k];
      const c = clipped[k + 1];
      if (isDegenerate(a, b, c)) continue;
      pushVertex(outPositions, outNormals, outEntityIds, a);
      pushVertex(outPositions, outNormals, outEntityIds, b);
      pushVertex(outPositions, outNormals, outEntityIds, c);
    }

    // The cut edge is the segment between the two intersection points a
    // triangle-vs-plane crossing produces. Exactly two is the only case that
    // yields a real edge; zero (a triangle merely touching the plane at one
    // vertex) contributes nothing to the rim outline.
    if (newVertices.length === 2) {
      const [a, b] = newVertices;
      const start = { x: a.x + ox, y: a.y + oy, z: a.z + oz };
      const end = { x: b.x + ox, y: b.y + oy, z: b.z + oz };
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const dz = end.z - start.z;
      // A triangle that merely TOUCHES the plane with one vertex produces two
      // coincident intersection points; that is a point, not an edge, and
      // emitting it would litter the rim outline with zero-length segments.
      if (dx * dx + dy * dy + dz * dz > planeEps * planeEps) {
        rimSegments.push({ start, end, entityId, ifcType, modelIndex });
      }
    }
  }

  if (!modified) {
    // Nothing straddled or fell outside: hand back the identical mesh so the
    // caller keeps vertex sharing (and any attribute this module drops).
    return { mesh, rimSegments: [] };
  }

  if (outPositions.length === 0) {
    return { mesh: null, rimSegments };
  }

  return { mesh: rebuildMesh(mesh, outPositions, outNormals, outEntityIds), rimSegments };
}

// ═══════════════════════════════════════════════════════════════════════════
// BATCH
// ═══════════════════════════════════════════════════════════════════════════

/** Clip every mesh, dropping the ones that vanish and pooling the rim. */
export function clipMeshesToHalfSpace(
  meshes: readonly MeshData[],
  normal: Vec3,
  offset: number,
): HalfSpaceClipBatchResult {
  const kept: MeshData[] = [];
  const rimSegments: WorldSegment[] = [];
  for (const mesh of meshes) {
    const result = clipMeshToHalfSpace(mesh, normal, offset);
    if (result.mesh) kept.push(result.mesh);
    // Appended one at a time, NOT `push(...result.rimSegments)`: a whole-model
    // clip can produce far more rim segments than the engine's maximum argument
    // count, and the spread form fails with a RangeError exactly on the large
    // models this export exists for.
    for (const segment of result.rimSegments) rimSegments.push(segment);
  }
  return { meshes: kept, rimSegments };
}

// ═══════════════════════════════════════════════════════════════════════════
// INTERNALS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Plane-coincidence tolerance sized to the mesh's own LOCAL coordinate
 * magnitude times the f32 ULP term (`2⁻²²`) used elsewhere in this repo.
 * Measuring it on local (not world) coordinates matters for the same reason
 * `CutSegment.localMaxCoord` does (#2622): f32 quantisation happens in the
 * local frame, so a small element at a large `origin` must not inherit a
 * tolerance scaled to its distance from the model origin.
 */
function planeEpsilonFor(positions: Float32Array, vertexCount: number): number {
  let maxAbs = 0;
  const limit = vertexCount * 3;
  for (let i = 0; i < limit; i++) {
    const a = Math.abs(positions[i]);
    if (a > maxAbs) maxAbs = a;
  }
  return Math.max(1e-9, maxAbs * 2 ** -22);
}

function lerpVertex(a: ClipVertex, b: ClipVertex, s: number): ClipVertex {
  return {
    x: a.x + (b.x - a.x) * s,
    y: a.y + (b.y - a.y) * s,
    z: a.z + (b.z - a.z) * s,
    nx: a.nx + (b.nx - a.nx) * s,
    ny: a.ny + (b.ny - a.ny) * s,
    nz: a.nz + (b.nz - a.nz) * s,
    // Entity ids are per-ELEMENT, so both endpoints of any edge of one
    // triangle carry the same id; taking the start's is exact, not a guess.
    entityId: a.entityId,
    d: 0,
  };
}

function isDegenerate(a: ClipVertex, b: ClipVertex, c: ClipVertex): boolean {
  const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
  const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  return cx * cx + cy * cy + cz * cz === 0;
}

function pushVertex(
  outPositions: number[],
  outNormals: number[],
  outEntityIds: number[],
  v: ClipVertex,
): void {
  outPositions.push(v.x, v.y, v.z);
  outNormals.push(v.nx, v.ny, v.nz);
  outEntityIds.push(v.entityId);
}

/**
 * Assemble the clipped mesh. Fields are carried over EXPLICITLY rather than
 * spread, because clipping invalidates several of them and silently passing
 * a stale one on is exactly the kind of field-migration bug a blanket spread
 * hides: `localBounds`, `geometryAabb`, `geometryVolume` and `geometryHash`
 * all describe the WHOLE, uncut element, and `uvs`/`texture*` are per-vertex
 * data the re-tessellated vertex buffer no longer matches. Line drawings
 * consume none of them, so they are dropped rather than fabricated.
 */
function rebuildMesh(
  source: MeshData,
  outPositions: number[],
  outNormals: number[],
  outEntityIds: number[],
): MeshData {
  const vertexCount = outPositions.length / 3;
  const indices = new Uint32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) indices[i] = i;

  const clippedMesh: MeshData = {
    expressId: source.expressId,
    positions: new Float32Array(outPositions),
    normals: new Float32Array(outNormals),
    indices,
    color: source.color,
  };
  if (source.ifcType !== undefined) clippedMesh.ifcType = source.ifcType;
  if (source.modelIndex !== undefined) clippedMesh.modelIndex = source.modelIndex;
  if (source.shadingColor !== undefined) clippedMesh.shadingColor = source.shadingColor;
  // `origin` is carried through UNCHANGED and `positions` stay local: the
  // whole no-double-fold contract of this module.
  if (source.origin !== undefined) clippedMesh.origin = source.origin;
  if (source.geometryClass !== undefined) clippedMesh.geometryClass = source.geometryClass;
  if (source.occurrenceKey !== undefined) clippedMesh.occurrenceKey = source.occurrenceKey;
  if (source.localToWorld !== undefined) clippedMesh.localToWorld = source.localToWorld;
  if (source.entityIds !== undefined) clippedMesh.entityIds = new Uint32Array(outEntityIds);
  return clippedMesh;
}
