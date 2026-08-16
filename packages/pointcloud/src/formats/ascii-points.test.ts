/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import {
  decodeAsciiPoints,
  probeAsciiPointsLayout,
} from './ascii-points.js';

const enc = new TextEncoder();

describe('probeAsciiPointsLayout', () => {
  it('detects 3-column XYZ', () => {
    const buf = enc.encode('1 2 3\n4 5 6\n');
    const layout = probeAsciiPointsLayout(buf, 'xyz');
    expect(layout?.columns).toBe(3);
    expect(layout?.hasHeaderCount).toBe(false);
    expect(layout?.fields).toEqual(['x', 'y', 'z']);
  });

  it('detects PTS header count + 7-column layout', () => {
    const buf = enc.encode('2\n1 2 3 100 200 100 50\n4 5 6 200 50 100 200\n');
    const layout = probeAsciiPointsLayout(buf, 'pts');
    expect(layout?.hasHeaderCount).toBe(true);
    expect(layout?.columns).toBe(7);
    expect(layout?.fields).toEqual(['x', 'y', 'z', 'i', 'r', 'g', 'b']);
  });

  it('skips comment lines (#) when probing', () => {
    const buf = enc.encode('# field export\n# generated 2026\n1.5 2.5 3.5\n');
    const layout = probeAsciiPointsLayout(buf, 'xyz');
    expect(layout?.columns).toBe(3);
  });

  it('returns null for binary content', () => {
    const buf = new Uint8Array([0x00, 0xff, 0x12, 0x34, 0x56]);
    expect(probeAsciiPointsLayout(buf, 'xyz')).toBeNull();
  });

  it('falls through to 3-col positions for an unknown column count (xyz)', () => {
    const buf = enc.encode('1 2 3 4 5\n');
    const layout = probeAsciiPointsLayout(buf, 'xyz');
    expect(layout?.columns).toBe(5);
    expect(layout?.fields).toEqual(['x', 'y', 'z', 'skip', 'skip']);
  });

  it('rejects unknown column counts in PTS (no fallback)', () => {
    const buf = enc.encode('1 2 3 4 5\n');
    expect(probeAsciiPointsLayout(buf, 'pts')).toBeNull();
  });

  it('drops normals from 10-column PTS-with-normals', () => {
    const buf = enc.encode('1 2 3 100 200 200 200 0 1 0\n');
    const layout = probeAsciiPointsLayout(buf, 'pts');
    expect(layout?.columns).toBe(10);
    expect(layout?.fields).toEqual(['x', 'y', 'z', 'i', 'r', 'g', 'b', 'skip', 'skip', 'skip']);
  });

  it('drops normals from 9-column XYZ-with-RGB-and-normals', () => {
    const buf = enc.encode('1 2 3 200 200 200 0 1 0\n');
    const layout = probeAsciiPointsLayout(buf, 'xyz');
    expect(layout?.columns).toBe(9);
    expect(layout?.fields).toEqual(['x', 'y', 'z', 'r', 'g', 'b', 'skip', 'skip', 'skip']);
  });
});

describe('decodeAsciiPoints — XYZ', () => {
  it('decodes 3-column positions', () => {
    const buf = enc.encode('1 2 3\n4 5 6\n');
    const chunk = decodeAsciiPoints(buf, 'xyz');
    expect(chunk.pointCount).toBe(2);
    expect(Array.from(chunk.positions)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(chunk.colors).toBeUndefined();
    expect(chunk.intensities).toBeUndefined();
    expect(chunk.bbox).toEqual({ min: [1, 2, 3], max: [4, 5, 6] });
  });

  it('decodes 6-column positions + 0..255 RGB', () => {
    const buf = enc.encode('1 2 3 255 0 0\n4 5 6 0 255 0\n');
    const chunk = decodeAsciiPoints(buf, 'xyz');
    expect(chunk.pointCount).toBe(2);
    expect(chunk.colors).toBeDefined();
    // Auto-detected as 0..255 since values >1; renormalised to 0..1.
    expect(chunk.colors![0]).toBeCloseTo(1, 3);
    expect(chunk.colors![1]).toBeCloseTo(0, 3);
    expect(chunk.colors![4]).toBeCloseTo(1, 3);
  });

  it('treats 0..1 RGB as already-normalised', () => {
    const buf = enc.encode('1 2 3 1.0 0.5 0.0\n');
    const chunk = decodeAsciiPoints(buf, 'xyz');
    expect(chunk.colors![0]).toBeCloseTo(1.0, 3);
    expect(chunk.colors![1]).toBeCloseTo(0.5, 3);
    expect(chunk.colors![2]).toBeCloseTo(0.0, 3);
  });

  it('skips comment + blank lines, keeps data', () => {
    const buf = enc.encode('# comment\n\n1 2 3\n// also comment\n4 5 6\n');
    const chunk = decodeAsciiPoints(buf, 'xyz');
    expect(chunk.pointCount).toBe(2);
    expect(Array.from(chunk.positions)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('rejects file with no recognisable data', () => {
    const buf = enc.encode('# only comments\n# nothing else\n');
    expect(() => decodeAsciiPoints(buf, 'xyz')).toThrow(/does not look like ASCII/);
  });
});

describe('decodeAsciiPoints — originOffset (extends #1804 to PTS/XYZ)', () => {
  it('subtracts originOffset in f64 before narrowing to f32', () => {
    // True coordinate: (500_012.345, 5_000_006.789, 104.321) — survey/
    // GNSS scale, the exact case PTS/XYZ files carry routinely.
    const buf = enc.encode('500012.345 5000006.789 104.321\n');

    const withoutOffset = decodeAsciiPoints(buf, 'xyz');
    // f32 cast of a ~5e6-magnitude value cannot exactly represent the
    // millimetre-level input.
    expect(withoutOffset.positions[0]).not.toBe(500012.345);
    expect(withoutOffset.positions[0]).toBeCloseTo(500012.345, 0);

    const withOffset = decodeAsciiPoints(buf, 'xyz', [500_000, 5_000_000, 100]);
    // Residual is small, so f32 preserves it to micrometre precision —
    // impossible if the subtraction happened after narrowing to f32 first.
    expect(withOffset.positions[0]).toBeCloseTo(12.345, 6);
    expect(withOffset.positions[1]).toBeCloseTo(6.789, 6);
    expect(withOffset.positions[2]).toBeCloseTo(4.321, 6);
    expect(withOffset.bbox.min[0]).toBeCloseTo(12.345, 6);
  });

  it('absent originOffset is bit-identical to today (undefined default)', () => {
    const buf = enc.encode('1.5 -2.5 3.5\n4 5 6\n');
    const a = decodeAsciiPoints(buf, 'xyz');
    const b = decodeAsciiPoints(buf, 'xyz', undefined);
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(a.bbox).toEqual(b.bbox);
  });
});

describe('decodeAsciiPoints — PTS', () => {
  it('respects header count + 7-column layout', () => {
    // Standard PTS: count line, then X Y Z I(0..255) R G B(0..255)
    const buf = enc.encode('2\n1 2 3 100 200 100 50\n4 5 6 200 50 100 200\n');
    const chunk = decodeAsciiPoints(buf, 'pts');
    expect(chunk.pointCount).toBe(2);
    expect(Array.from(chunk.positions)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(chunk.intensities).toBeDefined();
    expect(chunk.colors).toBeDefined();
    // Intensity normalised to u16; raw 100 / 200 in 0..255 source.
    expect(chunk.intensities![0]).toBeGreaterThan(0);
    expect(chunk.intensities![1]).toBeGreaterThan(chunk.intensities![0]);
    // RGB renormalised from 0..255 → 0..1.
    expect(chunk.colors![0]).toBeCloseTo(200 / 255, 3);
  });

  it('handles 4-column intensity-only PTS', () => {
    const buf = enc.encode('1 2 3 0.5\n4 5 6 0.75\n');
    const chunk = decodeAsciiPoints(buf, 'pts');
    expect(chunk.pointCount).toBe(2);
    expect(chunk.colors).toBeUndefined();
    expect(chunk.intensities).toBeDefined();
    expect(chunk.intensities![0]).toBeCloseTo(Math.round(0.5 * 65535), 0);
  });
});
