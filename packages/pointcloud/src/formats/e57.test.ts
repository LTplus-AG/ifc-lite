/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { parseE57FileHeader, stripPageCrc, decodeE57Scan, type Data3DEntry } from './e57.js';

const enc = new TextEncoder();

function buildHeader(opts: {
  fileLogicalSize?: number;
  xmlPhysicalOffset: number;
  xmlLogicalLength: number;
  pageSize?: number;
}): Uint8Array {
  const buf = new ArrayBuffer(48);
  const bytes = new Uint8Array(buf);
  bytes.set(enc.encode('ASTM-E57'), 0);
  const view = new DataView(buf);
  view.setUint32(8, 1, true);  // major
  view.setUint32(12, 0, true); // minor
  view.setBigUint64(16, BigInt(opts.fileLogicalSize ?? 0), true);
  view.setBigUint64(24, BigInt(opts.xmlPhysicalOffset), true);
  view.setBigUint64(32, BigInt(opts.xmlLogicalLength), true);
  view.setBigUint64(40, BigInt(opts.pageSize ?? 1024), true);
  return bytes;
}

describe('parseE57FileHeader', () => {
  it('reads valid header', () => {
    const bytes = buildHeader({ xmlPhysicalOffset: 1024, xmlLogicalLength: 4096 });
    const h = parseE57FileHeader(bytes);
    expect(h.majorVersion).toBe(1);
    expect(h.xmlLogicalLength).toBe(4096);
    expect(h.pageSize).toBe(1024);
  });

  it('rejects bad magic', () => {
    const bytes = new Uint8Array(48);
    expect(() => parseE57FileHeader(bytes)).toThrow();
  });

  it('rejects too-short input', () => {
    const bytes = new Uint8Array(40);
    expect(() => parseE57FileHeader(bytes)).toThrow();
  });
});

describe('stripPageCrc', () => {
  it('drops the last 4 bytes of every full page', () => {
    // 3 full pages of 16 bytes each (12 payload + 4 CRC).
    const PAGE = 16;
    const PAY = PAGE - 4;
    const input = new Uint8Array(3 * PAGE);
    // Fill payload bytes with their global payload index, CRC bytes with 0xFF.
    for (let p = 0; p < 3; p++) {
      for (let i = 0; i < PAGE; i++) {
        input[p * PAGE + i] = i < PAY ? (p * PAY + i) & 0xff : 0xff;
      }
    }
    const out = stripPageCrc(input, PAGE);
    expect(out.length).toBe(3 * PAY);
    // Verify no 0xFF (the CRC bytes) leaked through.
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBe(i & 0xff);
    }
  });

  it('keeps the partial trailing page minus its 4 CRC bytes', () => {
    const PAGE = 16;
    const PAY = PAGE - 4;
    // 1 full page + 10 bytes of partial. Partial includes 4 CRC at end → 6 payload bytes.
    const total = PAGE + 10;
    const input = new Uint8Array(total);
    for (let i = 0; i < total; i++) input[i] = i & 0xff;
    const out = stripPageCrc(input, PAGE);
    expect(out.length).toBe(PAY + 6);
  });
});

describe('decodeE57Scan (uncompressed Float64)', () => {
  it('decodes a tiny single-packet scan with cartesianX/Y/Z double + colorRed/Green/Blue uint8', () => {
    // We hand-build one DataPacket carrying 2 points worth of fields.
    // Prototype: cartesianX, cartesianY, cartesianZ all Float64;
    //            colorRed, colorGreen, colorBlue all Integer u8.
    const points = [
      { x: 1.5, y: 2.5, z: -3.5, r: 200, g: 100, b: 50 },
      { x: 7.0, y: 8.0, z:  9.0, r: 255, g: 128, b:  64 },
    ];
    const numPoints = points.length;

    // Per-bytestream lengths
    const lenF64 = numPoints * 8;
    const lenU8 = numPoints * 1;
    const lengths = [lenF64, lenF64, lenF64, lenU8, lenU8, lenU8];
    const totalPayload = lengths.reduce((a, b) => a + b, 0);

    // Packet layout:
    //   [0]   packetType = 1 (data)
    //   [1]   packetFlags = 0
    //   [2-3] packetLogicalLength - 1 (u16 LE) — total bytes minus 1
    //   [4-5] bytestreamCount = 6 (u16 LE)
    //   [6..] bytestream lengths (6 × u16 LE) = 12 bytes
    //   [..]  payload (totalPayload bytes)
    //   [..]  4 bytes CRC (zeroed; ignored by decoder)
    const headerBytes = 4 + 2 + 6 * 2;
    const packetSize = headerBytes + totalPayload + 4;
    const buf = new ArrayBuffer(packetSize);
    const view = new DataView(buf);
    view.setUint8(0, 1);
    view.setUint8(1, 0);
    view.setUint16(2, packetSize - 1, true);
    view.setUint16(4, 6, true);
    for (let i = 0; i < 6; i++) view.setUint16(6 + i * 2, lengths[i], true);

    let cursor = headerBytes;
    // cartesianX
    for (let i = 0; i < numPoints; i++) view.setFloat64(cursor + i * 8, points[i].x, true);
    cursor += lenF64;
    // cartesianY
    for (let i = 0; i < numPoints; i++) view.setFloat64(cursor + i * 8, points[i].y, true);
    cursor += lenF64;
    // cartesianZ
    for (let i = 0; i < numPoints; i++) view.setFloat64(cursor + i * 8, points[i].z, true);
    cursor += lenF64;
    // colorRed
    for (let i = 0; i < numPoints; i++) view.setUint8(cursor + i, points[i].r);
    cursor += lenU8;
    // colorGreen
    for (let i = 0; i < numPoints; i++) view.setUint8(cursor + i, points[i].g);
    cursor += lenU8;
    // colorBlue
    for (let i = 0; i < numPoints; i++) view.setUint8(cursor + i, points[i].b);

    const logical = new Uint8Array(buf);

    const entry: Data3DEntry = {
      guid: 'test',
      recordCount: numPoints,
      binaryFileOffset: 0,
      prototype: [
        { name: 'cartesianX', kind: 'Float', precision: 'double' },
        { name: 'cartesianY', kind: 'Float', precision: 'double' },
        { name: 'cartesianZ', kind: 'Float', precision: 'double' },
        { name: 'colorRed', kind: 'Integer', minimum: 0, maximum: 255 },
        { name: 'colorGreen', kind: 'Integer', minimum: 0, maximum: 255 },
        { name: 'colorBlue', kind: 'Integer', minimum: 0, maximum: 255 },
      ],
    };

    const chunk = decodeE57Scan(logical, entry);
    expect(chunk.pointCount).toBe(2);
    expect(Array.from(chunk.positions)).toEqual([1.5, 2.5, -3.5, 7.0, 8.0, 9.0]);
    expect(chunk.colors).toBeDefined();
    expect(chunk.colors![0]).toBeCloseTo(200 / 255, 3);
    expect(chunk.colors![1]).toBeCloseTo(100 / 255, 3);
    expect(chunk.colors![2]).toBeCloseTo(50 / 255, 3);
    expect(chunk.bbox).toEqual({ min: [1.5, 2.5, -3.5], max: [7.0, 8.0, 9.0] });
  });

  it('throws clearly when prototype uses ScaledInteger for cartesian fields', () => {
    const entry: Data3DEntry = {
      guid: 'test',
      recordCount: 0,
      binaryFileOffset: 0,
      prototype: [
        { name: 'cartesianX', kind: 'ScaledInteger', scale: 0.001, offset: 0, minimum: 0, maximum: 1 },
        { name: 'cartesianY', kind: 'Float', precision: 'double' },
        { name: 'cartesianZ', kind: 'Float', precision: 'double' },
      ],
    };
    expect(() => decodeE57Scan(new Uint8Array(0), entry)).toThrow(/ScaledInteger/);
  });
});
