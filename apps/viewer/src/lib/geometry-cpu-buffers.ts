/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';

// A source frame restore can replace buffers while earlier registered copies
// remain live. Flat weak histories transfer through fully shared immutable
// copies without ownership pollution or a per-recolour ancestry chain.
type BufferHistory = Set<WeakRef<ArrayBufferLike>>;
const registeredBuffers = new WeakMap<MeshData, BufferHistory>();
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
  const known = registeredBuffers.get(mesh) ?? new Set<WeakRef<ArrayBufferLike>>();
  const live = liveHistory(known);
  for (const buffer of buffers) if (!live.has(buffer)) known.add(new WeakRef(buffer));
  registeredBuffers.set(mesh, known);
}

/** Snapshot source ownership only across a copy sharing its whole allocation
 * domain. The independent set prevents a later copy edit polluting its source.
 */
export function inheritCpuMeshBuffers(source: MeshData, copy: MeshData): void {
  const sourceHistory = registeredBuffers.get(source);
  const copyHistory = registeredBuffers.get(copy);
  if (!sourceHistory || !copyHistory) return;
  const live = liveHistory(copyHistory);
  for (const [buffer, reference] of liveHistory(sourceHistory)) live.set(buffer, reference);
  registeredBuffers.set(copy, new Set(live.values()));
}

/** Strong identities exist only for this call; prune dead history entries. */
function liveHistory(history: BufferHistory): Map<ArrayBufferLike, WeakRef<ArrayBufferLike>> {
  const live = new Map<ArrayBufferLike, WeakRef<ArrayBufferLike>>();
  for (const reference of history) {
    const buffer = reference.deref();
    if (buffer) live.set(buffer, reference);
    else history.delete(reference);
  }
  return live;
}

/** Release current fields and prior source allocations still held by copies. */
export function meshCpuReleaseBuffers(mesh: MeshData): BufferMembership {
  const current = meshCpuBuffers(mesh);
  const known = registeredBuffers.get(mesh);
  if (known) for (const buffer of liveHistory(known).keys()) current.add(buffer);
  return current;
}

/** Even a zero-length subarray keeps its populated backing allocation alive. */
export function sharesCpuBuffer(view: Float32Array | Uint32Array | undefined, buffers: BufferMembership): boolean {
  return view !== undefined && view.buffer.byteLength > 0 && buffers.has(view.buffer);
}
