/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { normalizeColorChannel, normalizePlyColors } from './ply-color.js';

describe('normalizeColorChannel', () => {
  it('divides uchar/uint8 (and signed char/int8) by 255', () => {
    expect(normalizeColorChannel(255, 'uchar')).toBeCloseTo(1.0, 6);
    expect(normalizeColorChannel(128, 'uint8')).toBeCloseTo(128 / 255, 6);
    expect(normalizeColorChannel(0, 'char')).toBe(0);
    expect(normalizeColorChannel(255, 'int8')).toBeCloseTo(1.0, 6);
  });

  it('divides ushort/uint16 by 65535 — the 16-bit scanner-colour convention', () => {
    expect(normalizeColorChannel(65535, 'ushort')).toBeCloseTo(1.0, 6);
    expect(normalizeColorChannel(32768, 'uint16')).toBeCloseTo(32768 / 65535, 6);
    expect(normalizeColorChannel(0, 'ushort')).toBe(0);
  });

  it('divides short/int16 by 32767 (its positive/usable range)', () => {
    expect(normalizeColorChannel(32767, 'short')).toBeCloseTo(1.0, 6);
    expect(normalizeColorChannel(16384, 'int16')).toBeCloseTo(16384 / 32767, 6);
  });

  it('passes float/double through unscaled when the file policy is 0..1', () => {
    expect(normalizeColorChannel(1, 'float')).toBe(1);
    expect(normalizeColorChannel(0.5, 'float32')).toBe(0.5);
    expect(normalizeColorChannel(0.25, 'double')).toBe(0.25);
    expect(normalizeColorChannel(0.75, 'float64')).toBe(0.75);
  });

  it('falls back to /255 for the undocumented 32-bit int types', () => {
    expect(normalizeColorChannel(255, 'int')).toBeCloseTo(1.0, 6);
    expect(normalizeColorChannel(128, 'uint32')).toBeCloseTo(128 / 255, 6);
  });

  it('clamps every branch to 0..1', () => {
    expect(normalizeColorChannel(-5, 'uchar')).toBe(0);
    expect(normalizeColorChannel(999999, 'ushort')).toBe(1);
    expect(normalizeColorChannel(1.5, 'float')).toBe(1);
    expect(normalizeColorChannel(-0.5, 'double')).toBe(0);
  });

  it('uses one file-wide float policy, so dark float-255 channels do not become normalized colours', () => {
    const colors = new Float32Array([255, 128, 64, 1, 0.5, 0]);
    normalizePlyColors(colors, ['float', 'float', 'float']);
    expect(Array.from(colors)).toEqual([
      1,
      expect.closeTo(128 / 255, 6),
      expect.closeTo(64 / 255, 6),
      expect.closeTo(1 / 255, 6),
      expect.closeTo(0.5 / 255, 6),
      0,
    ]);
  });

  it('maps non-finite colour input to black instead of leaking NaN into the render buffer', () => {
    const colors = new Float32Array([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]);
    normalizePlyColors(colors, ['float', 'float', 'float']);
    expect(Array.from(colors)).toEqual([0, 0, 0]);
  });
});
