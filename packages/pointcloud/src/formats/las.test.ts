/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { decodeLasPoints, parseLasHeader, sampleMaxRgbChannel } from './las.js';

function buildHeader(overrides: Partial<{
  versionMinor: number;
  pointDataFormatId: number;
  pointRecordLength: number;
  pointCount: number;
  scale: [number, number, number];
  offset: [number, number, number];
  bbox: { min: [number, number, number]; max: [number, number, number] };
}> = {}): { header: Uint8Array; total: number } {
  const versionMinor = overrides.versionMinor ?? 2;
  const fmt = overrides.pointDataFormatId ?? 0;
  const reclen = overrides.pointRecordLength ?? 20;
  const count = overrides.pointCount ?? 0;
  const scale = overrides.scale ?? [0.01, 0.01, 0.01];
  const offset = overrides.offset ?? [0, 0, 0];
  const bbox = overrides.bbox ?? { min: [0, 0, 0], max: [0, 0, 0] };

  const buf = new ArrayBuffer(227);
  const view = new DataView(buf);
  view.setUint32(0, 0x4653414c, true);   // "LASF"
  view.setUint8(24, 1);                  // version major
  view.setUint8(25, versionMinor);
  view.setUint16(94, 227, true);         // header size
  view.setUint32(96, 227, true);         // point data offset
  view.setUint32(100, 0, true);          // VLR count
  view.setUint8(104, fmt);
  view.setUint16(105, reclen, true);
  view.setUint32(107, count, true);
  view.setFloat64(131, scale[0], true);
  view.setFloat64(139, scale[1], true);
  view.setFloat64(147, scale[2], true);
  view.setFloat64(155, offset[0], true);
  view.setFloat64(163, offset[1], true);
  view.setFloat64(171, offset[2], true);
  view.setFloat64(179, bbox.max[0], true);
  view.setFloat64(187, bbox.min[0], true);
  view.setFloat64(195, bbox.max[1], true);
  view.setFloat64(203, bbox.min[1], true);
  view.setFloat64(211, bbox.max[2], true);
  view.setFloat64(219, bbox.min[2], true);
  return { header: new Uint8Array(buf), total: 227 };
}

function buildFormat0Records(rows: Array<{ x: number; y: number; z: number; intensity?: number; classification?: number }>): Uint8Array {
  const buf = new ArrayBuffer(rows.length * 20);
  const view = new DataView(buf);
  for (let i = 0; i < rows.length; i++) {
    const off = i * 20;
    view.setInt32(off, rows[i].x, true);
    view.setInt32(off + 4, rows[i].y, true);
    view.setInt32(off + 8, rows[i].z, true);
    view.setUint16(off + 12, rows[i].intensity ?? 0, true);
    view.setUint8(off + 15, rows[i].classification ?? 0);
    // bytes 13, 14, 16, 17, 18, 19 = bit flags / scan angle / user data — leave 0
  }
  return new Uint8Array(buf);
}

function buildFormat3Records(rows: Array<{
  x: number; y: number; z: number;
  intensity?: number; classification?: number;
  r: number; g: number; b: number;
}>): Uint8Array {
  // Format 3 = 34 bytes: 20 (format 0) + 8 (gps time) + 6 (rgb)
  const buf = new ArrayBuffer(rows.length * 34);
  const view = new DataView(buf);
  for (let i = 0; i < rows.length; i++) {
    const off = i * 34;
    view.setInt32(off, rows[i].x, true);
    view.setInt32(off + 4, rows[i].y, true);
    view.setInt32(off + 8, rows[i].z, true);
    view.setUint16(off + 12, rows[i].intensity ?? 0, true);
    view.setUint8(off + 15, rows[i].classification ?? 0);
    view.setFloat64(off + 20, 0, true);
    view.setUint16(off + 28, rows[i].r, true);
    view.setUint16(off + 30, rows[i].g, true);
    view.setUint16(off + 32, rows[i].b, true);
  }
  return new Uint8Array(buf);
}

describe('parseLasHeader', () => {
  it('reads format-0 LAS 1.2 header fields', () => {
    const { header } = buildHeader({
      versionMinor: 2,
      pointDataFormatId: 0,
      pointRecordLength: 20,
      pointCount: 1234,
      scale: [0.001, 0.001, 0.001],
      offset: [100, 200, 0],
      bbox: { min: [-1, -2, -3], max: [4, 5, 6] },
    });
    const h = parseLasHeader(header);
    expect(h.versionMajor).toBe(1);
    expect(h.versionMinor).toBe(2);
    expect(h.pointDataFormatId).toBe(0);
    expect(h.pointRecordLength).toBe(20);
    expect(h.pointCount).toBe(1234);
    expect(h.scale).toEqual([0.001, 0.001, 0.001]);
    expect(h.offset).toEqual([100, 200, 0]);
    expect(h.bbox).toEqual({ min: [-1, -2, -3], max: [4, 5, 6] });
    expect(h.hasGpsTime).toBe(false);
    expect(h.hasRgb).toBe(false);
  });

  it('flags formats 1 and 3 as gps + rgb', () => {
    const { header: hF1 } = buildHeader({ pointDataFormatId: 1, pointRecordLength: 28 });
    const { header: hF3 } = buildHeader({ pointDataFormatId: 3, pointRecordLength: 34 });
    expect(parseLasHeader(hF1).hasGpsTime).toBe(true);
    expect(parseLasHeader(hF1).hasRgb).toBe(false);
    expect(parseLasHeader(hF3).hasGpsTime).toBe(true);
    expect(parseLasHeader(hF3).hasRgb).toBe(true);
  });

  it('rejects bad magic', () => {
    const buf = new Uint8Array(227);
    expect(() => parseLasHeader(buf)).toThrow();
  });

  it('rejects record length smaller than format baseline', () => {
    const { header } = buildHeader({ pointDataFormatId: 3, pointRecordLength: 28 });
    expect(() => parseLasHeader(header)).toThrow();
  });
});

describe('decodeLasPoints', () => {
  it('decodes format-0 points with scale + offset', () => {
    const { header } = buildHeader({
      pointDataFormatId: 0,
      pointRecordLength: 20,
      pointCount: 3,
      scale: [0.01, 0.01, 0.1],
      offset: [10, 20, 30],
    });
    const h = parseLasHeader(header);
    const records = buildFormat0Records([
      { x: 100, y: 200, z: 50, intensity: 42, classification: 2 },
      { x: -100, y: -200, z: -50, intensity: 7, classification: 6 },
      { x: 0, y: 0, z: 0, classification: 1 },
    ]);
    const chunk = decodeLasPoints(records, h, 3, 20);
    expect(chunk.pointCount).toBe(3);
    // (100*0.01)+10 = 11; (-100*0.01)+10 = 9; (0*0.01)+10 = 10
    expect(Array.from(chunk.positions.subarray(0, 3))).toEqual([11, 22, 35]);
    expect(Array.from(chunk.positions.subarray(3, 6))).toEqual([9, 18, 25]);
    expect(Array.from(chunk.positions.subarray(6, 9))).toEqual([10, 20, 30]);
    expect(Array.from(chunk.intensities!)).toEqual([42, 7, 0]);
    expect(Array.from(chunk.classifications!)).toEqual([2, 6, 1]);
    expect(chunk.colors).toBeUndefined();
    expect(chunk.bbox).toEqual({ min: [9, 18, 25], max: [11, 22, 35] });
  });

  it('decodes format-3 RGB points', () => {
    const { header } = buildHeader({
      pointDataFormatId: 3,
      pointRecordLength: 34,
      pointCount: 2,
      scale: [1, 1, 1],
    });
    const h = parseLasHeader(header);
    const records = buildFormat3Records([
      { x: 0, y: 0, z: 0, r: 65535, g: 0, b: 0 },          // pure red
      { x: 1, y: 2, z: 3, r: 32768, g: 32768, b: 32768 },  // mid gray
    ]);
    const chunk = decodeLasPoints(records, h, 2, 34);
    expect(chunk.colors).toBeDefined();
    expect(chunk.colors!.slice(0, 3)).toEqual(new Float32Array([1, 0, 0]));
    expect(chunk.colors![3]).toBeCloseTo(0.5, 2);
  });

  it('detects 8-bit-in-low-byte RGB and the rgbScale factor compensates', () => {
    const { header } = buildHeader({
      pointDataFormatId: 3,
      pointRecordLength: 34,
      pointCount: 1,
      scale: [1, 1, 1],
    });
    const h = parseLasHeader(header);
    // r=255 (8-bit) stored in u16 → value 255 (0x00ff). The sampler should
    // see this as the worst case and return 255.
    const records = buildFormat3Records([{ x: 0, y: 0, z: 0, r: 255, g: 128, b: 64 }]);
    const maxChannel = sampleMaxRgbChannel(records, h);
    expect(maxChannel).toBe(255);
    // Re-decode with rgbScale = 65535/255 ≈ 257 to expand to full 16-bit space
    const chunk = decodeLasPoints(records, h, 1, 34, 65535 / 255);
    expect(chunk.colors![0]).toBeCloseTo(1.0, 2);
    expect(chunk.colors![1]).toBeCloseTo(128 / 255, 2);
  });
});
