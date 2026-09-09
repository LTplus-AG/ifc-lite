/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Mesh } from './types.js';
import type { MeshData } from '@ifc-lite/geometry';
import type { BoundingBox } from './scene-raycaster.js';
import { worldAabbFromPieces } from './scene-geometry.js';

type Offset = readonly [number, number, number];
type Drawable = { origin?: [number, number, number]; bounds?: Bounds };
type Bounds = { min: [number, number, number]; max: [number, number, number] };
const ZERO: Offset = [0, 0, 0];

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
  private meshes = new WeakMap<MeshData, MeshPlacement>();
  private batches = new WeakMap<Drawable, BatchPlacement>();
  private instances = new WeakMap<ArrayBuffer, { base: Float64Array; written: Float32Array; offset: Offset }>();
  private releasedBounds = new WeakMap<BoundingBox, Bounds>();
  private releasedEntities = new Map<number, Map<number, BoundingBox>>();

  get(modelIndex = 0): Offset { return this.offsets.get(modelIndex) ?? ZERO; }

  set(modelIndex: number, offset: Offset): boolean {
    assertModelTranslation(modelIndex, offset);
    if (this.get(modelIndex).every((value, i) => value === offset[i])) return false;
    this.offsets.set(modelIndex, [...offset]);
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
   * Keep a double baseline so undo never subtracts a rounded GPU translation. */
  placeInstances(data: ArrayBuffer, modelIndex: number, stride: number): boolean {
    const delta = this.get(modelIndex), count = data.byteLength / stride;
    const view = new DataView(data);
    let entry = this.instances.get(data);
    if (!entry) {
      const base = new Float64Array(count * 3), written = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) for (let axis = 0; axis < 3; axis++) {
        base[i * 3 + axis] = written[i * 3 + axis] = view.getFloat32(i * stride + 48 + axis * 4, true);
      }
      entry = { base, written, offset: ZERO };
      this.instances.set(data, entry);
    }
    if (entry.offset.every((value, i) => value === delta[i])) return false;
    for (let i = 0; i < count; i++) for (let axis = 0; axis < 3; axis++) {
      const j = i * 3 + axis, byte = i * stride + 48 + axis * 4;
      // Preserve intervening element edits / exploded-storey offsets.
      entry.base[j] += view.getFloat32(byte, true) - entry.written[j];
      const value = entry.base[j] + delta[axis];
      view.setFloat32(byte, value, true);
      entry.written[j] = value;
    }
    entry.offset = delta;
    return true;
  }

  clear(): void {
    this.offsets.clear();
    this.authored = new WeakMap();
    this.meshes = new WeakMap();
    this.batches = new WeakMap();
    this.instances = new WeakMap();
    this.releasedBounds = new WeakMap();
    this.releasedEntities.clear();
  }
}
