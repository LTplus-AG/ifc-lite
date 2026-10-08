/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { IfcParser } from '@ifc-lite/parser';
import capture from './coordinate-info-c20-capture.json';
import { BufferReader, BufferWriter } from '../utils/buffer-utils.js';
import { readCoordinateInfo, writeCoordinateInfo } from './coordinate-info.js';
import { buildGeometrySectionV13, readGeometryV13 } from './geometry-chunks.js';
import { BinaryCacheWriter } from '../writer.js';
import { BinaryCacheReader } from '../reader.js';
import { toCacheDataStore } from '../adapt.js';

// #7239: native fresh-load C20 snapshot, retained with source/capture provenance.
// This is a metadata transport invariant; no meshes or rendered parity are claimed.
const capturedInfo: CoordinateInfo = capture.coordinateInfo;

function encode(info: CoordinateInfo): ArrayBuffer {
  const writer = new BufferWriter();
  writeCoordinateInfo(writer, info);
  return writer.build();
}

describe('complete CoordinateInfo cache transport (#7239)', () => {
  it('preserves the native C20 fresh-load snapshot, including a known zero recovery count', () => {
    expect(readCoordinateInfo(new BufferReader(encode(capturedInfo)), 24)).toEqual(capturedInfo);
  });

  it('preserves that snapshot through the actual geometry-section head and directory', async () => {
    const section = await buildGeometrySectionV13([], capturedInfo);
    const result = await readGeometryV13(section, 0, 24);
    expect(result.coordinateInfo).toEqual(capturedInfo);
    expect(result.meshes).toEqual([]);
    expect(result.totalVertices).toBe(0);
    expect(result.totalTriangles).toBe(0);
  });

  it.each([
    [undefined, undefined], [0, undefined], [undefined, 0.001],
    [0, 1], [7, 0.001], [3, 0.3048],
  ])('keeps absence distinct from defined scalars: count=%s, scale=%s', (count, scale) => {
    const info = { ...capturedInfo, boundsRecoveryFallbackCount: count, lengthUnitScale: scale };
    const result = readCoordinateInfo(new BufferReader(encode(info)), 24);
    expect(result).toEqual(info);
    expect(result.boundsRecoveryFallbackCount).toBe(count);
    expect(result.lengthUnitScale).toBe(scale);
  });

  it('routes the metadata through the public writer/reader with an actual STEP-parsed store', async () => {
    const bytes = readFileSync(new URL('../../../../apps/viewer/public/samples/building-architecture.ifc', import.meta.url));
    const source = Uint8Array.from(bytes).buffer;
    const store = await new IfcParser().parseColumnar(source, { disableWorkerScan: true });
    expect(store.entities.count).toBeGreaterThan(0);
    // The retained C20 snapshot is the caller-supplied metadata payload here;
    // the sample STEP store exercises real header/section routing, not meshing.
    const cache = await new BinaryCacheWriter().write(toCacheDataStore(store), {
      meshes: [], totalVertices: 0, totalTriangles: 0, coordinateInfo: capturedInfo,
    }, source);
    const reader = new BinaryCacheReader();
    expect(reader.readHeader(cache).version).toBe(24);
    expect(reader.validate(cache, source)).toBe(true);
    expect((await reader.read(cache)).geometry?.coordinateInfo).toEqual(capturedInfo);
  });

  it('leaves missing pre-v24 metadata unknown without consuming the next field', () => {
    const legacy = encode(capturedInfo).slice(0, -18); // two present f64 scalars
    const writer = new BufferWriter();
    writer.writeBytes(new Uint8Array(legacy));
    writer.writeUint32(0x12345678);
    for (const version of [20, 21, 22, 23]) {
      const reader = new BufferReader(writer.build());
      const result = readCoordinateInfo(reader, version);
      expect(result.wasmRtcFrame).toEqual(capturedInfo.wasmRtcFrame);
      expect(result.boundsRecoveryFallbackCount).toBeUndefined();
      expect(result.lengthUnitScale).toBeUndefined();
      expect(reader.readUint32()).toBe(0x12345678);
    }
  });

  it.each(['boundsRecoveryFallbackCount', 'lengthUnitScale'] as const)(
    'rejects malformed presence flags and truncated %s payloads', (field) => {
      const bytes = new Uint8Array(encode(capturedInfo));
      const flagIndex = bytes.length - (field === 'boundsRecoveryFallbackCount' ? 18 : 9);
      bytes[flagIndex] = 2;
      expect(() => readCoordinateInfo(new BufferReader(bytes.buffer), 24)).toThrow(
        `Invalid ${field} presence flag`,
      );
      bytes[flagIndex] = 1;
      expect(() => readCoordinateInfo(new BufferReader(bytes.slice(0, flagIndex + 1).buffer), 24))
        .toThrow(/past end/);
    },
  );
});
