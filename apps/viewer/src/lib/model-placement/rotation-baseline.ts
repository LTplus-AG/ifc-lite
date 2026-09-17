/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The PRISTINE copy a model rotation restores before it applies an angle,
 * and everything that keeps that copy true as the model changes underneath
 * it: capture, growth as batches stream in, an RTC re-frame, and the restore
 * itself. The turn that is applied on top lives in `rotation-geometry.ts`.
 *
 * Owns everything the bake can be asked to put back, and owns it by COPY: a
 * snapshot that shares an array with the live geometry is rewritten by the
 * next in-place edit, which turns the restore into an undetectable no-op.
 * That is the failure `federationRealign.capturePreAlignment` documents at
 * length, and this is the same rule.
 */

import type { EntityWorldAabb, GeometryResult, MeshData, Vec3 } from '@ifc-lite/geometry';
import { rebaseOriginByRtcDelta } from '@ifc-lite/geometry/rtc-rebase';
import { totalYupOffset } from '../geo/coordinate-frame.js';

export type Geometry = Pick<GeometryResult, 'meshes' | 'coordinateInfo' | 'instancedGeometryAabbs'>;

/**
 * The pristine geometry a bake restores before applying an angle.
 *
 * Owns everything the bake can be asked to put back, and owns it by COPY: a
 * snapshot that shares an array with the live geometry is rewritten by the next
 * in-place edit, which turns the restore into an undetectable no-op. That is
 * the failure `federationRealign.capturePreAlignment` documents at length, and
 * this is the same rule.
 */
export interface MeshBaseline {
  positions: Float32Array;
  normals: Float32Array | undefined;
  origin: [number, number, number] | undefined;
  localToWorld: number[] | undefined;
  // Boxes are REPLACED by the bake below, never mutated, so sharing the
  // objects is sound at the same depth `capturePreAlignment` shares them.
  geometryAabb: EntityWorldAabb | undefined;
}

export interface RotationBaseline {
  /**
   * Keyed by MESH IDENTITY, not by index. Streaming appends meshes to the live
   * array (`appendGeometryBatch`), so after a bake the array can hold already
   * rotated meshes and pristine new ones at once. Identity keys let a mesh that
   * was baked keep its own pristine bytes and a mesh that has never been baked
   * be recognised as pristine, which is what makes applying the declared
   * ABSOLUTE angle to a mixed array land every mesh in the same place.
   */
  meshes: Map<MeshData, MeshBaseline>;
  instancedGeometryAabbs: Map<number, EntityWorldAabb> | undefined;
  /** The map object the last bake left on the geometry. Anything else there
   * was installed from outside (streaming completion) and is pristine. */
  bakedInstanced: Map<number, EntityWorldAabb> | undefined;
  shiftedBounds: GeometryResult['coordinateInfo']['shiftedBounds'];
}

function captureMesh(mesh: MeshData): MeshBaseline {
  return {
    positions: new Float32Array(mesh.positions),
    normals: mesh.normals && mesh.normals.length > 0 ? new Float32Array(mesh.normals) : undefined,
    origin: mesh.origin ? [...mesh.origin] : undefined,
    localToWorld: mesh.localToWorld ? [...mesh.localToWorld] : undefined,
    geometryAabb: mesh.geometryAabb,
  };
}

export function captureRotationBaseline(geometry: Geometry): RotationBaseline {
  const meshes = new Map<MeshData, MeshBaseline>();
  for (const mesh of geometry.meshes) meshes.set(mesh, captureMesh(mesh));
  return {
    meshes,
    instancedGeometryAabbs: geometry.instancedGeometryAabbs
      ? new Map(geometry.instancedGeometryAabbs) : undefined,
    bakedInstanced: geometry.instancedGeometryAabbs,
    shiftedBounds: structuredClone(geometry.coordinateInfo.shiftedBounds),
  };
}

/**
 * Take a baseline of anything in `geometry` this baseline has never seen — a
 * streamed batch appended after the model was baked. Such a mesh is pristine by
 * construction: nothing has rotated it yet.
 *
 * @returns true when at least one mesh was new, i.e. a re-bake is owed even
 *   though the declared angle has not changed.
 */
export function captureAppendedMeshBaselines(geometry: Geometry, baseline: RotationBaseline): boolean {
  let captured = false;
  // Streaming completion republishes the same meshes with the accumulated
  // instanced-only boxes. They have never been rotated, so they replace the
  // baseline's copy — otherwise the next restore would drop them.
  if (geometry.instancedGeometryAabbs !== baseline.bakedInstanced) {
    baseline.instancedGeometryAabbs = geometry.instancedGeometryAabbs ? new Map(geometry.instancedGeometryAabbs) : undefined;
    // A late box can sit outside the extent measured when the first bake ran,
    // and only appended MESHES grow the pristine bounds below. `restore`
    // clones those bounds back, and the zero-angle branch of
    // `applyModelRotation` returns before anything re-measures them — so
    // without this `modelBoundsCentre` and the section calculations would be
    // handed an extent the model no longer fits in.
    if (baseline.instancedGeometryAabbs) {
      const offset = totalYupOffset(geometry.coordinateInfo);
      for (const box of baseline.instancedGeometryAabbs.values()) growPristineBoundsByWorldBox(baseline, box, offset);
    }
    captured = true;
  }
  for (const mesh of geometry.meshes) {
    if (baseline.meshes.has(mesh)) continue;
    baseline.meshes.set(mesh, captureMesh(mesh));
    // The pristine bounds have to grow with the model, or restoring to a zero
    // angle would write back the bounds of the batches that had arrived when
    // the first bake happened.
    growPristineBounds(baseline, mesh);
    captured = true;
  }
  return captured;
}

/** Grow the pristine shifted bounds by an ABSOLUTE world box. The boxes carry
 * the RTC offset and the origin shift folded in and the bounds do not, so the
 * box is taken back out of that frame first — the same conversion
 * `growByWorldBox` does for the rotated bounds. */
function growPristineBoundsByWorldBox(
  baseline: RotationBaseline, box: EntityWorldAabb, offset: { x: number; y: number; z: number },
): void {
  const bounds = baseline.shiftedBounds;
  if (!bounds) return;
  const o = [offset.x, offset.y, offset.z];
  const axes = ['x', 'y', 'z'] as const;
  for (let axis = 0; axis < 3; axis += 1) {
    if (!Number.isFinite(box.min[axis] - o[axis]) || !Number.isFinite(box.max[axis] - o[axis])) return;
  }
  for (let axis = 0; axis < 3; axis += 1) {
    const key = axes[axis];
    bounds.min[key] = Math.min(bounds.min[key], box.min[axis] - o[axis]);
    bounds.max[key] = Math.max(bounds.max[key], box.max[axis] - o[axis]);
  }
}

function growPristineBounds(baseline: RotationBaseline, mesh: MeshData): void {
  const box = baseline.shiftedBounds;
  if (!box) return;
  const origin = mesh.origin, positions = mesh.positions;
  const ox = origin ? origin[0] : 0, oy = origin ? origin[1] : 0, oz = origin ? origin[2] : 0;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] + ox, y = positions[i + 1] + oy, z = positions[i + 2] + oz;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    box.min.x = Math.min(box.min.x, x); box.max.x = Math.max(box.max.x, x);
    box.min.y = Math.min(box.min.y, y); box.max.y = Math.max(box.max.y, y);
    box.min.z = Math.min(box.min.z, z); box.max.z = Math.max(box.max.z, z);
  }
}

/**
 * Move a baseline onto a new RTC anchor by the delta the LIVE geometry just
 * moved (`convergeGeometryOntoRtcAnchor`, `rtc-rebase.ts`).
 *
 * A baseline is a pristine copy of render-frame state: f64 mesh origins and the
 * un-rotated shifted bounds. The federation convergence rewrites that frame
 * without going through a bake, so unless the baseline follows, the next
 * restore writes pre-convergence origins back and drops the model out of the
 * shared frame — the same failure `convergeSnapshot` exists to prevent for the
 * pre-alignment snapshot, on the other snapshot of the same values.
 *
 * Only render-frame values move. `positions` are relative to the origin that
 * carries the whole delta, and `geometryAabb` / `localToWorld` are absolute and
 * pre-RTC respectively, so both are RTC-invariant (see `rtc-rebase.ts`).
 */
export function rebaseBaselineByRtcDelta(baseline: RotationBaseline, delta: Readonly<Vec3>): void {
  for (const pristine of baseline.meshes.values()) {
    // An absent origin means the pristine positions are absolute render-frame
    // values, i.e. origin [0,0,0]; after the move it HAS one, exactly as the
    // live mesh does.
    pristine.origin = rebaseOriginByRtcDelta(pristine.origin, delta);
  }
  const bounds = baseline.shiftedBounds;
  if (!bounds) return;
  for (const corner of [bounds.min, bounds.max]) {
    corner.x -= delta.x; corner.y -= delta.y; corner.z -= delta.z;
  }
}

/** True when none of `geometry`'s meshes is one this baseline describes — the
 * geometry was wholly replaced rather than appended to, so the baseline can no
 * longer restore anything. */
export function baselineIsForeign(geometry: Geometry, baseline: RotationBaseline): boolean {
  return !geometry.meshes.some((mesh) => baseline.meshes.has(mesh));
}

/** Put `geometry` back to the baseline. Exported for `applyModelRotation`,
 * which restores before it turns; nothing else may call it. */
export function restore(geometry: Geometry, baseline: RotationBaseline): void {
  for (const mesh of geometry.meshes) {
    const pristine = baseline.meshes.get(mesh);
    // A mesh with no baseline has never been baked, so it already IS pristine.
    if (!pristine) continue;
    // VERTICES ONLY. A buffer of a different length is not the one this
    // baseline was taken from — `releaseGeometryMemory` swaps a mesh's arrays
    // for empty ones in bounded mode, and writing the pristine vertices back
    // would undo exactly the memory that release freed. A bake cannot restore
    // what is gone.
    //
    // The skip stops at the buffers. `origin`, `localToWorld` and
    // `geometryAabb` are what carry a whole-model yaw's PLACEMENT effect, they
    // are small, and the release never touched them — so skipping them leaves a
    // released mesh holding a rotated placement that a later zero-angle bake
    // cannot undo, because the baseline is dropped at zero and the mesh is
    // re-streamed with pristine vertices under a rotated origin.
    if (mesh.positions.length === pristine.positions.length) {
      mesh.positions = new Float32Array(pristine.positions);
      if (pristine.normals) mesh.normals = new Float32Array(pristine.normals);
    }
    // Absent stays absent: a mesh that never carried an origin must not gain a
    // [0,0,0] the renderer would then read as a local frame.
    if (pristine.origin) mesh.origin = [...pristine.origin]; else delete mesh.origin;
    if (pristine.localToWorld) mesh.localToWorld = [...pristine.localToWorld];
    else delete mesh.localToWorld;
    if (pristine.geometryAabb) mesh.geometryAabb = pristine.geometryAabb; else delete mesh.geometryAabb;
  }
  geometry.instancedGeometryAabbs = baseline.instancedGeometryAabbs
    ? new Map(baseline.instancedGeometryAabbs) : undefined;
  geometry.coordinateInfo = {
    ...geometry.coordinateInfo,
    shiftedBounds: structuredClone(baseline.shiftedBounds),
  };
}
