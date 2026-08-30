/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { normalizeColorChannel } from './ply-color.js';

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

  it('passes float/double through unscaled (already 0..1)', () => {
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
});
