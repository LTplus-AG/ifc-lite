/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7350: the shared cache codec dropped optional per-piece metadata that a
 * fresh WASM load carries (`localBounds`, `localToWorld`, `shadingColor`).
 * These tests compare the WHOLE decoded MeshData against the input, so any
 * field the record silently omits fails here, not only the three named ones.
 */

import { describe, expect, it } from 'vitest';
import type { CoordinateInfo, MeshData } from '@ifc-lite/geometry';
import { BufferReader, BufferWriter } from '../utils/buffer-utils.js';
import { FORMAT_VERSION, GeometryChunkFlags } from '../types.js';
import { meshRecordByteLength, readMeshRecord, writeMeshRecord } from './geometry.js';
import { buildGeometrySectionV13, openGeometryChunksV13 } from './geometry-chunks.js';
import { MESH_METADATA_ABSENT_BYTES } from './mesh-metadata.js';

const point = { x: 0, y: 0, z: 0 };
const coordinateInfo: CoordinateInfo = {
  originShift: point, originalBounds: { min: point, max: point },
  shiftedBounds: { min: point, max: point }, hasLargeCoordinates: false,
};

/** Every optional field the per-mesh record persists, set to a non-default
 *  value. The localBounds values are the real C20 piece-0 bounds from the
 *  #7350 report (f32 at the WASM source), including its negative zero. */
function fullMesh(vertexCount = 3): MeshData {
  const positions = new Float32Array(vertexCount * 3);
  for (let i = 0; i < positions.length; i++) positions[i] = (i % 7) * 0.25;
  const normals = new Float32Array(vertexCount * 3).fill(0);
  for (let i = 2; i < normals.length; i += 3) normals[i] = 1;
  const indices = new Uint32Array([0, 1, 2]);
  return {
    expressId: 8970,
    ifcType: 'IFCWALL',
    positions,
    normals,
    indices,
    appearanceSource: { kind: 'canonical-item', indices, sourceIndices: indices },
    color: [0.5, 0.25, 0.125, 1],
    shadingColor: [0.75, 0.5, 0.25, 0.5],
    geometryItemId: 4638,
    material: { metallic: 0, roughness: 0.5 },
    geometryClass: 3,
    origin: [10.5, -20.25, 30],
    localBounds: {
      min: [1.4924999475479126, 0.23636400699615479, -2.507499933242798],
      max: [3.9075000286102295, 3.899899959564209, -0],
    },
    // f64 placement values no f32 can hold, so a narrowing codec fails.
    localToWorld: [
      0.1, 0, -0.9949874371066199, 2600000.123456789,
      0, 1, 0, 1.0000000000000002,
      0.9949874371066199, 0, 0.1, -1200000.987654321,
      0, 0, 0, 1,
    ],
  };
}

function roundTrip(mesh: MeshData, version: number = FORMAT_VERSION): MeshData {
  const writer = new BufferWriter();
  writeMeshRecord(writer, mesh);
  const bytes = writer.build();
  expect(bytes.byteLength).toBe(meshRecordByteLength(mesh));
  const reader = new BufferReader(bytes);
  const out = readMeshRecord(reader, version, 0);
  expect(reader.position).toBe(bytes.byteLength);
  return out;
}

describe('per-mesh optional metadata survives the cache codec (#7350)', () => {
  it('round-trips a mesh carrying every persisted optional field exactly', () => {
    const input = fullMesh();
    const out = roundTrip(input);
    expect(out).toEqual(input);
    expect(Object.is(out.localBounds!.max[2], -0)).toBe(true);
    expect(out.localToWorld).toStrictEqual(input.localToWorld);
  });

  it('round-trips the same mesh through a compressed geometry chunk', async () => {
    // >64 KiB of vertex data so the chunk takes the deflate path.
    const input = fullMesh(4096);
    const section = await buildGeometrySectionV13([input], coordinateInfo, { compress: true });
    const open = openGeometryChunksV13(section, 0, FORMAT_VERSION);
    expect(open.chunks).toHaveLength(1);
    expect(open.chunks[0].flags & GeometryChunkFlags.DeflateRaw).toBeTruthy();
    const [out] = await open.readChunk(0);
    expect(out).toEqual(input);
  });

  it('keeps absent fields absent, as missing own properties', () => {
    const { shadingColor: _s, localBounds: _b, localToWorld: _m, ...plain } = fullMesh();
    const out = roundTrip(plain);
    expect(Object.hasOwn(out, 'shadingColor')).toBe(false);
    expect(Object.hasOwn(out, 'localBounds')).toBe(false);
    expect(Object.hasOwn(out, 'localToWorld')).toBe(false);
    expect(out).toEqual(plain);
    expect(meshRecordByteLength(plain)).toBe(meshRecordByteLength(fullMesh()) - 16 - 24 - 128);
  });

  it('carries each field independently of the others', () => {
    const full = fullMesh();
    for (const key of ['shadingColor', 'localBounds', 'localToWorld'] as const) {
      const { shadingColor: _s, localBounds: _b, localToWorld: _m, ...plain } = full;
      const only: MeshData = { ...plain, [key]: full[key] };
      expect(roundTrip(only)).toEqual(only);
    }
  });

  it('reads a v24 record (no trailer) with the fields unknown rather than inferred', () => {
    const input = fullMesh();
    const writer = new BufferWriter();
    writeMeshRecord(writer, { ...input, shadingColor: undefined, localBounds: undefined, localToWorld: undefined });
    const v24 = writer.build().slice(0, -MESH_METADATA_ABSENT_BYTES);
    const reader = new BufferReader(v24);
    const out = readMeshRecord(reader, 24, 0);
    expect(reader.position).toBe(v24.byteLength);
    expect(out.localBounds).toBeUndefined();
    expect(out.localToWorld).toBeUndefined();
    expect(out.shadingColor).toBeUndefined();
    expect(out.origin).toEqual(input.origin);
  });

  it('rejects unknown flag bits and a truncated trailer', () => {
    const writer = new BufferWriter();
    writeMeshRecord(writer, fullMesh());
    const bytes = writer.build();
    const flagsAt = bytes.byteLength - 1 - 16 - 24 - 128;
    const unknown = bytes.slice(0);
    new DataView(unknown).setUint8(flagsAt, 0x08 | 0x07);
    expect(() => readMeshRecord(new BufferReader(unknown), FORMAT_VERSION)).toThrow(/metadata flags/);
    expect(() => readMeshRecord(new BufferReader(bytes.slice(0, -8)), FORMAT_VERSION)).toThrow(/past end/);
  });
});
