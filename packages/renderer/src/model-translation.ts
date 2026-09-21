/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Mesh } from './types.js';
import type { MeshData } from '@ifc-lite/geometry';
import type { BoundingBox } from './scene-raycaster.js';
import { worldAabbFromPieces } from './scene-geometry.js';
import { writeInstanceAnchor } from './instanced-render.js';

type Offset = readonly [number, number, number];
type Drawable = { origin?: [number, number, number]; bounds?: Bounds };
type Bounds = { min: [number, number, number]; max: [number, number, number] };
const ZERO: Offset = [0, 0, 0];

/** A model's whole-model yaw (#4890): `angle` radians about the renderer
 * vertical (+Y) axis — the Y-up image of an IFC yaw about +Z, the SAME
 * convention `Scene.rotateMeshesForEntity` already uses — through the render-
 * frame pivot `(px, *, pz)` (Y is the rotation axis and unused). `null` means
 * no rotation; `setYaw` canonicalizes an explicit zero angle to `null` so a
 * cleared rotation and a never-set one compare equal and restore bit-exact. */
export interface ModelYaw { angle: number; px: number; pz: number }

function yawEqual(a: ModelYaw | null, b: ModelYaw | null): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.angle === b.angle && a.px === b.px && a.pz === b.pz;
}

/** Validate before storing an offset, including when no drawables exist yet. */
export function assertModelTranslation(modelIndex: number, offset: Offset): void {
  if (!Number.isSafeInteger(modelIndex) || modelIndex < 0 || offset.length !== 3 || !offset.every((value) => Number.isFinite(value) && Number.isFinite(Math.fround(value)))) {
    throw new Error('Model translation requires a model index and three finite coordinates.');
  }
}

function sum(a: Offset, b: Offset): [number, number, number] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function difference(a: Offset, b: Offset): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function moveBounds(bounds: Bounds, delta: Offset): Bounds {
  return { min: sum(bounds.min, delta), max: sum(bounds.max, delta) };
}

interface MeshPlacement {
  source: MeshData;
  placed: MeshData;
}

interface BatchPlacement {
  modelIndex: number;
  origin: Offset;
  bounds: Bounds | undefined;
}

/** Scene-owned translations in renderer Y-up metres. Mesh vertices remain shared
 * and immutable: only double-precision local origins and batch draw origins move.
 * Every preview is evaluated against the baseline, never the previous preview. */
export class ModelTranslations {
  private authored = new WeakMap<Mesh, { base: number[]; written: number[]; offset: Offset; bounds?: Bounds; writtenBounds?: Bounds }>();
  private offsets = new Map<number, Offset>();
  private yaws = new Map<number, ModelYaw>();
  private meshes = new WeakMap<MeshData, MeshPlacement>();
  private batches = new WeakMap<Drawable, BatchPlacement>();
  private instances = new WeakMap<ArrayBuffer, { base: Float64Array; written: Float32Array; offset: Offset; yaw: ModelYaw | null }>();
  private releasedBounds = new WeakMap<BoundingBox, Bounds>();
  private releasedEntities = new Map<number, Map<number, BoundingBox>>();

  get(modelIndex = 0): Offset { return this.offsets.get(modelIndex) ?? ZERO; }

  set(modelIndex: number, offset: Offset): boolean {
    assertModelTranslation(modelIndex, offset);
    if (this.get(modelIndex).every((value, i) => value === offset[i])) return false;
    this.offsets.set(modelIndex, [...offset]);
    return true;
  }

  /** A copy, never the stored object: `placeInstances` compares this against
   * its own retained `entry.yaw` by value, so a caller mutating a borrowed
   * yaw in place would make a later placement wrongly see "unchanged" and
   * skip rewriting the instance buffer, leaving the render stale. */
  getYaw(modelIndex = 0): ModelYaw | null {
    const yaw = this.yaws.get(modelIndex);
    return yaw ? { ...yaw } : null;
  }

  /** `null` clears the model's rotation; an explicit zero angle is stored the
   * same way, so both restore the pristine instance transform bit-exactly.
   * The pivot is validated the same way `assertModelTranslation` validates an
   * offset: `Math.fround`-representable, not merely finite — `placeInstances`
   * writes it through `DataView.setFloat32`, so a pivot like `1e100` would
   * otherwise round to `Infinity` and poison every occurrence's bounds. */
  setYaw(modelIndex: number, yaw: ModelYaw | null): boolean {
    if (yaw && (!Number.isFinite(yaw.angle)
      || !Number.isFinite(yaw.px) || !Number.isFinite(Math.fround(yaw.px))
      || !Number.isFinite(yaw.pz) || !Number.isFinite(Math.fround(yaw.pz)))) {
      throw new Error('Model rotation requires a finite angle and pivot.');
    }
    const next = yaw && yaw.angle !== 0 ? { angle: yaw.angle, px: yaw.px, pz: yaw.pz } : null;
    if (yawEqual(this.getYaw(modelIndex), next)) return false;
    if (next) this.yaws.set(modelIndex, next); else this.yaws.delete(modelIndex);
    return true;
  }

  /** Preserve source identity and source coordinates for export and re-alignment. */
  placeMesh(source: MeshData): MeshData {
    let entry = this.meshes.get(source);
    if (!entry) {
      entry = { source, placed: { ...source } };
      this.meshes.set(source, entry);
      this.meshes.set(entry.placed, entry);
    }
    const delta = this.get(entry.source.modelIndex);
    entry.placed.origin = sum(entry.source.origin ?? ZERO, delta);
    if (entry.source.localToWorld) {
      entry.placed.localToWorld = entry.source.localToWorld.map((value, index) =>
        index === 3 ? value + delta[0] : index === 7 ? value + delta[1] : index === 11 ? value + delta[2] : value);
    }
    const box = entry.source.geometryAabb;
    if (box) entry.placed.geometryAabb = { ...box,
      min: sum(box.min, delta), max: sum(box.max, delta) };
    return entry.placed;
  }

  /** Public non-batched meshes carry placement in their draw/pick matrix.
   * Hydrated highlights already contain placed vertices and are rebuilt instead. */
  placeAuthoredMesh(mesh: Mesh): void {
    if (mesh.hydrated) return;
    const delta = this.get(mesh.modelIndex), matrix = mesh.transform.m;
    let entry = this.authored.get(mesh);
    if (!entry) {
      const base = [matrix[12], matrix[13], matrix[14]];
      entry = { base, written: [...base], offset: ZERO, bounds: mesh.bounds ? moveBounds(mesh.bounds, ZERO) : undefined, writtenBounds: mesh.bounds ? moveBounds(mesh.bounds, ZERO) : undefined };
      this.authored.set(mesh, entry);
    }
    if (entry.offset.every((value, index) => value === delta[index])) return;
    for (let axis = 0; axis < 3; axis++) {
      entry.base[axis] += matrix[12 + axis] - entry.written[axis];
      matrix[12 + axis] = entry.base[axis] + delta[axis];
      entry.written[axis] = matrix[12 + axis];
    }
    if (!mesh.bounds) entry.bounds = undefined;
    else if (!entry.bounds || !entry.writtenBounds) entry.bounds = moveBounds(mesh.bounds, entry.offset.map((v) => -v) as [number, number, number]);
    else for (const edge of ['min', 'max'] as const) for (let axis = 0; axis < 3; axis++) {
      entry.bounds[edge][axis] += mesh.bounds[edge][axis] - entry.writtenBounds[edge][axis];
    }
    if (entry.bounds) mesh.bounds = moveBounds(entry.bounds, delta);
    entry.writtenBounds = mesh.bounds ? moveBounds(mesh.bounds, ZERO) : undefined;
    entry.offset = delta;
  }

  /** Adopt detached appearance geometry already expressed in the placed frame. */
  sourceFromPlaced(mesh: MeshData): MeshData {
    const existing = this.meshes.get(mesh);
    if (existing) return existing.source;
    const delta = this.get(mesh.modelIndex);
    const source: MeshData = { ...mesh, origin: difference(mesh.origin ?? ZERO, delta) };
    if (mesh.localToWorld) source.localToWorld = mesh.localToWorld.map((value, index) =>
      index === 3 ? value - delta[0] : index === 7 ? value - delta[1] : index === 11 ? value - delta[2] : value);
    if (mesh.geometryAabb) source.geometryAabb = { ...mesh.geometryAabb,
      min: difference(mesh.geometryAabb.min, delta), max: difference(mesh.geometryAabb.max, delta) };
    const entry = { source, placed: mesh };
    this.meshes.set(source, entry); this.meshes.set(mesh, entry);
    return source;
  }

  sourceMesh(mesh: MeshData): MeshData { return this.meshes.get(mesh)?.source ?? mesh; }

  forgetEntityBounds(id: number): void { this.releasedEntities.delete(id); }

  clearFlatBounds(): void {
    this.releasedEntities.clear();
    this.releasedBounds = new WeakMap();
  }

  retainEntityBounds(pieces: ReadonlyMap<number, MeshData[]>): void {
    for (const [id, meshes] of pieces) {
      const groups = new Map<number, MeshData[]>();
      for (const mesh of meshes) {
        const source = this.sourceMesh(mesh), index = source.modelIndex ?? 0;
        const group = groups.get(index) ?? []; group.push(source); groups.set(index, group);
      }
      const bounds = new Map<number, BoundingBox>();
      for (const [index, group] of groups) { const box = worldAabbFromPieces(group); if (box) bounds.set(index, box); }
      this.releasedEntities.set(id, bounds);
    }
  }

  releasedEntityIds(modelIndex: number): number[] {
    return [...this.releasedEntities].filter(([, groups]) => groups.has(modelIndex)).map(([id]) => id);
  }

  releasedEntityBounds(id: number): BoundingBox | undefined {
    const result: BoundingBox = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
    for (const [index, box] of this.releasedEntities.get(id) ?? []) {
      const delta = this.get(index);
      for (const [axis, i] of [['x', 0], ['y', 1], ['z', 2]] as const) {
        result.min[axis] = Math.min(result.min[axis], box.min[axis] + delta[i]);
        result.max[axis] = Math.max(result.max[axis], box.max[axis] + delta[i]);
      }
    }
    return Number.isFinite(result.min.x) ? result : undefined;
  }

  sourceDrawableBounds(batch: Drawable): Bounds | undefined { return this.batches.get(batch)?.bounds ?? batch.bounds; }

  /** Released geometry retains only entity bounds. Keep their unrounded baseline
   * too, so repeated coarse previews do not accumulate coordinate cancellation. */
  placeReleasedBounds(box: BoundingBox, previous: Offset, modelIndex: number): BoundingBox {
    const base = this.releasedBounds.get(box) ?? {
      min: difference([box.min.x, box.min.y, box.min.z], previous),
      max: difference([box.max.x, box.max.y, box.max.z], previous),
    };
    const moved = moveBounds(base, this.get(modelIndex));
    const result = { min: { x: moved.min[0], y: moved.min[1], z: moved.min[2] },
      max: { x: moved.max[0], y: moved.max[1], z: moved.max[2] } };
    this.releasedBounds.set(result, base);
    return result;
  }

  /** Used when (re)building batches so a coarse translation cancels in f64 before
   * the residual vertex coordinates narrow to f32. All colours in a model share
   * the same frame, retaining bit-coincident highlights and overlay surfaces. */
  frameOrigin(base: Offset | null, modelIndex = 0): [number, number, number] | undefined {
    return base ? sum(base, this.get(modelIndex)) : undefined;
  }

  registerDrawable<T extends Drawable>(batch: T, modelIndex: number): T {
    const delta = this.get(modelIndex);
    this.batches.set(batch, { modelIndex,
      origin: difference(batch.origin ?? ZERO, delta),
      bounds: batch.bounds ? moveBounds(batch.bounds, [-delta[0], -delta[1], -delta[2]]) : undefined,
    });
    return batch;
  }

  moveDrawable(batch: Drawable): void {
    const base = this.batches.get(batch);
    if (!base) return;
    const delta = this.get(base.modelIndex);
    batch.origin = sum(base.origin, delta);
    if (base.bounds) batch.bounds = moveBounds(base.bounds, delta);
  }

  /** Only occurrence transforms change; template vertex/index buffers never do.
   * Keep a double f64 baseline so undo never subtracts a rounded GPU value.
   *
   * The base is the pristine 3x4 (columns 0/1/2 — the linear part — plus the
   * translation column; the mat4's bottom row is always [0,0,0,1] and is
   * never touched), captured the first time an occurrence buffer is seen.
   * Every call writes `R_yaw · base + delta`, never the previous write, so
   * repeated yaw/translate previews cannot accumulate drift: the linear
   * columns rotate as directions (`x' = x·cos + z·sin`, `z' = -x·sin + z·cos`,
   * same sign as `Scene.rotateMeshesForEntity`), the translation column
   * rotates about the pivot like a point (`t' = pivot + R(t - pivot) + delta`).
   * An intervening translation-only edit into bytes 48..59 (exploded-storey
   * lift, `translateInstancedEntity`) is folded back into `base` first, by
   * undoing the OLD yaw that was in effect when it was written — a
   * non-translation edit into bytes 0..47 cannot be folded this way and is a
   * STOP condition (see plan #4890 §5). */
  placeInstances(data: ArrayBuffer, modelIndex: number, stride: number): boolean {
    const delta = this.get(modelIndex), yaw = this.getYaw(modelIndex), count = data.byteLength / stride;
    const view = new DataView(data);
    let entry = this.instances.get(data);
    if (!entry) {
      const base = new Float64Array(count * 12), written = new Float32Array(count * 12);
      for (let i = 0; i < count; i++) for (let c = 0; c < 4; c++) for (let a = 0; a < 3; a++) {
        const j = i * 12 + c * 3 + a;
        base[j] = written[j] = view.getFloat32(i * stride + c * 16 + a * 4, true);
      }
      entry = { base, written, offset: ZERO, yaw: null };
      this.instances.set(data, entry);
    }
    if (entry.offset.every((value, i) => value === delta[i]) && yawEqual(entry.yaw, yaw)) return false;

    const oldCos = entry.yaw ? Math.cos(entry.yaw.angle) : 1, oldSin = entry.yaw ? Math.sin(entry.yaw.angle) : 0;
    const newCos = yaw ? Math.cos(yaw.angle) : 1, newSin = yaw ? Math.sin(yaw.angle) : 0;
    const newPx = yaw?.px ?? 0, newPz = yaw?.pz ?? 0;

    for (let i = 0; i < count; i++) {
      const b0 = i * 12, tByte = i * stride + 48;
      // Fold an intervening translation edit: undo the OLD yaw's rotation on
      // the world-space delta before adding it back into the pristine base.
      const diffX = view.getFloat32(tByte, true) - entry.written[b0 + 9];
      const diffY = view.getFloat32(tByte + 4, true) - entry.written[b0 + 10];
      const diffZ = view.getFloat32(tByte + 8, true) - entry.written[b0 + 11];
      entry.base[b0 + 9] += diffX * oldCos - diffZ * oldSin;
      entry.base[b0 + 10] += diffY;
      entry.base[b0 + 11] += diffX * oldSin + diffZ * oldCos;

      // Linear columns (0, 1, 2): pure directions, rotate about no pivot.
      for (let c = 0; c < 3; c++) {
        const j = b0 + c * 3, bx = entry.base[j], by = entry.base[j + 1], bz = entry.base[j + 2];
        const nx = yaw ? bx * newCos + bz * newSin : bx;
        const nz = yaw ? -bx * newSin + bz * newCos : bz;
        const byte = i * stride + c * 16;
        view.setFloat32(byte, nx, true);
        view.setFloat32(byte + 4, by, true);
        view.setFloat32(byte + 8, nz, true);
        entry.written[j] = nx; entry.written[j + 1] = by; entry.written[j + 2] = nz;
      }
      // Translation column: rotate the pristine point about the pivot, then
      // add the current model offset — order matches `pivotInModelFrame`
      // (rotate about the pivot, then translate).
      const btx = entry.base[b0 + 9], bty = entry.base[b0 + 10], btz = entry.base[b0 + 11];
      const dx = btx - newPx, dz = btz - newPz;
      const ttx = (yaw ? newPx + dx * newCos + dz * newSin : btx) + delta[0];
      const tty = bty + delta[1];
      const ttz = (yaw ? newPz - dx * newSin + dz * newCos : btz) + delta[2];
      view.setFloat32(tByte, ttx, true);
      view.setFloat32(tByte + 4, tty, true);
      view.setFloat32(tByte + 8, ttz, true);
      // A placement/yaw edit has no canonical f64 source transform today.
      // Preserve V1 semantics deliberately: V2 renders the edited f32 matrix
      // translation as its anchor rather than applying a stale decode anchor.
      // Legacy callers/tests may still supply a V1-only record. It has no V2
      // lane to update, and retaining its established matrix-only edit is the
      // intended compatibility fallback.
      if (stride >= 120) writeInstanceAnchor(view, i * stride, [ttx, tty, ttz]);
      entry.written[b0 + 9] = ttx; entry.written[b0 + 10] = tty; entry.written[b0 + 11] = ttz;
    }
    entry.offset = delta;
    entry.yaw = yaw;
    return true;
  }

  clear(): void {
    this.offsets.clear();
    this.yaws.clear();
    this.authored = new WeakMap();
    this.meshes = new WeakMap();
    this.batches = new WeakMap();
    this.instances = new WeakMap();
    this.releasedBounds = new WeakMap();
    this.releasedEntities.clear();
  }
}
