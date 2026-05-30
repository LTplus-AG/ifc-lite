/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compact binary codec for a single `MeshData` (plan §4.2 — mesh-blob path).
 *
 * Tessellated meshes are seeded into the collab room as content-addressed
 * blobs so a recipient with no source file can reconstruct geometry. This
 * encodes one mesh to a self-describing little-endian buffer and back. Vertex
 * arrays are length-delimited and 4-byte aligned so they decode by copy
 * without alignment hazards.
 *
 * Layout (LE):
 *   u32 magic 'IFCM' | u16 version | u16 reserved
 *   i32 expressId | f32×4 color
 *   u32 ifcTypeByteLen | utf8 bytes (padded to 4)
 *   u32 posLen | f32×posLen
 *   u32 normLen | f32×normLen
 *   u32 idxLen  | u32×idxLen
 */

import type { MeshData } from '@ifc-lite/geometry';

const MAGIC = 0x4d434649; // 'IFCM'
const VERSION = 1;

const align4 = (n: number): number => (n + 3) & ~3;

export function encodeMesh(mesh: MeshData): Uint8Array {
  const enc = new TextEncoder();
  const typeBytes = enc.encode(mesh.ifcType ?? '');
  const typePadded = align4(typeBytes.length);

  const size =
    4 + 2 + 2 + // magic, version, reserved
    4 + 16 + // expressId, color
    4 + typePadded + // ifcType
    4 + mesh.positions.length * 4 +
    4 + mesh.normals.length * 4 +
    4 + mesh.indices.length * 4;

  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let o = 0;

  dv.setUint32(o, MAGIC, true); o += 4;
  dv.setUint16(o, VERSION, true); o += 2;
  dv.setUint16(o, 0, true); o += 2;
  dv.setInt32(o, mesh.expressId, true); o += 4;
  for (let i = 0; i < 4; i++) { dv.setFloat32(o, mesh.color[i] ?? 0, true); o += 4; }

  dv.setUint32(o, typeBytes.length, true); o += 4;
  u8.set(typeBytes, o); o += typePadded;

  o = writeFloatArray(dv, u8, o, mesh.positions);
  o = writeFloatArray(dv, u8, o, mesh.normals);

  dv.setUint32(o, mesh.indices.length, true); o += 4;
  u8.set(new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength), o);
  o += mesh.indices.length * 4;

  return u8;
}

function writeFloatArray(dv: DataView, u8: Uint8Array, o: number, arr: Float32Array): number {
  dv.setUint32(o, arr.length, true);
  o += 4;
  u8.set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), o);
  return o + arr.length * 4;
}

export function decodeMesh(bytes: Uint8Array): MeshData {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;

  if (dv.getUint32(o, true) !== MAGIC) throw new Error('mesh-codec: bad magic');
  o += 4;
  const version = dv.getUint16(o, true); o += 2;
  if (version !== VERSION) throw new Error(`mesh-codec: unsupported version ${version}`);
  o += 2; // reserved

  const expressId = dv.getInt32(o, true); o += 4;
  const color: [number, number, number, number] = [
    dv.getFloat32(o, true), dv.getFloat32(o + 4, true),
    dv.getFloat32(o + 8, true), dv.getFloat32(o + 12, true),
  ];
  o += 16;

  const typeLen = dv.getUint32(o, true); o += 4;
  const ifcType = new TextDecoder().decode(bytes.subarray(o, o + typeLen));
  o += align4(typeLen);

  const positions = readFloatArray(bytes, dv, o); o = positions.next;
  const normals = readFloatArray(bytes, dv, o); o = normals.next;

  const idxLen = dv.getUint32(o, true); o += 4;
  const idxBytes = bytes.slice(o, o + idxLen * 4);
  const indices = new Uint32Array(idxBytes.buffer, idxBytes.byteOffset, idxLen);

  return {
    expressId,
    ifcType: ifcType || undefined,
    positions: positions.arr,
    normals: normals.arr,
    indices,
    color,
  };
}

function readFloatArray(bytes: Uint8Array, dv: DataView, o: number): { arr: Float32Array; next: number } {
  const len = dv.getUint32(o, true);
  o += 4;
  // `.slice` copies into a fresh, 4-aligned buffer so the view is always valid.
  const copy = bytes.slice(o, o + len * 4);
  const arr = new Float32Array(copy.buffer, copy.byteOffset, len);
  return { arr, next: o + len * 4 };
}
