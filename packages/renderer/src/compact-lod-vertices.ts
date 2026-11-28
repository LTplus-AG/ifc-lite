/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { COMPACT_RECORD_BYTES } from '@ifc-lite/geometry/compact';

/** Pack the representatives elected by the bucket clustering, including their authored corner normals. */
export function lod1Vertices(
  lod1: Uint32Array, scratch: Float32Array, lanes: Uint32Array, nodes: Uint16Array,
  octEncode: (x: number, y: number, z: number) => [number, number],
): { indices: Uint16Array; records: Uint8Array } {
  const local = new Map<number, number>(); // page vertex -> representative record
  const reps: number[] = [];
  for (let i = 0; i < lod1.length; i++) if (!local.has(lod1[i])) { local.set(lod1[i], reps.length); reps.push(lod1[i]); }
  const records = new Uint8Array(reps.length * COMPACT_RECORD_BYTES);
  const view = new DataView(records.buffer);
  reps.forEach((rep, r) => {
    const atVertex = rep * 7;
    const [ox, oy] = octEncode(scratch[atVertex + 4], scratch[atVertex + 5], scratch[atVertex + 6]);
    const at = r * COMPACT_RECORD_BYTES;
    for (let axis = 0; axis < 3; axis++) view.setUint16(at + axis * 2, nodes[rep * 3 + axis], true);
    view.setUint16(at + 6, (ox << 8) | oy, true);
    view.setUint32(at + 8, lanes[atVertex + 3], true);
  });
  const indices = new Uint16Array(lod1.length);
  for (let i = 0; i < lod1.length; i++) indices[i] = local.get(lod1[i])!;
  return { indices, records };
}
