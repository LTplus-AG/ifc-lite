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

/** One mesh's pristine bytes: everything a restore can be asked to put back. */
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
      for (const box of baseline.instancedGeometryAabbs.values()) {
        growNamedBoundsByWorldBox(baseline.shiftedBounds, box, offset);
      }
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

type Offset = { x: number; y: number; z: number };
/** Axis order of the numeric box arrays, as keys of the named bounds. */
const AXES = ['x', 'y', 'z'] as const;

/** Grow a named render-frame box by an ABSOLUTE world box. The boxes carry the
 * RTC offset and the origin shift folded in and the bounds do not, so the box
 * is taken back out of that frame first — the same conversion `growByWorldBox`
 * does for the rotated bounds. A non-finite corner grows nothing. */
function growNamedBoundsByWorldBox(
  bounds: RotationBaseline['shiftedBounds'], box: EntityWorldAabb, offset: Offset,
): void {
  if (!bounds) return;
  const o = [offset.x, offset.y, offset.z];
  for (let axis = 0; axis < 3; axis += 1) {
    if (!Number.isFinite(box.min[axis] - o[axis]) || !Number.isFinite(box.max[axis] - o[axis])) return;
  }
  for (let axis = 0; axis < 3; axis += 1) {
    const key = AXES[axis];
    bounds.min[key] = Math.min(bounds.min[key], box.min[axis] - o[axis]);
    bounds.max[key] = Math.max(bounds.max[key], box.max[axis] - o[axis]);
  }
}

/** Grow a named render-frame box by a mesh's own vertices, lifted out of the
 * mesh's local frame by its `origin`. */
function growBoundsByPositions(
  box: RotationBaseline['shiftedBounds'], positions: Float32Array,
  origin: readonly number[] | undefined,
): void {
  if (!box) return;
  const ox = origin ? origin[0] : 0, oy = origin ? origin[1] : 0, oz = origin ? origin[2] : 0;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] + ox, y = positions[i + 1] + oy, z = positions[i + 2] + oz;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    box.min.x = Math.min(box.min.x, x); box.max.x = Math.max(box.max.x, x);
    box.min.y = Math.min(box.min.y, y); box.max.y = Math.max(box.max.y, y);
    box.min.z = Math.min(box.min.z, z); box.max.z = Math.max(box.max.z, z);
  }
}

function growPristineBounds(baseline: RotationBaseline, mesh: MeshData): void {
  growBoundsByPositions(baseline.shiftedBounds, mesh.positions, mesh.origin);
}

/** What a mesh-removal drain took out of the live geometry — everything a
 * baseline needs in order to stop describing meshes that no longer exist. */
export interface MeshPrune {
  /** The renderer ids the drain removed: the key space of the instanced-only
   * maps, which are keyed by id rather than by mesh object. */
  ids: ReadonlySet<number>;
  /** Whether this mesh object is one the drain actually removed. The rule is
   * the prune's own (`removesMesh` in `store/slices/data-mesh-prune.ts`) and is
   * passed in rather than re-derived here, so the baseline cannot start
   * disagreeing with it: a colour-merged mesh that still hosts OTHER entities
   * survives the prune, and has to survive the baseline too. */
  removes: (mesh: MeshData) => boolean;
  /** Each pre-prune geometry object mapped to the pruned copy the store put in
   * its place, so a baseline can follow its model onto the new object. */
  replacements: ReadonlyMap<Geometry, Geometry>;
}

/**
 * Drop everything `prune` removed out of `baseline`, and re-measure the
 * pristine extent from what is left (#4935).
 *
 * Nothing else drops a pruned mesh out of a baseline, so without this a
 * split-away element's pristine buffers stay alive, the pristine `shiftedBounds`
 * keeps covering geometry that is gone — fit-to-view and the section
 * calculations read that extent — and a later zero-angle {@link restore}
 * writes those too-large bounds back over the live ones.
 *
 * The extent is RE-MEASURED rather than shrunk in place: a box cannot be
 * un-grown by removing a box from it, and re-measuring from the pristine
 * copies is the same measurement a non-zero bake already makes from the meshes
 * it turns (`applyModelRotation`). It is a no-op when nothing measurable is
 * left, so a baseline emptied by the prune reports the extent it last had
 * rather than an inverted one.
 *
 * @returns true when the baseline lost something.
 */
export function pruneMeshBaselines(
  geometry: Geometry, baseline: RotationBaseline, prune: MeshPrune,
): boolean {
  let pruned = false;
  // Deleting the current key during a Map iteration is well defined: the
  // deleted entry is simply not revisited.
  for (const mesh of baseline.meshes.keys()) {
    if (!prune.removes(mesh)) continue;
    baseline.meshes.delete(mesh);
    pruned = true;
  }
  const instanced = baseline.instancedGeometryAabbs;
  if (instanced) for (const id of prune.ids) pruned = instanced.delete(id) || pruned;
  if (!pruned) return false;
  remeasurePristineBounds(baseline, totalYupOffset(geometry.coordinateInfo));
  return true;
}

/** Anything a bounds measurement can grow by: a mesh's own vertices lifted by
 * its origin, or — for a buffer a bounded-mode release freed — its last known
 * world box. Shared by {@link MeshBaseline} (the pristine copy) and `MeshData`
 * (the live mesh), which agree on this much. */
interface BoundedMesh {
  positions: Float32Array;
  origin?: readonly number[] | undefined;
  geometryAabb?: EntityWorldAabb | undefined;
}

/** Measure a fresh render-frame box from `meshes` and `instanced`, the same
 * way a non-zero bake measures the rotated bounds (`applyModelRotation`) —
 * just after the fact instead of while rotating. Returns null when nothing
 * measurable was found, so a caller can leave a stale box alone rather than
 * write back an inverted one. */
function measureBounds(
  meshes: Iterable<BoundedMesh>, instanced: ReadonlyMap<number, EntityWorldAabb> | undefined,
  offset: Offset,
): NonNullable<RotationBaseline['shiftedBounds']> | null {
  const next = { min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity } };
  for (const mesh of meshes) {
    // A mesh whose buffers a bounded-mode release freed has no vertices to
    // measure, but its entity box still says where it is — the same fallback
    // `applyModelRotation` makes for the rotated bounds.
    if (mesh.positions.length === 0) {
      if (mesh.geometryAabb) growNamedBoundsByWorldBox(next, mesh.geometryAabb, offset);
      continue;
    }
    growBoundsByPositions(next, mesh.positions, mesh.origin);
  }
  // Instanced-only entities are drawn, so the extent has to contain them too.
  if (instanced) for (const box of instanced.values()) growNamedBoundsByWorldBox(next, box, offset);
  return Number.isFinite(next.min.x) ? next : null;
}

function remeasurePristineBounds(baseline: RotationBaseline, offset: Offset): void {
  if (!baseline.shiftedBounds) return;
  const next = measureBounds(baseline.meshes.values(), baseline.instancedGeometryAabbs, offset);
  if (next) baseline.shiftedBounds = next;
}

/**
 * Re-measure a model's LIVE render-frame extent from what its geometry
 * currently holds (#4947).
 *
 * A prune at an unchanged non-zero rotation removes meshes from the LIVE
 * array too, but nothing else re-measures `geometry.coordinateInfo.shiftedBounds`
 * for it: `reconcile` only re-bakes on an angle change
 * (`ModelRotationBaker.reconcile`'s `equalRotation` fast path), and the meshes
 * that remain are already rotated, so a fresh {@link applyModelRotation} pass
 * is not owed, just a re-measurement of what is already there. Left alone, the
 * live extent keeps covering geometry that is gone — what fit-to-view and the
 * section calculations read — until the user next changes the angle.
 *
 * A no-op when nothing measurable is left, so a model whose last mesh was just
 * pruned reports the extent it last had rather than an inverted one; the
 * caller drops such a baseline anyway (`ModelRotationBaker.pruneMeshes`).
 */
export function remeasureLiveBounds(geometry: Geometry): void {
  if (!geometry.coordinateInfo.shiftedBounds) return;
  const offset = totalYupOffset(geometry.coordinateInfo);
  const next = measureBounds(geometry.meshes, geometry.instancedGeometryAabbs, offset);
  if (!next) return;
  geometry.coordinateInfo = { ...geometry.coordinateInfo, shiftedBounds: next };
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
 * longer restore anything.
 *
 * An instanced-only model has no meshes at all, so there is nothing to check
 * identity against; the instanced boxes' own identity (`bakedInstanced`) is
 * what `captureAppendedMeshBaselines` uses to detect a replacement on that
 * side instead (#4890) — but ONLY when the baseline itself has no meshes
 * either. A baseline that DOES describe meshes and is now handed a geometry
 * with none is exactly a replacement: flat geometry replaced by an
 * instanced-only republish (or vice versa) is not appending to the old
 * baseline, it is a different model's worth of geometry that happens to
 * share a modelId, and keeping the stale baseline would let a later restore
 * write the vanished flat mesh's pristine bytes over instanced-only boxes
 * that were never rotated from it (#4890 review). */
export function baselineIsForeign(geometry: Geometry, baseline: RotationBaseline): boolean {
  if (geometry.meshes.length === 0) return baseline.meshes.size !== 0;
  return !geometry.meshes.some((mesh) => baseline.meshes.has(mesh));
}

/**
 * Trim a baseline's own pristine copy of a mesh a bounded-mode release just
 * freed (#4890): once `mesh.positions.length === 0`, the live buffer is gone
 * for good, `restore` already skips writing a mismatched-length pristine copy
 * back into it, and there is no future in which this baseline's own (still
 * full-size) `positions`/`normals` arrays get used — so free them too, the
 * same memory the release was for. `origin`, `localToWorld`, `geometryAabb`
 * and the baseline's `shiftedBounds` are left untouched: they carry the yaw's
 * PLACEMENT effect, are small, and a later zero-angle bake still needs them to
 * restore the released mesh's un-rotated placement (2def32421).
 *
 * Called from `ModelRotationBaker.reconcile` on every pass that touches an
 * existing baseline, so a release that happens between bakes is picked up the
 * next time the model is visited rather than only at capture time.
 */
export function dropReleasedVertexBaselines(geometry: Geometry, baseline: RotationBaseline): void {
  for (const mesh of geometry.meshes) {
    if (mesh.positions.length !== 0) continue;
    const pristine = baseline.meshes.get(mesh);
    if (!pristine || pristine.positions.length === 0) continue;
    pristine.positions = new Float32Array(0);
    pristine.normals = undefined;
  }
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
