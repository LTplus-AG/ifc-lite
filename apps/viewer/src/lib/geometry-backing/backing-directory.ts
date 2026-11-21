/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compact in-memory directory of a backed model: which chunk or shard holds an
 * entity, its bounds and counts. No triangle array is retained, so consumers
 * that need only a box or a count never read geometry back.
 *
 * Bounds are in the mesh frame (`origin + positions`, the frame the renderer
 * and the viewer's centre/framing code use), accumulated in f64. They cover
 * flat meshes; instanced occurrences are listed by shard, and their bounds
 * remain the scene's (`Scene.getInstancedEntityBounds`).
 */

import type { MeshData } from '@ifc-lite/geometry';

export type Vec3 = [number, number, number];
export type RecordState = 'pending' | 'durable' | 'failed';

export interface ChunkEntry {
  index: number;
  meshCount: number;
  /** Stored array bytes, including canonical sources first written here. */
  bytes: number;
  triangles: number;
  min: Vec3;
  max: Vec3;
  /** Sorted, unique. */
  entities: Uint32Array;
  state: RecordState;
}

export interface ShardEntry { index: number; bytes: number; entities: Uint32Array; state: RecordState }

export interface EntityGeometrySummary {
  meshes: number;
  triangles: number;
  vertices: number;
  /** Absent when the entity has no finite flat vertex. */
  bounds?: { min: Vec3; max: Vec3 };
}

/** Growing f64 columns: one slot per entity rather than one object per entity. */
const COLUMNS = 9; // minX minY minZ maxX maxY maxZ meshes triangles vertices

function addMembership(map: Map<number, number | number[]>, id: number, index: number): void {
  const prior = map.get(id);
  if (prior === undefined) map.set(id, index);
  else if (typeof prior === 'number') { if (prior !== index) map.set(id, [prior, index]); }
  else if (prior[prior.length - 1] !== index) prior.push(index);
}

function membership(map: Map<number, number | number[]>, id: number): readonly number[] {
  const value = map.get(id);
  return value === undefined ? [] : typeof value === 'number' ? [value] : value;
}

/** Mesh-frame bounds of one mesh, or undefined without a finite vertex. */
export function meshFrameBounds(mesh: MeshData): { min: Vec3; max: Vec3 } | undefined {
  const [ox, oy, oz] = mesh.origin ?? [0, 0, 0];
  const p = mesh.positions;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i + 2 < p.length; i += 3) {
    const x = p[i] + ox, y = p[i + 1] + oy, z = p[i + 2] + oz;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
  }
  return minX <= maxX ? { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } : undefined;
}

export class ChunkBuilder {
  meshCount = 0;
  bytes = 0;
  triangles = 0;
  readonly min: Vec3 = [Infinity, Infinity, Infinity];
  readonly max: Vec3 = [-Infinity, -Infinity, -Infinity];
  readonly entities = new Set<number>();

  add(mesh: MeshData, bytes: number, bounds: { min: Vec3; max: Vec3 } | undefined): void {
    this.meshCount++;
    this.bytes += bytes;
    this.triangles += Math.floor(mesh.indices.length / 3);
    this.entities.add(mesh.expressId);
    for (const id of mesh.entityIds ?? []) this.entities.add(id);
    if (!bounds) return;
    for (let axis = 0; axis < 3; axis++) {
      if (bounds.min[axis] < this.min[axis]) this.min[axis] = bounds.min[axis];
      if (bounds.max[axis] > this.max[axis]) this.max[axis] = bounds.max[axis];
    }
  }
}

export class BackingDirectory {
  readonly chunks: ChunkEntry[] = [];
  readonly shards: ShardEntry[] = [];
  private readonly entityChunks = new Map<number, number | number[]>();
  private readonly entityShards = new Map<number, number | number[]>();
  private readonly slots = new Map<number, number>();
  private columns = new Float64Array(COLUMNS * 64);

  private slotOf(id: number): number {
    let slot = this.slots.get(id);
    if (slot !== undefined) return slot;
    slot = this.slots.size;
    if ((slot + 1) * COLUMNS > this.columns.length) {
      const grown = new Float64Array(this.columns.length * 2);
      grown.set(this.columns);
      this.columns = grown;
    }
    const base = slot * COLUMNS;
    this.columns.fill(Infinity, base, base + 3);
    this.columns.fill(-Infinity, base + 3, base + 6);
    this.columns.fill(0, base + 6, base + 9);
    this.slots.set(id, slot);
    return slot;
  }

  /** Account one mesh to its owning entity (`expressId`). */
  noteMesh(mesh: MeshData, chunkIndex: number, bounds: { min: Vec3; max: Vec3 } | undefined): void {
    addMembership(this.entityChunks, mesh.expressId, chunkIndex);
    // Colour-merged meshes host other entities: each must find this chunk.
    for (const id of mesh.entityIds ?? []) if (id !== mesh.expressId) addMembership(this.entityChunks, id, chunkIndex);
    const base = this.slotOf(mesh.expressId) * COLUMNS;
    const c = this.columns;
    c[base + 6] += 1;
    c[base + 7] += Math.floor(mesh.indices.length / 3);
    c[base + 8] += Math.floor(mesh.positions.length / 3);
    if (!bounds) return;
    for (let axis = 0; axis < 3; axis++) {
      if (bounds.min[axis] < c[base + axis]) c[base + axis] = bounds.min[axis];
      if (bounds.max[axis] > c[base + 3 + axis]) c[base + 3 + axis] = bounds.max[axis];
    }
  }

  sealChunk(index: number, built: ChunkBuilder): ChunkEntry {
    if (index !== this.chunks.length) throw new RangeError(`Chunk ${index} sealed out of order`);
    const entry: ChunkEntry = {
      index, meshCount: built.meshCount, bytes: built.bytes, triangles: built.triangles,
      min: [...built.min], max: [...built.max],
      entities: Uint32Array.from([...built.entities].sort((a, b) => a - b)), state: 'pending',
    };
    this.chunks.push(entry);
    return entry;
  }

  addShard(index: number, bytes: number, entities: Uint32Array): ShardEntry {
    if (index !== this.shards.length) throw new RangeError(`Shard ${index} added out of order`);
    const entry: ShardEntry = { index, bytes, entities, state: 'pending' };
    this.shards.push(entry);
    for (const id of entities) addMembership(this.entityShards, id, index);
    return entry;
  }

  chunksOf(id: number): readonly number[] { return membership(this.entityChunks, id); }
  shardsOf(id: number): readonly number[] { return membership(this.entityShards, id); }
  has(id: number): boolean { return this.entityChunks.has(id) || this.entityShards.has(id); }

  /** Flat-mesh summary of an entity it owns; undefined if it owns no flat mesh. */
  summary(id: number): EntityGeometrySummary | undefined {
    const slot = this.slots.get(id);
    if (slot === undefined) return undefined;
    const c = this.columns, base = slot * COLUMNS;
    const summary: EntityGeometrySummary = { meshes: c[base + 6], triangles: c[base + 7], vertices: c[base + 8] };
    if (c[base] <= c[base + 3]) {
      summary.bounds = { min: [c[base], c[base + 1], c[base + 2]], max: [c[base + 3], c[base + 4], c[base + 5]] };
    }
    return summary;
  }

  chunksIntersecting(min: Vec3, max: Vec3): number[] {
    const out: number[] = [];
    for (const chunk of this.chunks) {
      if (chunk.min[0] <= max[0] && chunk.max[0] >= min[0] && chunk.min[1] <= max[1] && chunk.max[1] >= min[1]
        && chunk.min[2] <= max[2] && chunk.max[2] >= min[2]) out.push(chunk.index);
    }
    return out;
  }

  /** Entities owning flat meshes, in first-seen order. */
  flatEntities(): IterableIterator<number> { return this.slots.keys(); }

  get storedBytes(): number {
    let bytes = 0;
    for (const chunk of this.chunks) bytes += chunk.bytes;
    for (const shard of this.shards) bytes += shard.bytes;
    return bytes;
  }
}
