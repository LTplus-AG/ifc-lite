/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import {
  parseE57FileHeader,
  parseE57Xml,
  resolveCompressedVectorDataOffset,
  stripPageCrc,
  decodeE57Scan,
  type Data3DEntry,
} from './e57.js';

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

  it('decodes ScaledInteger cartesian streams (bit-packed integer codec)', () => {
    // Synthetic 2-point packet, bitsPerRecord=8 per axis (span = 255):
    //   minimum=-100, maximum=155, scale=0.01, offset=0
    //   bitsPerRecord = ceil(log2(255 - (-100) + 1)) = ceil(log2(256)) = 8
    // For each point we pack `raw_int = original - minimum` into the
    // bytestream; decoded float = (raw_int + minimum) * scale + offset.
    const buf = new ArrayBuffer(22);
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);

    view.setUint8(0, 1);              // packetType = data
    view.setUint8(1, 0);              // flags
    view.setUint16(2, 21, true);      // packetLogicalLength - 1 (total = 22)
    view.setUint16(4, 3, true);       // bytestreamCount
    view.setUint16(6, 2, true);       // X bytestream length
    view.setUint16(8, 2, true);       // Y bytestream length
    view.setUint16(10, 2, true);      // Z bytestream length

    // X: point0 raw=50 (→ −0.5), point1 raw=100 (→ 0.0)
    bytes[12] = 50;
    bytes[13] = 100;
    // Y: point0 raw=110 (→ 0.10), point1 raw=120 (→ 0.20)
    bytes[14] = 110;
    bytes[15] = 120;
    // Z: point0 raw=200 (→ 1.00), point1 raw=255 (→ 1.55)
    bytes[16] = 200;
    bytes[17] = 255;
    // bytes[18..21] = trailing 4-byte CRC (ignored)

    const entry: Data3DEntry = {
      guid: 'test',
      recordCount: 2,
      binaryFileOffset: 0,
      prototype: [
        { name: 'cartesianX', kind: 'ScaledInteger', scale: 0.01, offset: 0, minimum: -100, maximum: 155 },
        { name: 'cartesianY', kind: 'ScaledInteger', scale: 0.01, offset: 0, minimum: -100, maximum: 155 },
        { name: 'cartesianZ', kind: 'ScaledInteger', scale: 0.01, offset: 0, minimum: -100, maximum: 155 },
      ],
    };
    const chunk = decodeE57Scan(bytes, entry);
    expect(chunk.pointCount).toBe(2);
    expect(chunk.positions[0]).toBeCloseTo(-0.5, 5);
    expect(chunk.positions[1]).toBeCloseTo(0.10, 5);
    expect(chunk.positions[2]).toBeCloseTo(1.00, 5);
    expect(chunk.positions[3]).toBeCloseTo(0.0, 5);
    expect(chunk.positions[4]).toBeCloseTo(0.20, 5);
    expect(chunk.positions[5]).toBeCloseTo(1.55, 5);
  });

  it('decodes ScaledInteger streams with bitsPerRecord that crosses byte boundaries', () => {
    // bitsPerRecord = 12 (min=0, max=4095, span=4095). Two values
    // pack into 3 bytes LSB-first:
    //   value0 = 0xABC, value1 = 0xDEF
    //   byte 0 = value0 & 0xFF                   = 0xBC
    //   byte 1 = (value0 >> 8) | ((value1 & 0xF) << 4) = 0xA | 0xF0 = 0xFA
    //   byte 2 = value1 >> 4                     = 0xDE
    // With scale=1, offset=0, minimum=0 the decoded floats round-trip
    // to the original raw_int, so we just check the cartesian values.
    const packetLogicalLength = 4 + 2 + 2 + 3 + 4; // header + count + length + payload + CRC
    const totalBytes = packetLogicalLength;
    const buf = new ArrayBuffer(totalBytes);
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);
    view.setUint8(0, 1);
    view.setUint8(1, 0);
    view.setUint16(2, packetLogicalLength - 1, true);
    view.setUint16(4, 1, true);          // 1 bytestream (we'll use only X to keep it minimal)
    view.setUint16(6, 3, true);          // bytestream length = 3
    bytes[8] = 0xBC;
    bytes[9] = 0xFA;
    bytes[10] = 0xDE;

    // recordCount=2; Y/Z would be required by decodeE57Scan, so use a
    // 3-axis prototype and stuff Y/Z into the same bytestream by
    // declaring 3 streams of 1 byte each. Easier: drop down to a
    // 1-stream test that only has X — but decodeE57Scan demands all
    // three. Build a complete 3-stream packet with the bit-packed X.
    const fullLen = 4 + 2 + 2*3 + 3 + 1 + 1 + 4;
    const fullBuf = new ArrayBuffer(fullLen);
    const fv = new DataView(fullBuf);
    const fb = new Uint8Array(fullBuf);
    fv.setUint8(0, 1);
    fv.setUint8(1, 0);
    fv.setUint16(2, fullLen - 1, true);
    fv.setUint16(4, 3, true);
    fv.setUint16(6, 3, true);  // X length (3 bytes for 2×12-bit values)
    fv.setUint16(8, 1, true);  // Y length (1 byte, bitsPerRecord=4 covers 2 values)
    fv.setUint16(10, 1, true); // Z length
    fb[12] = 0xBC;
    fb[13] = 0xFA;
    fb[14] = 0xDE;
    fb[15] = 0x32; // Y: low nibble = 2, high nibble = 3 (LSB first)
    fb[16] = 0x54; // Z: low nibble = 4, high nibble = 5

    const entry: Data3DEntry = {
      guid: 'test',
      recordCount: 2,
      binaryFileOffset: 0,
      prototype: [
        // X: 12-bit, raw bytes pack [0xBC, 0xFA, 0xDE] → [0xABC, 0xDEF]
        { name: 'cartesianX', kind: 'ScaledInteger', scale: 1, offset: 0, minimum: 0, maximum: 4095 },
        // Y: 4-bit, raw [0x2, 0x3]
        { name: 'cartesianY', kind: 'ScaledInteger', scale: 1, offset: 0, minimum: 0, maximum: 15 },
        // Z: 4-bit, raw [0x4, 0x5]
        { name: 'cartesianZ', kind: 'ScaledInteger', scale: 1, offset: 0, minimum: 0, maximum: 15 },
      ],
    };
    const chunk = decodeE57Scan(fb, entry);
    expect(chunk.pointCount).toBe(2);
    // (raw + minimum) * scale + offset, with min=0 scale=1 offset=0 → raw
    expect(chunk.positions[0]).toBe(0xABC);
    expect(chunk.positions[1]).toBe(0x2);
    expect(chunk.positions[2]).toBe(0x4);
    expect(chunk.positions[3]).toBe(0xDEF);
    expect(chunk.positions[4]).toBe(0x3);
    expect(chunk.positions[5]).toBe(0x5);
  });
});

describe('parseE57Xml (worker-safe; no DOMParser dependency)', () => {
  it('extracts scans + prototype fields from a representative XML body', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<e57Root type="Structure">
  <formatName type="String">ASTM E57 3D Imaging Data File</formatName>
  <data3D type="Vector" allowHeterogeneousChildren="0">
    <vectorChild type="Structure">
      <guid type="String">{abc-1}</guid>
      <name type="String">Scan One</name>
      <points type="CompressedVector" fileOffset="1024" recordCount="3">
        <prototype type="Structure">
          <cartesianX type="Float" precision="double"/>
          <cartesianY type="Float" precision="double"/>
          <cartesianZ type="Float" precision="double"/>
          <colorRed type="Integer" minimum="0" maximum="255"/>
          <colorGreen type="Integer" minimum="0" maximum="255"/>
          <colorBlue type="Integer" minimum="0" maximum="255"/>
        </prototype>
        <codecs type="Vector" allowHeterogeneousChildren="1"/>
      </points>
    </vectorChild>
    <vectorChild type="Structure">
      <guid type="String">{abc-2}</guid>
      <points type="CompressedVector" fileOffset="65536" recordCount="42">
        <prototype type="Structure">
          <cartesianX type="ScaledInteger" scale="0.0001" offset="0" minimum="-1000" maximum="1000"/>
          <cartesianY type="ScaledInteger" scale="0.0001" offset="0" minimum="-1000" maximum="1000"/>
          <cartesianZ type="ScaledInteger" scale="0.0001" offset="0" minimum="-1000" maximum="1000"/>
        </prototype>
      </points>
    </vectorChild>
  </data3D>
</e57Root>`;

    const entries = parseE57Xml(xml);
    expect(entries).toHaveLength(2);

    expect(entries[0].guid).toBe('{abc-1}');
    expect(entries[0].name).toBe('Scan One');
    expect(entries[0].binaryFileOffset).toBe(1024);
    expect(entries[0].recordCount).toBe(3);
    expect(entries[0].prototype).toHaveLength(6);
    expect(entries[0].prototype[0]).toEqual({
      name: 'cartesianX', kind: 'Float', precision: 'double',
    });
    expect(entries[0].prototype[3]).toMatchObject({
      name: 'colorRed', kind: 'Integer', minimum: 0, maximum: 255,
    });

    expect(entries[1].binaryFileOffset).toBe(65536);
    expect(entries[1].prototype[0]).toMatchObject({
      name: 'cartesianX', kind: 'ScaledInteger', scale: 0.0001,
    });
  });

  it('throws when root is not <e57Root>', () => {
    expect(() => parseE57Xml('<other/>')).toThrow(/e57Root/);
  });

  it('extracts <pose> rotation + translation when present', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<e57Root type="Structure">
  <data3D type="Vector">
    <vectorChild type="Structure">
      <points type="CompressedVector" fileOffset="1024" recordCount="1">
        <prototype type="Structure">
          <cartesianX type="Float" precision="double"/>
        </prototype>
      </points>
      <pose type="Structure">
        <rotation type="Structure"><w type="Float">0.7071067811865476</w><x type="Float">0</x><y type="Float">0</y><z type="Float">0.7071067811865476</z></rotation>
        <translation type="Structure"><x type="Float">10</x><y type="Float">3.5</y><z type="Float">-2</z></translation>
      </pose>
    </vectorChild>
    <vectorChild type="Structure">
      <points type="CompressedVector" fileOffset="2048" recordCount="1">
        <prototype type="Structure">
          <cartesianX type="Float" precision="double"/>
        </prototype>
      </points>
    </vectorChild>
  </data3D>
</e57Root>`;
    const entries = parseE57Xml(xml);
    expect(entries).toHaveLength(2);
    expect(entries[0].pose).toBeDefined();
    expect(entries[0].pose!.rotation.w).toBeCloseTo(0.7071, 3);
    expect(entries[0].pose!.rotation.z).toBeCloseTo(0.7071, 3);
    expect(entries[0].pose!.translation.x).toBe(10);
    expect(entries[0].pose!.translation.y).toBe(3.5);
    expect(entries[0].pose!.translation.z).toBe(-2);
    expect(entries[1].pose).toBeUndefined();
  });
});

describe('applyPoseInPlace', () => {
  it('rotates 90° around Z + translates per the unit-quaternion convention', async () => {
    const { applyPoseInPlace } = await import('./e57.js');
    // 90° rotation around +Z: q = (cos(45°), 0, 0, sin(45°))
    // (1, 0, 0) → (0, 1, 0); then translate (10, 0, 0) → (10, 1, 0)
    const positions = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    applyPoseInPlace(positions, 3, {
      rotation: { w: Math.SQRT1_2, x: 0, y: 0, z: Math.SQRT1_2 },
      translation: { x: 10, y: 0, z: 0 },
    });
    // Float32 lossy → use closeTo
    expect(positions[0]).toBeCloseTo(10, 5);  expect(positions[1]).toBeCloseTo(1, 5);  expect(positions[2]).toBeCloseTo(0, 5);
    expect(positions[3]).toBeCloseTo(9, 5);   expect(positions[4]).toBeCloseTo(0, 5);  expect(positions[5]).toBeCloseTo(0, 5);
    expect(positions[6]).toBeCloseTo(10, 5);  expect(positions[7]).toBeCloseTo(0, 5);  expect(positions[8]).toBeCloseTo(1, 5);
  });

  it('identity quaternion + zero translation is a no-op', async () => {
    const { applyPoseInPlace } = await import('./e57.js');
    const positions = new Float32Array([1.5, 2.5, 3.5]);
    applyPoseInPlace(positions, 1, {
      rotation: { w: 1, x: 0, y: 0, z: 0 },
      translation: { x: 0, y: 0, z: 0 },
    });
    expect(positions[0]).toBeCloseTo(1.5, 5);
    expect(positions[1]).toBeCloseTo(2.5, 5);
    expect(positions[2]).toBeCloseTo(3.5, 5);
  });
});

describe('resolveCompressedVectorDataOffset (E57 §6.4.2)', () => {
  it('reads the 32-byte section header and follows dataPhysicalOffset to the logical data start', () => {
    // Build a logical buffer where:
    //   bytes [0..32)   = section header at physical=0
    //   bytes [32..)    = section header at physical=64 (data starts here)
    //   bytes [64..)    = the bytes the section header "points at"
    //
    // We hand the function a logical buffer and a physical section
    // offset of 0; the section header it reads says
    // dataPhysicalOffset=64. It must convert that to the matching
    // LOGICAL offset (which equals 64 when both header and data are
    // inside page 0 so the CRC stripping doesn't shift anything).
    const buf = new ArrayBuffer(128);
    const bytes = new Uint8Array(buf);
    const view = new DataView(buf);
    // Section header @ offset 0
    view.setUint8(0, 1); // sectionId
    view.setBigUint64(8, 128n, true);   // sectionLogicalLength
    view.setBigUint64(16, 64n, true);    // dataPhysicalOffset
    view.setBigUint64(24, 0n, true);     // indexPhysicalOffset
    // Section header bytes happen to also look like a non-data packet
    // when read directly — proves why the resolver is needed.
    expect(view.getUint16(4, true)).toBe(0); // first u16 of length is 0

    const dataOffset = resolveCompressedVectorDataOffset(bytes, 0, 1024);
    // physicalToLogical(64, 1024) = 64 (still inside page 0).
    expect(dataOffset).toBe(64);
  });

  it('rejects a section header with the wrong sectionId', () => {
    const bytes = new Uint8Array(32);
    bytes[0] = 99; // wrong sectionId
    expect(() => resolveCompressedVectorDataOffset(bytes, 0, 1024))
      .toThrow(/section/i);
  });

  it('rejects when the section header runs past end of buffer', () => {
    const bytes = new Uint8Array(16); // smaller than 32-byte header
    expect(() => resolveCompressedVectorDataOffset(bytes, 0, 1024))
      .toThrow(/out of bounds|past end/i);
  });
});
