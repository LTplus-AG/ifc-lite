/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { decodePointsArray, decodePointsBase64 } from './ifcx-points.js';
import { decodeIfcxPointAttribute } from '../from-ifcx-attributes.js';

describe('decodePointsArray', () => {
  it('decodes positions and colors', () => {
    const chunk = decodePointsArray({
      positions: [[1, 2, 3], [4, 5, 6]],
      colors: [[1, 0, 0], [0, 1, 0]],
    });
    expect(chunk.pointCount).toBe(2);
    expect(Array.from(chunk.positions)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(Array.from(chunk.colors!)).toEqual([1, 0, 0, 0, 1, 0]);
    expect(chunk.bbox).toEqual({ min: [1, 2, 3], max: [4, 5, 6] });
  });

  it('rejects mismatched colors length', () => {
    expect(() => decodePointsArray({
      positions: [[0, 0, 0], [1, 1, 1]],
      colors: [[0, 0, 0]],
    })).toThrow();
  });
});

describe('decodePointsBase64', () => {
  it('round-trips Float32 positions', () => {
    const positions = new Float32Array([1, 2, 3, -1, -2, -3]);
    const b64 = Buffer.from(positions.buffer).toString('base64');
    const chunk = decodePointsBase64({ positions: b64 });
    expect(chunk.pointCount).toBe(2);
    expect(Array.from(chunk.positions)).toEqual([1, 2, 3, -1, -2, -3]);
  });

  it('decodes positions and colors together', () => {
    const positions = new Float32Array([0, 0, 0, 1, 1, 1]);
    const colors = new Float32Array([0.5, 0.5, 0.5, 1, 1, 1]);
    const chunk = decodePointsBase64({
      positions: Buffer.from(positions.buffer).toString('base64'),
      colors: Buffer.from(colors.buffer).toString('base64'),
    });
    expect(chunk.pointCount).toBe(2);
    expect(Array.from(chunk.colors!)).toEqual([0.5, 0.5, 0.5, 1, 1, 1]);
  });

  it('rejects positions length not divisible by 3', () => {
    const bad = new Float32Array([1, 2]);
    expect(() => decodePointsBase64({
      positions: Buffer.from(bad.buffer).toString('base64'),
    })).toThrow();
  });
});

describe('decodeIfcxPointAttribute (adapter)', () => {
  it('returns null when no point attribute is present', () => {
    const attrs = new Map<string, unknown>([['bsi::ifc::class', { code: 'IfcWall' }]]);
    expect(decodeIfcxPointAttribute(attrs)).toBeNull();
  });

  it('routes points::array to its decoder', () => {
    const attrs = new Map<string, unknown>([
      ['points::array', { positions: [[7, 8, 9]] }],
    ]);
    const chunk = decodeIfcxPointAttribute(attrs)!;
    expect(chunk.pointCount).toBe(1);
    expect(Array.from(chunk.positions)).toEqual([7, 8, 9]);
  });

  it('routes points::base64 to its decoder', () => {
    const positions = new Float32Array([10, 11, 12]);
    const attrs = new Map<string, unknown>([
      ['points::base64', { positions: Buffer.from(positions.buffer).toString('base64') }],
    ]);
    const chunk = decodeIfcxPointAttribute(attrs)!;
    expect(chunk.pointCount).toBe(1);
    expect(Array.from(chunk.positions)).toEqual([10, 11, 12]);
  });
});
