/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';

// A source frame restore can replace buffers while earlier registered copies
// remain live. Weak membership remembers allocation identity without retaining
// the allocation or treating independent copy replacements as source-owned.
const registeredBuffers = new WeakMap<MeshData, WeakSet<ArrayBufferLike>>();
type BufferMembership = Pick<ReadonlySet<ArrayBufferLike>, 'has'>;

/** Ephemeral allocation identities only; never retain this set in alias bookkeeping. */
export function meshCpuBuffers(mesh: MeshData): Set<ArrayBufferLike> {
  const appearance = mesh.appearanceSource;
  return new Set([mesh.positions, mesh.normals, mesh.indices,
    appearance?.indices, appearance?.sourceIndices, appearance?.cornerIndices]
    .filter((view): view is Float32Array | Uint32Array => view !== undefined && view.buffer.byteLength > 0)
    .map(view => view.buffer));
}

export function rememberCpuMeshBuffers(mesh: MeshData, buffers: ReadonlySet<ArrayBufferLike>): void {
  let known = registeredBuffers.get(mesh);
  if (!known) { known = new WeakSet<ArrayBufferLike>(); registeredBuffers.set(mesh, known); }
  for (const buffer of buffers) known.add(buffer);
}

/** Release current fields and prior source allocations still held by copies. */
export function meshCpuReleaseBuffers(mesh: MeshData): BufferMembership {
  const current = meshCpuBuffers(mesh);
  const known = registeredBuffers.get(mesh);
  return { has: buffer => current.has(buffer) || known?.has(buffer) === true };
}

/** Even a zero-length subarray keeps its populated backing allocation alive. */
export function sharesCpuBuffer(view: Float32Array | Uint32Array | undefined, buffers: BufferMembership): boolean {
  return view !== undefined && view.buffer.byteLength > 0 && buffers.has(view.buffer);
}
