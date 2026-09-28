/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import type { CoordinateInfo, MeshData } from '@ifc-lite/geometry';
import { BufferWriter } from '../utils/buffer-utils.js';
import { readGeometryV13 } from './geometry-chunks.js';
import { MESH_FINISH_BYTES, meshRecordByteLength, writeMeshRecord } from './geometry.js';

const point = { x: 0, y: 0, z: 0 };

function writeVec3(writer: BufferWriter, value: { x: number; y: number; z: number }): void {
  writer.writeFloat64(value.x);
  writer.writeFloat64(value.y);
  writer.writeFloat64(value.z);
}

/** Write the literal v3-v19 CoordinateInfo prefix, with no v20 frame byte. */
function writeV19CoordinateInfo(writer: BufferWriter, info: CoordinateInfo): void {
  writeVec3(writer, info.originShift);
  writeVec3(writer, info.originalBounds.min);
  writeVec3(writer, info.originalBounds.max);
  writeVec3(writer, info.shiftedBounds.min);
  writeVec3(writer, info.shiftedBounds.max);
  writer.writeUint8(info.hasLargeCoordinates ? 1 : 0);
  writer.writeUint8(info.wasmRtcOffset === undefined ? 0 : 1);
  if (info.wasmRtcOffset) writeVec3(writer, info.wasmRtcOffset);
  writer.writeUint8(info.buildingRotation === undefined ? 0 : 1);
  if (info.buildingRotation !== undefined) writer.writeFloat64(info.buildingRotation);
}

function genuineV19GeometrySection(mesh: MeshData, info: CoordinateInfo): ArrayBuffer {
  const record = new BufferWriter();
  writeMeshRecord(record, mesh);
  expect(record.position).toBe(meshRecordByteLength(mesh));
  // A genuine v19 record ends before the v22 finish trailer.
  const recordBytes = new Uint8Array(record.build()).subarray(0, meshRecordByteLength(mesh) - MESH_FINISH_BYTES);

  const head = new BufferWriter();
  head.writeUint32(1); // mesh count
  head.writeUint32(3); // total vertices
  head.writeUint32(1); // total triangles
  writeV19CoordinateInfo(head, info);
  head.writeUint32(0); // v19 canonical-appearance source pool
  head.writeUint32(1); // chunk count

  const directoryBytes = 44;
  const headLength = head.position + directoryBytes;
  const output = new BufferWriter();
  output.writeUint32(headLength);
  output.writeBytes(new Uint8Array(head.build()));
  for (const value of [0, 0, 0, 1, 1, 0]) output.writeFloat32(value);
  output.writeUint32(4 + headLength);
  output.writeUint32(recordBytes.byteLength);
  output.writeUint32(recordBytes.byteLength);
  output.writeUint32(1);
  output.writeUint32(0); // uncompressed
  output.writeBytes(recordBytes);
  return output.build();
}

describe('v19 full geometry-section compatibility (#4799)', () => {
  it('opens the real preceding header layout and decodes its chunk without inventing an RTC frame', async () => {
    const info: CoordinateInfo = {
      originShift: { x: 4, y: 5, z: 6 },
      originalBounds: { min: point, max: { x: 1, y: 1, z: 0 } },
      shiftedBounds: { min: { x: -4, y: -5, z: -6 }, max: { x: -3, y: -4, z: -6 } },
      hasLargeCoordinates: true,
      wasmRtcOffset: { x: Number.NaN, y: Number.POSITIVE_INFINITY, z: Number.NEGATIVE_INFINITY },
      buildingRotation: 0.25,
    };
    const mesh: MeshData = {
      expressId: 42,
      ifcType: 'IFCWALL',
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
      color: [0.5, 0.25, 0.125, 1],
    };

    const restored = await readGeometryV13(genuineV19GeometrySection(mesh, info), 0, 19);

    expect(restored.coordinateInfo).toMatchObject(info);
    expect(restored.coordinateInfo.wasmRtcFrame).toBeUndefined();
    expect(restored.meshes).toHaveLength(1);
    expect(restored.meshes[0].expressId).toBe(42);
    expect(restored.meshes[0].positions).toEqual(mesh.positions);
    expect(restored.meshes[0].indices).toEqual(mesh.indices);
  });
});
