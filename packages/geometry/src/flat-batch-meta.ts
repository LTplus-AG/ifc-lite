/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Packed metadata columns for a geometry worker's flat batch (follow-up to the
 * packed vertex streams in `flat-batch-pack.ts`).
 *
 * After the vertex streams leave the mesh objects, each mesh is still a dozen
 * small heap objects on the wire: the mesh itself, `color`, `origin`,
 * `localBounds` with its two arrays, the 16-number `localToWorld`, the
 * fingerprint box with its two arrays, plus its strings and numbers. The main
 * thread deserializes all of them inside the pool's `onmessage`. Here a mesh
 * whose fields are exactly the worker's usual ones travels as a slot in a few
 * typed columns instead, and the main thread rebuilds the same object, with
 * the same keys in the same order and the same values.
 *
 * A mesh with any other field (`shadingColor`, `material`, textures, UVs,
 * `entityIds`, ...), a different key order, or a value the columns cannot hold
 * exactly keeps travelling as an object, in its place in the batch.
 */

import type { MeshData } from './types.js';

/** Presence bits, in the worker's key order (see `geometry.worker.ts` `collectMeshes`). */
const ORIGIN = 1, LOCAL_BOUNDS = 2, LOCAL_TO_WORLD = 4, ITEM = 8, MATERIAL = 16, FENCE = 32, HASH = 64, AABB = 128, VOLUME = 256;
/** f64 slots per mesh: color 4, origin 3, localBounds 6, localToWorld 16, geometryClass 1, item 1, material 1, aabb 6, volume 1. */
const STRIDE = 39;

export interface PackedFlatMeta {
  /** 0 = mesh k travelled as an object; otherwise 1 | the presence bits << 1. */
  slots: Uint16Array;
  expressIds: Uint32Array;
  /** Index into `types` per mesh. */
  typeIndex: Uint16Array;
  types: string[];
  values: Float64Array;
  hashes: BigUint64Array;
}

const isTriple = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && typeof v[0] === 'number' && typeof v[1] === 'number' && typeof v[2] === 'number';
const isBox = (v: unknown): v is { min: [number, number, number]; max: [number, number, number] } => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length === 2 && keys[0] === 'min' && keys[1] === 'max' && isTriple((v as { min: unknown }).min) && isTriple((v as { max: unknown }).max);
};

/** The key order a mesh with these presence bits has when built by the worker. */
function keyOrder(bits: number, fence: boolean): string[] {
  const keys = ['expressId', 'ifcType', 'positions', 'normals', 'indices', 'color'];
  if (bits & ORIGIN) keys.push('origin');
  if (bits & LOCAL_BOUNDS) keys.push('localBounds');
  if (bits & LOCAL_TO_WORLD) keys.push('localToWorld');
  keys.push('geometryClass');
  if (bits & ITEM) keys.push('geometryItemId');
  if (bits & MATERIAL) keys.push('materialId');
  if (fence) keys.push('appearanceSource');
  if (bits & HASH) keys.push('geometryHash');
  if (bits & AABB) keys.push('geometryAabb');
  if (bits & VOLUME) keys.push('geometryVolume');
  return keys;
}

/** Presence bits for a mesh the columns can carry exactly, or -1. */
function bitsOf(m: MeshData, fence: boolean): number {
  if (!Number.isInteger(m.expressId) || m.expressId < 0 || m.expressId > 0xffffffff) return -1;
  if (typeof m.ifcType !== 'string') return -1;
  if (!Array.isArray(m.color) || m.color.length !== 4 || m.color.some((c) => typeof c !== 'number')) return -1;
  if (typeof m.geometryClass !== 'number') return -1;
  let bits = 0;
  if (m.origin !== undefined) { if (!isTriple(m.origin)) return -1; bits |= ORIGIN; }
  if (m.localBounds !== undefined) { if (!isBox(m.localBounds)) return -1; bits |= LOCAL_BOUNDS; }
  if (m.localToWorld !== undefined) {
    if (!Array.isArray(m.localToWorld) || m.localToWorld.length !== 16 || m.localToWorld.some((v) => typeof v !== 'number')) return -1;
    bits |= LOCAL_TO_WORLD;
  }
  if (m.geometryItemId !== undefined) { if (typeof m.geometryItemId !== 'number') return -1; bits |= ITEM; }
  if (m.materialId !== undefined) { if (typeof m.materialId !== 'number') return -1; bits |= MATERIAL; }
  if (fence) bits |= FENCE;
  if (m.geometryHash !== undefined) {
    if (typeof m.geometryHash !== 'bigint' || m.geometryHash < 0n || m.geometryHash > 0xffffffffffffffffn) return -1;
    bits |= HASH;
  }
  if (m.geometryAabb !== undefined) { if (!isBox(m.geometryAabb)) return -1; bits |= AABB; }
  if (m.geometryVolume !== undefined) { if (typeof m.geometryVolume !== 'number') return -1; bits |= VOLUME; }
  // Exactly the expected keys, in the worker's order: anything else travels whole.
  const keys = Object.keys(m), expected = keyOrder(bits, fence);
  if (keys.length !== expected.length) return -1;
  for (let i = 0; i < keys.length; i++) if (keys[i] !== expected[i]) return -1;
  return bits;
}

/**
 * Worker side, after the vertex streams were taken (`vertexPacked[k]` = 1, and
 * `fence[k]` = 1 where the mesh's appearance fence was cleared). Returns the
 * meshes to post (column-packed ones replaced by 0) and the columns, or no
 * columns when no mesh qualifies.
 */
export function packFlatMeta(meshes: MeshData[], vertexPacked: Uint8Array, fence: Uint8Array): { meshes: (MeshData | 0)[]; meta?: PackedFlatMeta } {
  const n = meshes.length;
  const slots = new Uint16Array(n);
  let count = 0;
  for (let k = 0; k < n; k++) {
    if (!vertexPacked[k]) continue;
    const bits = bitsOf(meshes[k], fence[k] === 1);
    if (bits < 0) continue;
    slots[k] = 1 | (bits << 1); count++;
  }
  if (count === 0) return { meshes };
  const expressIds = new Uint32Array(n), typeIndex = new Uint16Array(n), values = new Float64Array(n * STRIDE), hashes = new BigUint64Array(n);
  const types: string[] = [], typeIds = new Map<string, number>();
  const out = new Array<MeshData | 0>(n);
  for (let k = 0; k < n; k++) {
    const m = meshes[k];
    if (!slots[k]) { out[k] = m; continue; }
    if (!typeIds.has(m.ifcType!) && types.length >= 0xffff) { slots[k] = 0; out[k] = m; continue; }
    const bits = slots[k] >> 1, v = k * STRIDE;
    expressIds[k] = m.expressId;
    let t = typeIds.get(m.ifcType!);
    if (t === undefined) { t = types.length; types.push(m.ifcType!); typeIds.set(m.ifcType!, t); }
    typeIndex[k] = t;
    values.set(m.color, v);
    if (bits & ORIGIN) values.set(m.origin!, v + 4);
    if (bits & LOCAL_BOUNDS) { values.set(m.localBounds!.min, v + 7); values.set(m.localBounds!.max, v + 10); }
    if (bits & LOCAL_TO_WORLD) values.set(m.localToWorld!, v + 13);
    values[v + 29] = m.geometryClass!;
    if (bits & ITEM) values[v + 30] = m.geometryItemId!;
    if (bits & MATERIAL) values[v + 31] = m.materialId!;
    if (bits & AABB) { values.set(m.geometryAabb!.min, v + 32); values.set(m.geometryAabb!.max, v + 35); }
    if (bits & VOLUME) values[v + 38] = m.geometryVolume!;
    if (bits & HASH) hashes[k] = m.geometryHash!;
    out[k] = 0;
  }
  return { meshes: out, meta: { slots, expressIds, typeIndex, types, values, hashes } };
}

/** The column buffers to transfer. */
export function metaTransfers(meta: PackedFlatMeta): ArrayBuffer[] {
  return [meta.slots.buffer, meta.expressIds.buffer, meta.typeIndex.buffer, meta.values.buffer, meta.hashes.buffer] as ArrayBuffer[];
}

const triple = (v: Float64Array, at: number): [number, number, number] => [v[at], v[at + 1], v[at + 2]];

/**
 * Main side. Rebuilds every column-packed mesh in place of its 0, with the
 * worker's keys in the worker's order. Its vertex arrays (and fence) are left
 * `undefined` for `unpackFlatBatch` to fill, so they keep their position.
 */
export function unpackFlatMeta(meshes: (MeshData | 0)[], meta: PackedFlatMeta | undefined): MeshData[] {
  if (!meta) return meshes as MeshData[];
  const { slots, expressIds, typeIndex, types, values, hashes } = meta;
  for (let k = 0; k < meshes.length; k++) {
    if (!slots[k]) continue;
    const bits = slots[k] >> 1, v = k * STRIDE;
    const m = { expressId: expressIds[k], ifcType: types[typeIndex[k]], positions: undefined, normals: undefined, indices: undefined,
      color: [values[v], values[v + 1], values[v + 2], values[v + 3]] } as unknown as Record<string, unknown>;
    if (bits & ORIGIN) m.origin = triple(values, v + 4);
    if (bits & LOCAL_BOUNDS) m.localBounds = { min: triple(values, v + 7), max: triple(values, v + 10) };
    if (bits & LOCAL_TO_WORLD) m.localToWorld = Array.prototype.slice.call(values, v + 13, v + 29);
    m.geometryClass = values[v + 29];
    if (bits & ITEM) m.geometryItemId = values[v + 30];
    if (bits & MATERIAL) m.materialId = values[v + 31];
    if (bits & FENCE) m.appearanceSource = undefined;
    if (bits & HASH) m.geometryHash = hashes[k];
    if (bits & AABB) m.geometryAabb = { min: triple(values, v + 32), max: triple(values, v + 35) };
    if (bits & VOLUME) m.geometryVolume = values[v + 38];
    meshes[k] = m as unknown as MeshData;
  }
  return meshes as MeshData[];
}
