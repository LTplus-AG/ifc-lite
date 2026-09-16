/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Baking a whole-model yaw into a model's geometry.
 *
 * WHY THE VERTICES AND NOT A TRANSFORM. `ModelTranslations` deliberately never
 * touches vertex data — it moves double-precision origins and draw offsets and
 * leaves the buffers shared and immutable, which is exactly why a *translation*
 * can be previewed at pointer speed. A rotation cannot ride that: the batch,
 * released-bounds, BVH, spatial-index, selection-bounds, export, symbol,
 * drawing and scan paths each re-derive world space by ADDING an offset, so an
 * affine placement would have to be taught to every one of them separately, and
 * each is somewhere the rotation could be silently dropped. Re-baking the
 * geometry leaves one path — the vertices — so nothing downstream can disagree
 * with it. The caller pays for that with a re-bake and a GPU re-upload per
 * angle change, exactly as `realignFederation` already does.
 *
 * ABSOLUTE, NEVER INCREMENTAL. Every bake restores the pristine baseline first
 * and then applies the placement's absolute angle, so re-editing the angle
 * cannot compound and a zero angle restores the original bytes rather than
 * approximating them by rotating back.
 */

import type { EntityWorldAabb, GeometryResult, MeshData } from '@ifc-lite/geometry';
import { isZeroRotation, type ModelRotation } from './rotation.js';
import { toRenderTranslation } from './translation.js';

type Geometry = Pick<GeometryResult, 'meshes' | 'coordinateInfo' | 'instancedGeometryAabbs'>;

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
    shiftedBounds: structuredClone(geometry.coordinateInfo.shiftedBounds),
  };
}

/**
 * Take a baseline of any mesh in `geometry` this baseline has never seen — a
 * streamed batch appended after the model was baked. Such a mesh is pristine by
 * construction: nothing has rotated it yet.
 *
 * @returns true when at least one mesh was new, i.e. a re-bake is owed even
 *   though the declared angle has not changed.
 */
export function captureAppendedMeshBaselines(geometry: Geometry, baseline: RotationBaseline): boolean {
  let captured = false;
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

/** True when none of `geometry`'s meshes is one this baseline describes — the
 * geometry was wholly replaced rather than appended to, so the baseline can no
 * longer restore anything. */
export function baselineIsForeign(geometry: Geometry, baseline: RotationBaseline): boolean {
  return !geometry.meshes.some((mesh) => baseline.meshes.has(mesh));
}

function restore(geometry: Geometry, baseline: RotationBaseline): void {
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

/** Renderer-frame yaw: x' = px + dx·cos + dz·sin, z' = pz − dx·sin + dz·cos.
 * Lifted from `Scene.rotateMeshesForEntity` rather than re-derived, so the
 * whole-model and per-entity yaws cannot end up with opposite signs. */
interface Yaw { cos: number; sin: number; px: number; pz: number }

function rotatedBox(box: EntityWorldAabb, yaw: Yaw): EntityWorldAabb {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  // All eight corners, re-derived. Translating min/max is only valid for a pure
  // offset; under a rotation the extreme corners are not the same corners.
  for (const x of [box.min[0], box.max[0]]) {
    for (const y of [box.min[1], box.max[1]]) {
      for (const z of [box.min[2], box.max[2]]) {
        const dx = x - yaw.px, dz = z - yaw.pz;
        const corner: [number, number, number] = [
          yaw.px + dx * yaw.cos + dz * yaw.sin, y, yaw.pz - dx * yaw.sin + dz * yaw.cos];
        for (let axis = 0; axis < 3; axis += 1) {
          min[axis] = Math.min(min[axis], corner[axis]);
          max[axis] = Math.max(max[axis], corner[axis]);
        }
      }
    }
  }
  return { min, max };
}

/** `Rp · M` for a row-major Y-up 4×4: the linear block picks up the yaw and the
 * translation column is rotated as a point about the pivot. */
function rotatedLocalToWorld(matrix: number[], yaw: Yaw): number[] {
  const next = [...matrix];
  for (let column = 0; column < 3; column += 1) {
    const row0 = matrix[column], row2 = matrix[8 + column];
    next[column] = row0 * yaw.cos + row2 * yaw.sin;
    next[8 + column] = -row0 * yaw.sin + row2 * yaw.cos;
  }
  const dx = matrix[3] - yaw.px, dz = matrix[11] - yaw.pz;
  next[3] = yaw.px + dx * yaw.cos + dz * yaw.sin;
  next[11] = yaw.pz - dx * yaw.sin + dz * yaw.cos;
  return next;
}

function rotateMesh(mesh: MeshData, yaw: Yaw, bounds: { min: number[]; max: number[] }): void {
  const origin = mesh.origin;
  // With a per-element local frame the ORIGIN carries the pivot and the vertices
  // rotate about zero as plain vectors. Folding the pivot into the local frame
  // instead (what the per-entity path does) would write pivot-sized values into
  // f32 vertex coordinates — fine for one element, ruinous for a whole model at
  // georeferenced distance, which is the case this feature exists for.
  let ox = 0, oz = 0;
  if (origin) {
    const dx = origin[0] - yaw.px, dz = origin[2] - yaw.pz;
    ox = yaw.px + dx * yaw.cos + dz * yaw.sin;
    oz = yaw.pz - dx * yaw.sin + dz * yaw.cos;
    mesh.origin = [ox, origin[1], oz];
  }
  const positions = mesh.positions;
  // No origin means the positions are already absolute world coords, so they
  // rotate about the pivot themselves.
  const px = origin ? 0 : yaw.px, pz = origin ? 0 : yaw.pz;
  for (let i = 0; i < positions.length; i += 3) {
    const dx = positions[i] - px, dz = positions[i + 2] - pz;
    positions[i] = px + dx * yaw.cos + dz * yaw.sin;
    positions[i + 2] = pz - dx * yaw.sin + dz * yaw.cos;
    // Measure the WORLD box from the stored f32, so it bounds the geometry as
    // it now exists rather than the arithmetic that produced it.
    const wx = positions[i] + ox, wy = positions[i + 1] + (origin ? origin[1] : 0), wz = positions[i + 2] + oz;
    if (!Number.isFinite(wx) || !Number.isFinite(wy) || !Number.isFinite(wz)) continue;
    bounds.min[0] = Math.min(bounds.min[0], wx); bounds.max[0] = Math.max(bounds.max[0], wx);
    bounds.min[1] = Math.min(bounds.min[1], wy); bounds.max[1] = Math.max(bounds.max[1], wy);
    bounds.min[2] = Math.min(bounds.min[2], wz); bounds.max[2] = Math.max(bounds.max[2], wz);
  }
  const normals = mesh.normals;
  // Normals ARE rotated. `alignGeometryAcrossCrs` skips them because a
  // cross-CRS convergence is sub-degree; a user-chosen heading is not, and an
  // unrotated normal set lights the model from the wrong side.
  if (normals) {
    for (let i = 0; i < normals.length; i += 3) {
      const nx = normals[i], nz = normals[i + 2];
      normals[i] = nx * yaw.cos + nz * yaw.sin;
      normals[i + 2] = -nx * yaw.sin + nz * yaw.cos;
    }
  }
  if (mesh.geometryAabb) mesh.geometryAabb = rotatedBox(mesh.geometryAabb, yaw);
  if (mesh.localToWorld && mesh.localToWorld.length >= 12) {
    mesh.localToWorld = rotatedLocalToWorld(mesh.localToWorld, yaw);
  }
}

/**
 * Put `geometry` in the state the placement's rotation describes: pristine
 * baseline first, then the absolute angle about the pivot.
 *
 * `rotation.pivot` is a workspace point in the model's UN-TRANSLATED frame —
 * the order of operations is rotate-about-pivot, then the placement
 * translation, which the renderer applies on top of these vertices.
 *
 * Returns true when the geometry now differs from how it arrived.
 */
export function applyModelRotation(
  geometry: Geometry, baseline: RotationBaseline, rotation: ModelRotation,
): boolean {
  restore(geometry, baseline);
  if (isZeroRotation(rotation)) return true;
  const pivot = toRenderTranslation(rotation.pivot);
  const yaw: Yaw = { cos: Math.cos(rotation.angle), sin: Math.sin(rotation.angle), px: pivot[0], pz: pivot[2] };
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const mesh of geometry.meshes) rotateMesh(mesh, yaw, bounds);
  const instanced = geometry.instancedGeometryAabbs;
  if (instanced && instanced.size > 0) {
    // The instanced-only channel has no vertices on this side to measure, so
    // its boxes are corner-transformed instead.
    const next = new Map<number, EntityWorldAabb>();
    for (const [expressId, box] of instanced) next.set(expressId, rotatedBox(box, yaw));
    geometry.instancedGeometryAabbs = next;
  }
  if (Number.isFinite(bounds.min[0])) {
    geometry.coordinateInfo = { ...geometry.coordinateInfo, shiftedBounds: {
      min: { x: bounds.min[0], y: bounds.min[1], z: bounds.min[2] },
      max: { x: bounds.max[0], y: bounds.max[1], z: bounds.max[2] } } };
  }
  // `originalBounds` is deliberately left alone: it describes the source file's
  // own frame, and a workspace rotation is a viewer placement, not a re-bake of
  // the source coordinates.
  return true;
}

/** Bounding-box centre of a model's geometry in workspace engineering metres —
 * the default pivot, and the same default the per-entity `rotateEntity` uses.
 * Null when the model has no measurable bounds to centre on. */
export function modelBoundsCentre(geometry: Geometry): [number, number, number] | null {
  const box = geometry.coordinateInfo.shiftedBounds;
  if (!box) return null;
  const centre = { x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2, z: (box.min.z + box.max.z) / 2 };
  if (![centre.x, centre.y, centre.z].every((value) => Number.isFinite(value))) return null;
  // Renderer Y-up back to engineering Z-up; `fromRenderTranslation`'s inverse
  // pairing is what keeps this the same frame the panel's numbers are in.
  return [centre.x, -centre.z, centre.y];
}
