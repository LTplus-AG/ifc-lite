/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { hexToRgba, rgbaToHex, isGhostColor, GHOST_COLOR, uniqueColor } from './colors.js';

describe('hexToRgba', () => {
  it('should parse hex with # prefix', () => {
    const [r, g, b, a] = hexToRgba('#FF0000', 1);
    expect(r).toBeCloseTo(1);
    expect(g).toBeCloseTo(0);
    expect(b).toBeCloseTo(0);
    expect(a).toBe(1);
  });

  it('should parse hex without # prefix', () => {
    const [r, g, b, a] = hexToRgba('00FF00', 0.5);
    expect(r).toBeCloseTo(0);
    expect(g).toBeCloseTo(1);
    expect(b).toBeCloseTo(0);
    expect(a).toBe(0.5);
  });

  it('should handle arbitrary colors', () => {
    const [r, g, b, a] = hexToRgba('#E53935', 0.3);
    expect(r).toBeCloseTo(0.898, 2);
    expect(g).toBeCloseTo(0.224, 2);
    expect(b).toBeCloseTo(0.208, 2);
    expect(a).toBe(0.3);
  });
});

describe('rgbaToHex', () => {
  it('should convert pure red', () => {
    expect(rgbaToHex([1, 0, 0, 1])).toBe('#ff0000');
  });

  it('should convert white', () => {
    expect(rgbaToHex([1, 1, 1, 1])).toBe('#ffffff');
  });

  it('should ignore alpha', () => {
    expect(rgbaToHex([0, 0, 0, 0.5])).toBe('#000000');
  });
});

describe('isGhostColor', () => {
  it('should detect ghost color', () => {
    expect(isGhostColor(GHOST_COLOR)).toBe(true);
  });

  it('should detect any low-alpha color as ghost', () => {
    expect(isGhostColor([1, 0, 0, 0.1])).toBe(true);
    expect(isGhostColor([0, 0, 0, 0.19])).toBe(true);
  });

  it('should not flag colors at or above alpha boundary (0.2)', () => {
    expect(isGhostColor([1, 0, 0, 0.2])).toBe(false);
    expect(isGhostColor([1, 0, 0, 1])).toBe(false);
    expect(isGhostColor([0, 0, 0, 0.3])).toBe(false);
  });
});

describe('uniqueColor', () => {
  it('returns valid hex strings', () => {
    for (let i = 0; i < 50; i++) {
      expect(uniqueColor(i)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  // Colors are only visually distinct, not globally unique: exact-hex
  // collisions appear beyond ~1.8k distinct values (see colors.ts). This
  // asserts distinctness within the realistic range for auto-color legends.
  it('generates distinct colors for the first 100 indices', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const color = uniqueColor(i);
      expect(seen.has(color)).toBe(false);
      seen.add(color);
    }
  });

  it('is deterministic (same index always returns same color)', () => {
    expect(uniqueColor(0)).toBe(uniqueColor(0));
    expect(uniqueColor(42)).toBe(uniqueColor(42));
    expect(uniqueColor(999)).toBe(uniqueColor(999));
  });
});
