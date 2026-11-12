/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Moving one decoded chunk's meshes from a decode worker to the main thread in
 * a single message.
 *
 * - The mesh arrays live in the worker's arena blocks (`ArrayArena`). Every
 *   distinct buffer is transferred, so nothing is copied and the worker keeps
 *   nothing after the reply. Views stay valid on the receiving side, and arrays
 *   one chunk's meshes share (a mesh's `appearanceSource.indices` is its own
 *   `indices`) are still shared after the structured clone.
 * - The section's appearance-source pool is shared by every chunk on the main
 *   thread. A mesh whose `sourceIndices` is a pool array therefore travels as
 *   that array's pool index, and the main thread re-links it to its own pool
 *   array, so identity across chunks is exactly what a main-thread decode
 *   gives. Pool arrays are never transferred.
 */

import type { MeshData } from '@ifc-lite/geometry';

const NOT_POOLED = -1;
const EMPTY = new Uint32Array(0);

/** Worker side: pool references become indices; returns the buffers to transfer. */
export function packDecodedChunk(meshes: MeshData[], pool: readonly Uint32Array[] = []): { poolRefs: Int32Array; transfers: ArrayBuffer[] } {
  const poolIndex = new Map<Uint32Array, number>(pool.map((array, index) => [array, index]));
  const poolRefs = new Int32Array(meshes.length).fill(NOT_POOLED);
  const buffers = new Set<ArrayBuffer>();
  const add = (value: unknown): void => {
    if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer && value.buffer.byteLength > 0) buffers.add(value.buffer);
  };
  for (let i = 0; i < meshes.length; i++) {
    const mesh = meshes[i];
    const source = mesh.appearanceSource;
    if (source) {
      const ref = poolIndex.get(source.sourceIndices);
      if (ref !== undefined) {
        poolRefs[i] = ref;
        mesh.appearanceSource = { ...source, sourceIndices: EMPTY };
      }
      add(mesh.appearanceSource!.sourceIndices);
      add(source.cornerIndices);
    }
    for (const value of Object.values(mesh)) {
      add(value);
      if (value && typeof value === 'object' && !ArrayBuffer.isView(value) && !Array.isArray(value)) for (const nested of Object.values(value)) add(nested);
    }
  }
  for (const array of pool) buffers.delete(array.buffer as ArrayBuffer);
  buffers.add(poolRefs.buffer);
  return { poolRefs, transfers: [...buffers] };
}

/** Main side: checks the reply's shape and re-links pool references to the main thread's own pool arrays. */
export function unpackDecodedChunk(meshes: unknown, poolRefs: unknown, meshCount: number, pool: readonly Uint32Array[] = []): MeshData[] {
  if (!Array.isArray(meshes) || meshes.length !== meshCount || !(poolRefs instanceof Int32Array) || poolRefs.length !== meshCount) {
    throw new Error('Invalid decoded chunk reply');
  }
  for (let i = 0; i < meshCount; i++) {
    const ref = poolRefs[i];
    if (ref === NOT_POOLED) continue;
    const mesh = meshes[i] as MeshData;
    if (!mesh.appearanceSource || !pool[ref]) throw new Error('Invalid decoded chunk reply: appearance source pool index');
    mesh.appearanceSource = { ...mesh.appearanceSource, sourceIndices: pool[ref] };
  }
  return meshes as MeshData[];
}
