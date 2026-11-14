/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Packed vertex streams for a geometry worker's flat batch.
 *
 * A worker batch carries ~400 meshes. Sent as they are, every mesh brings
 * three typed arrays, each on its own transferred ArrayBuffer, and the main
 * thread deserializes ~1,200 views and buffers per batch inside the pool's
 * `onmessage`. Traced on Holter cold, that is ~290 ms of main-thread time
 * per load, on the critical path. Here the worker copies the positions,
 * normals and indices of a batch into ONE buffer each, and the main thread
 * gives every mesh `subarray` views of them. Every other field travels on the
 * mesh object exactly as before, so the `MeshData` the pool hands on is the
 * same object shape with the same values.
 *
 * A mesh is packed only when nothing else references its arrays the packing
 * would break. `appearanceSource` must be the worker's identity fence (both
 * index references the mesh's own `indices`, no corner map). It is rebuilt
 * on the views. Anything else (`entityIds`, a corner map, a foreign
 * `appearanceSource`) keeps the mesh on the object path, in its place in the
 * batch.
 */

import type { MeshData } from './types.js';

export interface PackedFlatVertices {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Per mesh, three running ends (positions, normals, indices); mesh k reads [ends[3k-3], ends[3k]) (0 for k = 0). */
  ends: Uint32Array;
  /** 1 = mesh k's arrays are in the streams; 0 = mesh k travelled whole. */
  packed: Uint8Array;
  /** 1 = rebuild mesh k's canonical `appearanceSource` fence on its index view. */
  fence: Uint8Array;
}

/** Whether a mesh's arrays can move into the packed streams without breaking a reference. */
function packable(mesh: MeshData): boolean {
  if (mesh.entityIds) return false;
  const a = mesh.appearanceSource;
  if (!a) return true;
  return a.kind === 'canonical-item' && a.indices === mesh.indices && a.sourceIndices === mesh.indices && a.cornerIndices === undefined;
}

/**
 * Worker side. Clears the packed meshes' three arrays (and their fence) in
 * place, returns the batch's `meshes` and the streams, and removes the packed meshes' own buffers from
 * `transfers` (their bytes are copied, so they need not move). Adds the
 * streams' buffers to `transfers`. A batch with no packable mesh is returned
 * as it is.
 */
export function packFlatBatch(
  meshes: MeshData[],
  transfers: ArrayBuffer[],
): { meshes: MeshData[]; flatVertices?: PackedFlatVertices } {
  const n = meshes.length;
  const packed = new Uint8Array(n);
  let p = 0, q = 0, r = 0, count = 0;
  for (let k = 0; k < n; k++) {
    const m = meshes[k];
    if (!packable(m)) continue;
    packed[k] = 1; count++;
    p += m.positions.length; q += m.normals.length; r += m.indices.length;
  }
  if (count === 0) return { meshes };
  const positions = new Float32Array(p), normals = new Float32Array(q), indices = new Uint32Array(r);
  const ends = new Uint32Array(3 * n), fence = new Uint8Array(n);
  const moved = new Set<ArrayBufferLike>();
  // Buffers still used by a mesh that travels whole stay on the transfer list.
  const kept = new Set<ArrayBufferLike>();
  for (let k = 0; k < n; k++) if (!packed[k]) { const m = meshes[k]; kept.add(m.positions.buffer); kept.add(m.normals.buffer); kept.add(m.indices.buffer); }
  p = 0; q = 0; r = 0;
  for (let k = 0; k < n; k++) {
    const m = meshes[k];
    if (packed[k]) {
      positions.set(m.positions, p); normals.set(m.normals, q); indices.set(m.indices, r);
      p += m.positions.length; q += m.normals.length; r += m.indices.length;
      for (const b of [m.positions.buffer, m.normals.buffer, m.indices.buffer]) if (!kept.has(b)) moved.add(b);
      // Cleared in place, not rebuilt without them: the keys keep their order, so the
      // main thread refills the same object shape. The worker drops these objects after the post.
      const hole = m as unknown as Record<'positions' | 'normals' | 'indices' | 'appearanceSource', undefined>;
      hole.positions = undefined; hole.normals = undefined; hole.indices = undefined;
      if (m.appearanceSource) { fence[k] = 1; hole.appearanceSource = undefined; }
    }
    ends[3 * k] = p; ends[3 * k + 1] = q; ends[3 * k + 2] = r;
  }
  let w = 0;
  for (let i = 0; i < transfers.length; i++) if (!moved.has(transfers[i])) transfers[w++] = transfers[i];
  transfers.length = w;
  transfers.push(positions.buffer, normals.buffer, indices.buffer, ends.buffer, packed.buffer, fence.buffer);
  return { meshes, flatVertices: { positions, normals, indices, ends, packed, fence } };
}

/** Main side. Gives the packed meshes their views back (in place) and returns the batch's meshes. */
export function unpackFlatBatch(meshes: MeshData[], flat: PackedFlatVertices | undefined): MeshData[] {
  if (!flat) return meshes;
  const { ends, packed, fence } = flat;
  let p = 0, q = 0, r = 0;
  for (let k = 0; k < meshes.length; k++) {
    const pe = ends[3 * k], qe = ends[3 * k + 1], re = ends[3 * k + 2];
    if (packed[k]) {
      const m = meshes[k];
      const indices = flat.indices.subarray(r, re);
      m.positions = flat.positions.subarray(p, pe);
      m.normals = flat.normals.subarray(q, qe);
      m.indices = indices;
      if (fence[k]) m.appearanceSource = { kind: 'canonical-item', indices, sourceIndices: indices };
    }
    p = pe; q = qe; r = re;
  }
  return meshes;
}
