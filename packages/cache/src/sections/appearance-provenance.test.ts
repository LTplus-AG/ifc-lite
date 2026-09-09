/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it, expect } from 'vitest';
import type { MeshData, CoordinateInfo } from '@ifc-lite/geometry';
import { BufferReader, BufferWriter } from '../utils/buffer-utils.js';
import { writeMeshRecord, readMeshRecord, meshRecordByteLength, writeCoordinateInfo } from './geometry.js';
import { buildGeometrySectionV13, openGeometryChunksV13 } from './geometry-chunks.js';
import { FORMAT_VERSION } from '../types.js';
import { readSourcePool } from './appearance-provenance.js';
const point = { x: 0, y: 0, z: 0 };
const coordinateInfo: CoordinateInfo = { originShift: point, originalBounds: { min: point, max: point }, shiftedBounds: { min: point, max: point }, hasLargeCoordinates: false };
function mesh(): MeshData {
  const indices = new Uint32Array([0,1,2]);
  return { expressId: 10, geometryItemId: 14, indices, positions: new Float32Array([0,0,0,1,0,0,0,1,0]), normals: new Float32Array([0,0,1,0,0,1,0,0,1]), color: [1,1,1,1],
    appearanceSource: { kind: 'canonical-item', indices, sourceIndices: indices } };
}
function record(value: MeshData): ArrayBuffer { const writer = new BufferWriter(); writeMeshRecord(writer, value); expect(writer.position).toBe(meshRecordByteLength(value)); return writer.build(); }
describe('canonical cache provenance #4243', () => {
  it('restores the live index identity fence and never invents it for unmarked/old records', () => {
    const input = mesh(), bytes = record(input);
    const output = readMeshRecord(new BufferReader(bytes), FORMAT_VERSION);
    expect(output.appearanceSource?.indices).toBe(output.indices);
    expect(output.appearanceSource?.sourceIndices).toBe(output.indices);
    const plain = { ...input, appearanceSource: undefined };
    expect(readMeshRecord(new BufferReader(record(plain)), FORMAT_VERSION).appearanceSource).toBeUndefined();
    // v18 is the exact preceding record prefix; no provenance trailer exists.
    const previous = record(plain).slice(0, -1);
    const old = readMeshRecord(new BufferReader(previous), 18);
    expect(old.geometryItemId).toBe(14);
    expect(old.appearanceSource).toBeUndefined();
    expect(old.indices).toEqual(input.indices);
  });
  it('decodes the preceding v18 geometry head without consuming a nonexistent source pool', async () => {
    const input = { ...mesh(), appearanceSource: undefined };
    const oldRecord = record(input).slice(0, -1);
    const head = new BufferWriter();
    head.writeUint32(1); head.writeUint32(3); head.writeUint32(1);
    writeCoordinateInfo(head, coordinateInfo);
    head.writeUint32(1); // v18 chunk count, no v19 source pool.
    const headLength = head.position + 44;
    const out = new BufferWriter();
    out.writeUint32(headLength); out.writeBytes(new Uint8Array(head.build()));
    for (let i = 0; i < 6; i++) out.writeFloat32(0);
    for (const value of [headLength + 4, oldRecord.byteLength, oldRecord.byteLength, 1, 0]) out.writeUint32(value);
    out.writeBytes(new Uint8Array(oldRecord));
    const restored = (await openGeometryChunksV13(out.build(), 0, 18).readChunk(0))[0];
    expect(restored.indices).toEqual(input.indices);
    expect(restored.geometryItemId).toBe(14);
    expect(restored.appearanceSource).toBeUndefined();
  });
  it('preserves expanded current indices separately from canonical target topology', () => {
    const input = mesh();
    input.appearanceSource!.sourceIndices = new Uint32Array([0,0,1]);
    const output = readMeshRecord(new BufferReader(record(input)), FORMAT_VERSION);
    expect(output.appearanceSource?.indices).toBe(output.indices);
    expect(output.appearanceSource?.sourceIndices).toEqual(new Uint32Array([0,0,1]));
    expect(output.appearanceSource?.sourceIndices).not.toBe(output.indices);
  });
  it('deduplicates canonical source arrays across separately decoded spatial chunks', async () => {
    const sourceIndices = new Uint32Array([0,1,2,2,1,3]);
    const a = mesh(), b = mesh(); b.origin = [1000,0,0];
    a.appearanceSource = { kind: 'canonical-item', indices: a.indices, sourceIndices, cornerIndices: new Uint32Array([0,1,2]) };
    b.appearanceSource = { kind: 'canonical-item', indices: b.indices, sourceIndices, cornerIndices: new Uint32Array([3,4,5]) };
    const bytes = await buildGeometrySectionV13([a,b], coordinateInfo, { compress: false });
    const chunks = openGeometryChunksV13(bytes, 0, FORMAT_VERSION);
    expect(chunks.chunks).toHaveLength(2);
    expect(chunks.chunks[0].appearanceSources).toHaveLength(1);
    const first = (await chunks.readChunk(0))[0], second = (await chunks.readChunk(1))[0];
    expect(first.appearanceSource?.sourceIndices).toBe(second.appearanceSource?.sourceIndices);
    expect(second.appearanceSource?.cornerIndices).toEqual(new Uint32Array([3,4,5]));
    const firstChunk = chunks.chunks[0];
    // Pooled mode5 trailer: tag + source-pool id + three corner indices.
    new DataView(bytes).setUint32(firstChunk.byteOffset + firstChunk.byteLength - 16, 999, true);
    await expect(openGeometryChunksV13(bytes, 0, FORMAT_VERSION).readChunk(0)).rejects.toThrow(/provenance/);
  });
  it('rejects forged pool counts and lengths before allocating source arrays', () => {
    const pool = (count: number, length: number) => {
      const out = new BufferWriter(); out.writeUint32(count); out.writeUint32(length);
      return out.build();
    };
    expect(() => readSourcePool(new BufferReader(pool(2, 3)), 1, 8)).toThrow(/provenance/);
    expect(() => readSourcePool(new BufferReader(pool(1, 300_000_000)), 1, 8)).toThrow(/provenance/);
    // A forged header end cannot bypass the reader's actual buffer bounds.
    expect(() => readSourcePool(new BufferReader(pool(1, 300_000_000)), 1, 0xffffffff)).toThrow(/past end/);
    expect(() => readSourcePool(new BufferReader(pool(1, 4)), 1, 64)).toThrow(/provenance/);
  });
  it('refuses stale index identity, invalid corners and corrupted/truncated provenance records', () => {
    const stale = mesh(); stale.indices = stale.indices.slice();
    expect(() => record(stale)).toThrow(/provenance/);
    expect(() => record({ ...mesh(), geometryItemId: 2 ** 32 + 14 })).toThrow(/provenance/);
    const invalid = mesh(); invalid.appearanceSource!.cornerIndices = new Uint32Array([0,1,3]);
    expect(() => record(invalid)).toThrow(/provenance/);
    const input = mesh(); input.appearanceSource!.cornerIndices = new Uint32Array([0,1,2]);
    const bytes = record(input), tail = bytes.byteLength - 12;
    new DataView(bytes).setUint32(tail, 999, true);
    expect(() => readMeshRecord(new BufferReader(bytes), FORMAT_VERSION)).toThrow(/provenance/);
    expect(() => readMeshRecord(new BufferReader(record(input).slice(0,-1)), FORMAT_VERSION)).toThrow(/past end/);
    const length = record(input); new DataView(length).setUint32(length.byteLength - 24 - 4, 0xffffffff, true);
    expect(() => readMeshRecord(new BufferReader(length), FORMAT_VERSION)).toThrow(/provenance/);
  });
});
