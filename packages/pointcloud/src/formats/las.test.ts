/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { bboxInDecodedFrame, decodeLasPoints, parseLasHeader, sampleMaxRgbChannel } from './las.js';

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

function buildFormat0Records(rows: Array<{
  x: number; y: number; z: number; intensity?: number; classification?: number;
  /**
   * High 3 bits of byte 15 in formats 0–5: synthetic (0x20), key-point
   * (0x40), withheld (0x80). Real producers set these on ordinary points,
   * so the decoder has to mask them off the classification.
   */
  classFlags?: number;
}>): Uint8Array {
  const buf = new ArrayBuffer(rows.length * 20);
  const view = new DataView(buf);
  for (let i = 0; i < rows.length; i++) {
    const off = i * 20;
    view.setInt32(off, rows[i].x, true);
    view.setInt32(off + 4, rows[i].y, true);
    view.setInt32(off + 8, rows[i].z, true);
    view.setUint16(off + 12, rows[i].intensity ?? 0, true);
    view.setUint8(off + 15, (rows[i].classification ?? 0) | (rows[i].classFlags ?? 0));
    // bytes 13, 14, 16, 17, 18, 19 = bit flags / scan angle / user data — leave 0
  }
  return new Uint8Array(buf);
}

/**
 * Format-6 records (LAS 1.4 extended base record, 30 bytes). Two things
 * differ from formats 0–5 and both are load-bearing in `decodeLasPoints`:
 * classification moves from byte 15 to byte 16, and it is NOT masked (the
 * flag bits got their own byte). `flagsByte15` writes whatever the producer
 * left in the old slot so a decoder that still reads byte 15 is visible.
 */
function buildFormat6Records(rows: Array<{
  x: number; y: number; z: number;
  intensity?: number; classification: number; flagsByte15?: number;
}>): Uint8Array {
  const buf = new ArrayBuffer(rows.length * 30);
  const view = new DataView(buf);
  for (let i = 0; i < rows.length; i++) {
    const off = i * 30;
    view.setInt32(off, rows[i].x, true);
    view.setInt32(off + 4, rows[i].y, true);
    view.setInt32(off + 8, rows[i].z, true);
    view.setUint16(off + 12, rows[i].intensity ?? 0, true);
    view.setUint8(off + 15, rows[i].flagsByte15 ?? 0);
    view.setUint8(off + 16, rows[i].classification);
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

  it('uses the LAS 1.4 extended 64-bit point count when the legacy field is 0', () => {
    // Strict LAS 1.4 producers write 0 into the legacy 32-bit count (offset
    // 107) and put the real count in the extended 64-bit field at offset
    // 247. A header that only checks versionMinor > 4 (instead of >= 4)
    // would miss 1.4-exactly files and fall back to the legacy field,
    // silently producing a 0-point cloud.
    //
    // The LAS 1.4 Public Header Block is 375 bytes (1.2 is 227): the 64-bit
    // "Number of Point Records" sits at offset 247 and the 15 x 8-byte
    // "Number of Points by Return" array at 255, ending the header at 375.
    // headerSize and pointDataOffset must therefore both be 375, otherwise
    // the declared point-data region would overlap the extended header
    // fields this test reads.
    const LAS14_HEADER_SIZE = 375;
    const buf = new ArrayBuffer(LAS14_HEADER_SIZE);
    const view = new DataView(buf);
    view.setUint32(0, 0x4653414c, true);   // "LASF"
    view.setUint8(24, 1);                  // version major
    view.setUint8(25, 4);                  // version minor = 4 (exactly 1.4)
    view.setUint16(94, LAS14_HEADER_SIZE, true);  // header size
    view.setUint32(96, LAS14_HEADER_SIZE, true);  // point data offset
    view.setUint32(100, 0, true);          // VLR count
    view.setUint8(104, 0);                 // point format
    view.setUint16(105, 20, true);         // record length
    view.setUint32(107, 0, true);          // legacy count = 0 (strict 1.4 producer)
    view.setFloat64(131, 0.01, true);
    view.setFloat64(139, 0.01, true);
    view.setFloat64(147, 0.01, true);
    view.setFloat64(155, 0, true);
    view.setFloat64(163, 0, true);
    view.setFloat64(171, 0, true);
    view.setFloat64(179, 0, true);
    view.setFloat64(187, 0, true);
    view.setFloat64(195, 0, true);
    view.setFloat64(203, 0, true);
    view.setFloat64(211, 0, true);
    view.setFloat64(219, 0, true);
    // Extended 64-bit point count at offset 247: 5000 points.
    view.setUint32(247, 5000, true);
    view.setUint32(251, 0, true);
    // Extended "Number of Points by Return" (15 x u64) at 255..374: all
    // points in return 1, the rest zero.
    view.setUint32(255, 5000, true);
    view.setUint32(259, 0, true);

    const h = parseLasHeader(new Uint8Array(buf));
    expect(h.pointCount).toBe(5000);
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

  it('subtracts originOffset in f64 before narrowing to f32 (issue #1804)', () => {
    // A georeferenced point cloud whose LAS header offset is a real-world
    // UTM-scale value (~5e5, ~5e6) — narrowing the ABSOLUTE coordinate
    // straight to f32 loses sub-metre precision at that magnitude (f32 ulp
    // at 5e6 is ~0.5 m). Passing `originOffset` close to the true
    // coordinate keeps the residual small (~tens of metres), which f32
    // represents to micrometre precision — proving the subtraction
    // happens on the full-precision f64 value
    // (`view.getInt32(...)*scale+offset`), not on an already-narrowed f32.
    const { header } = buildHeader({
      pointDataFormatId: 0,
      pointRecordLength: 20,
      pointCount: 1,
      scale: [0.001, 0.001, 0.001],
      offset: [500_000, 5_000_000, 100],
    });
    const h = parseLasHeader(header);
    // True coordinate: (500_012.345, 5_000_006.789, 104.321).
    const records = buildFormat0Records([{ x: 12345, y: 6789, z: 4321 }]);

    const withoutOffset = decodeLasPoints(records, h, 1, 20);
    // Unchanged prior behaviour: full absolute coordinate, f32-narrowed —
    // the f32 cast of a ~5e6-magnitude value cannot exactly represent the
    // millimetre-level input, so it does NOT round-trip exactly.
    expect(withoutOffset.positions[0]).not.toBe(500_012.345);
    expect(withoutOffset.positions[0]).toBeCloseTo(500_012.345, 0);

    const withOffset = decodeLasPoints(records, h, 1, 20, 1, [500_000, 5_000_000, 100]);
    // Residual (true coordinate minus originOffset) is small, so f32
    // preserves it to micrometre precision — impossible if the
    // subtraction happened after narrowing the ABSOLUTE value to f32 first.
    expect(withOffset.positions[0]).toBeCloseTo(12.345, 6);
    expect(withOffset.positions[1]).toBeCloseTo(6.789, 6);
    expect(withOffset.positions[2]).toBeCloseTo(4.321, 6);
    // bbox tracks the pre-narrowing f64 locals, so it's even more precise
    // than the f32 positions array — compare with tolerance, not equality.
    expect(withOffset.bbox.min[0]).toBeCloseTo(12.345, 6);
    expect(withOffset.bbox.min[1]).toBeCloseTo(6.789, 6);
    expect(withOffset.bbox.min[2]).toBeCloseTo(4.321, 6);
  });

  // Every existing fixture stores a classification below 32 with the high
  // three bits of byte 15 left at zero, which makes `& 0x1f` an identity on
  // all of them — deleting the mask survived the whole pointcloud suite.
  // Real producers DO set those flags (a withheld ground point is byte 15 =
  // 0x82), and without the mask it decodes as class 130: every
  // classification-based colour ramp and filter misses it.
  it('masks the synthetic/key-point/withheld flag bits out of the legacy classification byte', () => {
    const { header } = buildHeader({
      pointDataFormatId: 0,
      pointRecordLength: 20,
      pointCount: 4,
      scale: [1, 1, 1],
    });
    const h = parseLasHeader(header);
    const records = buildFormat0Records([
      { x: 0, y: 0, z: 0, classification: 2, classFlags: 0x80 },  // withheld ground
      { x: 0, y: 0, z: 0, classification: 6, classFlags: 0x40 },  // key-point building
      { x: 0, y: 0, z: 0, classification: 1, classFlags: 0x20 },  // synthetic unclassified
      { x: 0, y: 0, z: 0, classification: 31, classFlags: 0xe0 }, // all three flags, max class
    ]);
    const chunk = decodeLasPoints(records, h, 4, 20);
    // Each case is checked individually: a mask that dropped only some of
    // the flag bits would still satisfy a whole-array comparison against a
    // single wrong value, but not four different flag combinations.
    expect(chunk.classifications![0]).toBe(2);
    expect(chunk.classifications![1]).toBe(6);
    expect(chunk.classifications![2]).toBe(1);
    // Opposite direction: the mask must keep all five class bits, not
    // narrow the field further.
    expect(chunk.classifications![3]).toBe(31);
  });

  // Formats 6–10 are the LAS 1.4 extended records: classification moves to
  // byte 16 and is a full unmasked byte (classes 0..255 are legal there).
  // Nothing exercised a format >= 6 record, so both `classOffset` and the
  // "don't mask" arm were invisible — collapsing `classOffset` to a constant
  // 15 survived the whole suite.
  it('reads format-6+ classification from byte 16, unmasked', () => {
    const { header } = buildHeader({
      pointDataFormatId: 6,
      pointRecordLength: 30,
      pointCount: 2,
      scale: [1, 1, 1],
    });
    const h = parseLasHeader(header);
    expect(h.hasGpsTime).toBe(true);
    expect(h.hasRgb).toBe(false);
    const records = buildFormat6Records([
      // Byte 15 holds return/scan flags in format 6; a decoder still reading
      // it would report 7, not 200.
      { x: 0, y: 0, z: 0, classification: 200, flagsByte15: 7 },
      // A value that WOULD survive `& 0x1f` unchanged if it were masked, to
      // keep the first case from being the only discriminating one.
      { x: 1, y: 2, z: 3, classification: 40, flagsByte15: 0 },
    ]);
    const chunk = decodeLasPoints(records, h, 2, 30);
    // 200 is above the 5-bit legacy field: masking would give 8.
    expect(chunk.classifications![0]).toBe(200);
    // 40 & 0x1f === 8, so this too separates "masked" from "not masked".
    expect(chunk.classifications![1]).toBe(40);
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

describe('sampleMaxRgbChannel', () => {
  // The existing 8-bit-detection test puts the maximum in RED (r=255,
  // g=128, b=64), so deleting the green and blue comparisons from the
  // sampler's inner loop survives it — and the whole pointcloud suite. A
  // sampler that only watches red under-reports the max on any file whose
  // brightest channel is green or blue, the auto-detect concludes "already
  // 16-bit", and an 8-bit file renders ~257x too dark.
  const rgbHeader = () => {
    const { header } = buildHeader({
      pointDataFormatId: 3,
      pointRecordLength: 34,
      pointCount: 1,
      scale: [1, 1, 1],
    });
    return parseLasHeader(header);
  };

  it('takes the max over ALL THREE channels, not just red', () => {
    const h = rgbHeader();
    // Max in green.
    expect(
      sampleMaxRgbChannel(buildFormat3Records([{ x: 0, y: 0, z: 0, r: 10, g: 255, b: 20 }]), h),
    ).toBe(255);
    // Max in blue.
    expect(
      sampleMaxRgbChannel(buildFormat3Records([{ x: 0, y: 0, z: 0, r: 10, g: 20, b: 255 }]), h),
    ).toBe(255);
    // Max in red (the direction the original fixture covered).
    expect(
      sampleMaxRgbChannel(buildFormat3Records([{ x: 0, y: 0, z: 0, r: 255, g: 20, b: 10 }]), h),
    ).toBe(255);
  });

  it('scans every sampled record, not only the first', () => {
    // The 16-bit value is on the LAST record: a sampler that stopped early
    // (or only looked at record 0) would report 200 and mis-classify the
    // file as 8-bit.
    const { header } = buildHeader({
      pointDataFormatId: 3,
      pointRecordLength: 34,
      pointCount: 3,
      scale: [1, 1, 1],
    });
    const h = parseLasHeader(header);
    const records = buildFormat3Records([
      { x: 0, y: 0, z: 0, r: 100, g: 100, b: 100 },
      { x: 0, y: 0, z: 0, r: 200, g: 200, b: 200 },
      { x: 0, y: 0, z: 0, r: 0, g: 40000, b: 0 },
    ]);
    expect(sampleMaxRgbChannel(records, h)).toBe(40000);
  });

  it('returns 0 for a format with no RGB rather than reading past the record', () => {
    const { header } = buildHeader({ pointDataFormatId: 0, pointRecordLength: 20, pointCount: 1 });
    const h = parseLasHeader(header);
    expect(sampleMaxRgbChannel(buildFormat0Records([{ x: 0, y: 0, z: 0 }]), h)).toBe(0);
  });
});

describe('bboxInDecodedFrame (issue #1804)', () => {
  const bbox = { min: [-5, -10, -15] as [number, number, number], max: [10, 20, 30] as [number, number, number] };

  it('returns the box unchanged when there is no origin offset', () => {
    expect(bboxInDecodedFrame(bbox, undefined)).toBe(bbox);
  });

  it('translates both corners onto the same axes decodeLasPoints subtracts', () => {
    // decodeLasPoints computes x - offX, y - offY, z - offZ, so the reported
    // box must move by exactly the same vector or bounds and points end up in
    // different frames.
    expect(bboxInDecodedFrame(bbox, [100, 200, 300])).toEqual({
      min: [-105, -210, -315],
      max: [-90, -180, -270],
    });
  });

  it('stays exact at map magnitudes', () => {
    // The whole point of the f64 offset: a LV95-scale coordinate must not
    // lose precision when the box is translated.
    const swiss = { min: [2_600_000, 1_200_000, 450] as [number, number, number], max: [2_600_100, 1_200_050, 470] as [number, number, number] };
    expect(bboxInDecodedFrame(swiss, [2_600_000, 1_200_000, 450])).toEqual({
      min: [0, 0, 0],
      max: [100, 50, 20],
    });
  });
});
