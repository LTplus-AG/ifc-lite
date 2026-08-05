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

  it('accepts a fully-packed packet (bytestreams fill the packet exactly)', () => {
    // Regression for the false-positive packet-bounds guard that
    // assumed a 4-byte trailing CRC inside each DataPacket. CRCs are
    // page-level, not packet-level, so real exporters (Faro Focus,
    // Leica BLK) emit packets where the last bytestream ends at
    // `offset + packetLogicalLength` exactly. With the old guard
    // those packets failed with "bytestream X runs past packet payload".
    const numPoints = 3;
    const lenF64 = numPoints * 8;
    const lengths = [lenF64, lenF64, lenF64];
    const totalPayload = lengths.reduce((a, b) => a + b, 0);
    const headerBytes = 4 + 2 + 3 * 2;
    // No trailing slack: packet = header + payload, bytestreams fill it.
    const packetSize = headerBytes + totalPayload;
    const buf = new ArrayBuffer(packetSize);
    const view = new DataView(buf);
    view.setUint8(0, 1);
    view.setUint8(1, 0);
    view.setUint16(2, packetSize - 1, true);
    view.setUint16(4, 3, true);
    for (let i = 0; i < 3; i++) view.setUint16(6 + i * 2, lengths[i], true);
    let cursor = headerBytes;
    for (let i = 0; i < numPoints; i++) view.setFloat64(cursor + i * 8, i + 1, true);
    cursor += lenF64;
    for (let i = 0; i < numPoints; i++) view.setFloat64(cursor + i * 8, i + 10, true);
    cursor += lenF64;
    for (let i = 0; i < numPoints; i++) view.setFloat64(cursor + i * 8, i + 100, true);

    const entry: Data3DEntry = {
      guid: 'test',
      recordCount: numPoints,
      binaryFileOffset: 0,
      prototype: [
        { name: 'cartesianX', kind: 'Float', precision: 'double' },
        { name: 'cartesianY', kind: 'Float', precision: 'double' },
        { name: 'cartesianZ', kind: 'Float', precision: 'double' },
      ],
    };
    const chunk = decodeE57Scan(new Uint8Array(buf), entry);
    expect(chunk.pointCount).toBe(3);
    expect(Array.from(chunk.positions)).toEqual([1, 10, 100, 2, 11, 101, 3, 12, 102]);
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

  it('decodes classification and intensity (Integer kind) through the full scan pipeline', () => {
    // Mutation testing found decodeE57Scan's classification/intensity paths
    // had ZERO coverage anywhere in this package: no test built a packet
    // carrying a `classification` or `intensity` prototype field, so
    // `readClassificationStream`/`readIntensityStream` in e57-decode.ts
    // were exercised only by TypeScript, never by an assertion. A mutation
    // that broke either (e.g. subtracting `minimum` from a classification
    // Integer, which the source comment explicitly says NOT to do because
    // class IDs are absolute labels, not range-normalised offsets; or
    // flipping the sign in intensity's range-remap) ran green.
    //
    // `minimum` is deliberately non-zero on both fields so a stray
    // `+ minimum` / `- minimum` swap changes the decoded value — with
    // minimum=0 the two are indistinguishable.
    const points = [
      { x: 1, y: 2, z: 3, classification: 6, intensityRaw: 150 },
      { x: 4, y: 5, z: 6, classification: 15, intensityRaw: 200 },
    ];
    const numPoints = points.length;

    const lenF64 = numPoints * 8;
    const lenU8 = numPoints * 1;
    const lengths = [lenF64, lenF64, lenF64, lenU8, lenU8];
    const totalPayload = lengths.reduce((a, b) => a + b, 0);
    const headerBytes = 4 + 2 + lengths.length * 2;
    const packetSize = headerBytes + totalPayload;
    const buf = new ArrayBuffer(packetSize);
    const view = new DataView(buf);
    view.setUint8(0, 1);
    view.setUint8(1, 0);
    view.setUint16(2, packetSize - 1, true);
    view.setUint16(4, lengths.length, true);
    for (let i = 0; i < lengths.length; i++) view.setUint16(6 + i * 2, lengths[i], true);

    let cursor = headerBytes;
    for (let i = 0; i < numPoints; i++) view.setFloat64(cursor + i * 8, points[i].x, true);
    cursor += lenF64;
    for (let i = 0; i < numPoints; i++) view.setFloat64(cursor + i * 8, points[i].y, true);
    cursor += lenF64;
    for (let i = 0; i < numPoints; i++) view.setFloat64(cursor + i * 8, points[i].z, true);
    cursor += lenF64;
    // classification: Integer, minimum=5/maximum=20 — raw byte IS the
    // class id, never range-remapped (unlike color/intensity).
    for (let i = 0; i < numPoints; i++) view.setUint8(cursor + i, points[i].classification);
    cursor += lenU8;
    // intensity: Integer, minimum=50/maximum=250 — normalised to [0,1]
    // via (raw - minimum) / (maximum - minimum) then scaled to u16.
    for (let i = 0; i < numPoints; i++) view.setUint8(cursor + i, points[i].intensityRaw);

    const logical = new Uint8Array(buf);
    const entry: Data3DEntry = {
      guid: 'test',
      recordCount: numPoints,
      binaryFileOffset: 0,
      prototype: [
        { name: 'cartesianX', kind: 'Float', precision: 'double' },
        { name: 'cartesianY', kind: 'Float', precision: 'double' },
        { name: 'cartesianZ', kind: 'Float', precision: 'double' },
        { name: 'classification', kind: 'Integer', minimum: 5, maximum: 20 },
        { name: 'intensity', kind: 'Integer', minimum: 50, maximum: 250 },
      ],
    };

    const chunk = decodeE57Scan(logical, entry);
    expect(chunk.pointCount).toBe(2);
    expect(chunk.classifications).toBeDefined();
    // Absolute labels: raw byte passes through unchanged, NOT raw-minimum
    // (which would wrongly yield 1 and 10).
    expect(Array.from(chunk.classifications!)).toEqual([6, 15]);
    expect(chunk.intensities).toBeDefined();
    // (150-50)/(250-50) = 0.5 -> round(0.5*65535) = 32768
    // (200-50)/(250-50) = 0.75 -> round(0.75*65535) = 49151
    expect(chunk.intensities![0]).toBe(32768);
    expect(chunk.intensities![1]).toBe(49151);
  });

  it('rejects a recordCount the binary section cannot hold (no OOM alloc)', () => {
    // A hostile header declares 1e9 records but the binary section is a few
    // bytes. Without the pre-allocation guard this would allocate a ~12GB
    // Float32Array before the packet walk ever notices the body is short.
    const logical = new Uint8Array(64);
    const entry: Data3DEntry = {
      guid: 'test',
      recordCount: 1_000_000_000,
      binaryFileOffset: 0,
      prototype: [
        { name: 'cartesianX', kind: 'Float', precision: 'double' },
        { name: 'cartesianY', kind: 'Float', precision: 'double' },
        { name: 'cartesianZ', kind: 'Float', precision: 'double' },
      ],
    };
    expect(() => decodeE57Scan(logical, entry)).toThrow(/recordCount|binary section/i);
  });

  it('recordCount exactly at the availableBytes*8 ceiling passes the guard', () => {
    // Every record occupies at least one bit, so recordCount ==
    // availableBytes*8 is the largest count the section could theoretically
    // hold and must NOT trip the pre-allocation guard; one past it must.
    const logical = new Uint8Array(8); // 8 bytes -> 64 one-bit records max
    const entryFor = (recordCount: number): Data3DEntry => ({
      guid: 'test',
      recordCount,
      binaryFileOffset: 0,
      prototype: [
        { name: 'cartesianX', kind: 'Float', precision: 'double' },
        { name: 'cartesianY', kind: 'Float', precision: 'double' },
        { name: 'cartesianZ', kind: 'Float', precision: 'double' },
      ],
    });
    // At the boundary the guard passes; the packet walk then fails on the
    // (zero-filled) body for other reasons, never with the guard's message.
    try {
      decodeE57Scan(logical, entryFor(64));
    } catch (err) {
      expect(String(err)).not.toMatch(/exceeds what the/);
    }
    // One past the boundary is the guard's error.
    expect(() => decodeE57Scan(logical, entryFor(65))).toThrow(/exceeds what the/);
  });

  it('decodes ScaledInteger streams with bitsPerRecord that crosses byte boundaries', () => {
    // bitsPerRecord = 12 for X (min=0, max=4095). Two 12-bit values
    // pack into 3 bytes LSB-first: [0xABC, 0xDEF] → [0xBC, 0xFA, 0xDE]
    //   byte 0 = value0 & 0xFF                          = 0xBC
    //   byte 1 = (value0 >> 8) | ((value1 & 0xF) << 4)  = 0xA | 0xF0 = 0xFA
    //   byte 2 = value1 >> 4                            = 0xDE
    // Y and Z use 4-bit packing (two values per byte) to keep the
    // packet compact. Three bytestreams are required because
    // decodeE57Scan demands all three cartesian axes.
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

  it('remaps Integer colour channels from a non-zero minimum', () => {
    // The existing colour test declares `minimum: 0` (it asserts 200/255),
    // and at minimum 0 the range-remap `(raw - minimum) * inv` is
    // indistinguishable from `(raw + minimum) * inv` — so the sign of that
    // subtraction was never constrained. A non-zero minimum makes the two
    // differ, which is the only way the mutation becomes observable.
    const pts = [
      { x: 1, y: 2, z: 3, r: 110, g: 60, b: 35 },
      { x: 4, y: 5, z: 6, r: 210, g: 10, b: 110 },
    ];
    const n = pts.length;
    const lenF64 = n * 8;
    const lenU8 = n;
    const lengths = [lenF64, lenF64, lenF64, lenU8, lenU8, lenU8];
    const headerBytes = 4 + 2 + lengths.length * 2;
    const packetSize = headerBytes + lengths.reduce((a, b) => a + b, 0);
    const buf = new ArrayBuffer(packetSize);
    const view = new DataView(buf);
    view.setUint8(0, 1);
    view.setUint8(1, 0);
    view.setUint16(2, packetSize - 1, true);
    view.setUint16(4, lengths.length, true);
    for (let i = 0; i < lengths.length; i++) view.setUint16(6 + i * 2, lengths[i], true);

    let cursor = headerBytes;
    for (const key of ['x', 'y', 'z'] as const) {
      for (let i = 0; i < n; i++) view.setFloat64(cursor + i * 8, pts[i][key], true);
      cursor += lenF64;
    }
    for (const key of ['r', 'g', 'b'] as const) {
      for (let i = 0; i < n; i++) view.setUint8(cursor + i, pts[i][key]);
      cursor += lenU8;
    }

    const entry: Data3DEntry = {
      guid: 'test',
      recordCount: n,
      binaryFileOffset: 0,
      prototype: [
        { name: 'cartesianX', kind: 'Float', precision: 'double' },
        { name: 'cartesianY', kind: 'Float', precision: 'double' },
        { name: 'cartesianZ', kind: 'Float', precision: 'double' },
        // minimum 10 / maximum 210 -> inv = 1/200.
        { name: 'colorRed', kind: 'Integer', minimum: 10, maximum: 210 },
        { name: 'colorGreen', kind: 'Integer', minimum: 10, maximum: 210 },
        { name: 'colorBlue', kind: 'Integer', minimum: 10, maximum: 210 },
      ],
    };

    const chunk = decodeE57Scan(new Uint8Array(buf), entry);
    expect(chunk.colors).toBeDefined();
    // (110-10)/200 = 0.5, (60-10)/200 = 0.25, (35-10)/200 = 0.125.
    // A `+ minimum` swap would give 0.6 / 0.35 / 0.225 instead.
    expect(chunk.colors![0]).toBeCloseTo(0.5, 5);
    expect(chunk.colors![1]).toBeCloseTo(0.25, 5);
    expect(chunk.colors![2]).toBeCloseTo(0.125, 5);
  });

  it('recovers ScaledInteger classification values through their minimum offset', () => {
    // The ScaledInteger classification branch adds `minimum` back to recover
    // the original value, and no test reached it at all — the Integer branch
    // above is the only one previously exercised. With a non-zero minimum a
    // `raw - minimum` swap changes the decoded class, so the sign is pinned.
    // minimum 5 / maximum 20 -> span 15 -> 4 bits per record.
    const n = 2;
    const lenF64 = n * 8;
    const lenBits = 1; // 2 records * 4 bits = 8 bits = 1 byte
    const lengths = [lenF64, lenF64, lenF64, lenBits];
    const headerBytes = 4 + 2 + lengths.length * 2;
    const packetSize = headerBytes + lengths.reduce((a, b) => a + b, 0);
    const buf = new ArrayBuffer(packetSize);
    const view = new DataView(buf);
    view.setUint8(0, 1);
    view.setUint8(1, 0);
    view.setUint16(2, packetSize - 1, true);
    view.setUint16(4, lengths.length, true);
    for (let i = 0; i < lengths.length; i++) view.setUint16(6 + i * 2, lengths[i], true);

    let cursor = headerBytes;
    for (const v of [[1, 4], [2, 5], [3, 6]]) {
      for (let i = 0; i < n; i++) view.setFloat64(cursor + i * 8, v[i], true);
      cursor += lenF64;
    }
    // Raw 4-bit values 1 and 10, packed little-endian: low nibble first.
    view.setUint8(cursor, 1 | (10 << 4));

    const entry: Data3DEntry = {
      guid: 'test',
      recordCount: n,
      binaryFileOffset: 0,
      prototype: [
        { name: 'cartesianX', kind: 'Float', precision: 'double' },
        { name: 'cartesianY', kind: 'Float', precision: 'double' },
        { name: 'cartesianZ', kind: 'Float', precision: 'double' },
        { name: 'classification', kind: 'ScaledInteger', minimum: 5, maximum: 20 },
      ],
    };

    const chunk = decodeE57Scan(new Uint8Array(buf), entry);
    expect(chunk.classifications).toBeDefined();
    // raw + minimum: 1+5 = 6, 10+5 = 15. A `- minimum` swap clamps to 0 and 5.
    expect(Array.from(chunk.classifications!)).toEqual([6, 15]);
  });

  it('rejects when the section header runs past end of buffer', () => {
    const bytes = new Uint8Array(16); // smaller than 32-byte header
    expect(() => resolveCompressedVectorDataOffset(bytes, 0, 1024))
      .toThrow(/out of bounds|past end/i);
  });
});
