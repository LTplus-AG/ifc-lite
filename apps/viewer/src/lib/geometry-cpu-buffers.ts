/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';

/** Ephemeral allocation identities only; never retain this set in alias bookkeeping. */
export function meshCpuBuffers(mesh: MeshData): Set<ArrayBufferLike> {
  const appearance = mesh.appearanceSource;
  return new Set([mesh.positions, mesh.normals, mesh.indices,
    appearance?.indices, appearance?.sourceIndices, appearance?.cornerIndices]
    .filter((view): view is Float32Array | Uint32Array => view !== undefined && view.buffer.byteLength > 0)
    .map(view => view.buffer));
}

/** Even a zero-length subarray keeps its populated backing allocation alive. */
export function sharesCpuBuffer(view: Float32Array | Uint32Array | undefined, buffers: ReadonlySet<ArrayBufferLike>): boolean {
  return view !== undefined && view.buffer.byteLength > 0 && buffers.has(view.buffer);
}
