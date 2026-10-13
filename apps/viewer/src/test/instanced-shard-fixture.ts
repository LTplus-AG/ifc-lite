/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** One template (a single triangle), one instance — hand-built IFNS bytes
 *  (see packed-instanced-decoder.ts's documented layout) so the test needs
 *  no WASM / Rust fixture. */
export function buildShardBytes(entityId: number): ArrayBuffer {
  const HEADER_WORDS = 8;
  const TEMPLATE_BYTES = 48;
  const INSTANCE_BYTES = 88;
  const posLen = 9, nrmLen = 9, idxLen = 3;

  const templateTableOff = HEADER_WORDS * 4;
  const instanceTableOff = templateTableOff + TEMPLATE_BYTES;
  const dataOff = instanceTableOff + INSTANCE_BYTES;
  const posOff = dataOff;
  const nrmOff = posOff + posLen * 4;
  const idxOff = nrmOff + nrmLen * 4;
  const total = idxOff + idxLen * 4;

  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  let o = 0;
  dv.setUint32(o, 0x4946_4e53, true); o += 4; // magic "IFNS"
  dv.setUint32(o, 1, true); o += 4;           // version
  dv.setUint32(o, 1, true); o += 4;           // templateCount
  dv.setUint32(o, 1, true); o += 4;           // instanceCount
  dv.setUint32(o, posLen, true); o += 4;
  dv.setUint32(o, nrmLen, true); o += 4;
  dv.setUint32(o, idxLen, true); o += 4;
  dv.setUint32(o, 0, true); o += 4;           // reserved

  // Template record: posOff,posLen,nrmOff,nrmLen,idxOff,idxLen (element counts) + origin f64x3
  o = templateTableOff;
  dv.setUint32(o, 0, true); o += 4;   // posOff (element index)
  dv.setUint32(o, posLen, true); o += 4;
  dv.setUint32(o, 0, true); o += 4;   // nrmOff
  dv.setUint32(o, nrmLen, true); o += 4;
  dv.setUint32(o, 0, true); o += 4;   // idxOff
  dv.setUint32(o, idxLen, true); o += 4;
  dv.setFloat64(o, 0, true); o += 8;  // originX
  dv.setFloat64(o, 0, true); o += 8;  // originY
  dv.setFloat64(o, 0, true); o += 8;  // originZ

  // Instance record: templateIndex, entityId, color(4xf32), transform(16xf32 identity)
  o = instanceTableOff;
  dv.setUint32(o, 0, true); o += 4;
  dv.setUint32(o, entityId, true); o += 4;
  dv.setFloat32(o, 1, true); o += 4;
  dv.setFloat32(o, 1, true); o += 4;
  dv.setFloat32(o, 1, true); o += 4;
  dv.setFloat32(o, 1, true); o += 4;
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const v of identity) { dv.setFloat32(o, v, true); o += 4; }

  // Data: positions/normals (a degenerate but well-formed triangle), indices.
  const positions = new Float32Array(buf, posOff, posLen);
  positions.set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const normals = new Float32Array(buf, nrmOff, nrmLen);
  normals.set([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const indices = new Uint32Array(buf, idxOff, idxLen);
  indices.set([0, 1, 2]);

  return buf;
}
