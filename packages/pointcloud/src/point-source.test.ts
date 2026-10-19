/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { decodeIfcxPointAttribute, decodeIfcxPointSource } from './index.js';
import { decodePcd } from './formats/pcd.js';

const xyz = [5000000.123456789, -0, -123456.987654321];
const rgb = 0x0180fe;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const floats = (values: number[]) => b64(new Uint8Array(new Float32Array(values).buffer));
const attrs = (key: string, value: unknown) => new Map<string, unknown>([[key, value]]);

/** A real PCD record, including a multi-count field before XYZ. */
function pcd(kind: 'ascii' | 'binary' | 'binary_compressed', size: 4 | 8 = 8): Uint8Array {
  const header = new TextEncoder().encode([
    'VERSION 0.7', 'FIELDS ignored x y z rgb', `SIZE 1 ${size} ${size} ${size} 4`,
    'TYPE U F F F U', 'COUNT 2 1 1 1 1', 'WIDTH 1', 'HEIGHT 1', 'POINTS 1', `DATA ${kind}`, '',
  ].join('\n'));
  let body: Uint8Array;
  if (kind === 'ascii') {
    body = new TextEncoder().encode(`7 8 ${xyz[0]} -0 ${xyz[2]} ${rgb}\n`);
  } else {
    // With one record, AoS and SoA match; a separate test exercises multi-row SoA.
    body = new Uint8Array(2 + size * 3 + 4);
    const view = new DataView(body.buffer);
    body.set([7, 8]);
    xyz.forEach((value, axis) => {
      if (size === 8) view.setFloat64(2 + axis * size, value, true);
      else view.setFloat32(2 + axis * size, value, true);
    });
    view.setUint32(2 + size * 3, rgb, true);
    if (kind === 'binary_compressed') body = lzfLiteralBody(body);
  }
  const bytes = new Uint8Array(header.length + body.length);
  bytes.set(header); bytes.set(body, header.length);
  return bytes;
}

function lzfLiteralBody(raw: Uint8Array): Uint8Array {
  const literal: number[] = [];
  for (let i = 0; i < raw.length; i += 32) {
    const part = raw.subarray(i, i + 32);
    literal.push(part.length - 1, ...part);
  }
  const body = new Uint8Array(8 + literal.length);
  const sizes = new DataView(body.buffer);
  sizes.setUint32(0, literal.length, true); sizes.setUint32(4, raw.length, true);
  body.set(literal, 8);
  return body;
}

describe('IFCX source-before-f32 handoff', () => {
  for (const encoding of ['ascii', 'binary', 'binary_compressed'] as const) {
    it(`retains ${encoding} f64 coordinates and RGB before narrowing`, () => {
      const bytes = pcd(encoding);
      const attributes = attrs('pcd::base64', b64(bytes));
      const source = decodeIfcxPointSource(attributes)!;
      expect(source.positions).toBeInstanceOf(Float64Array);
      expect(Array.from(source.positions)).toEqual(xyz);
      expect(source.colors).toBeInstanceOf(Float64Array);
      expect(Array.from(source.colors!)).toEqual([1 / 255, 128 / 255, 254 / 255]);
      expect(source.pointCount).toBe(1);
      expect(source.sourcePrecision).toBe('f64');
      expect(source.sourceEncoding).toBe(`pcd-${encoding}`);
      expect(source).not.toHaveProperty('bbox');
      expect(source).not.toHaveProperty('normalState');
      const chunk = decodeIfcxPointAttribute(attributes)!;
      expect(Array.from(chunk.positions)).toEqual(xyz.map(Math.fround));
      expect(Array.from(chunk.colors!)).toEqual([1 / 255, 128 / 255, 254 / 255].map(Math.fround));
      expect(chunk.normalState).toBe('absent');
      expect(chunk.bbox).toEqual({ min: xyz.map(Math.fround), max: xyz.map(Math.fround) });
      const origin = [5000000, -0, -123456] as const;
      expect(Array.from(decodePcd(bytes, origin).positions)).toEqual(xyz.map((value, i) => Math.fround(value - origin[i])));
      // -0 - -0 is +0: the compatibility wrapper must subtract before narrowing.
      expect(Object.is(decodePcd(bytes, origin).positions[1], 0)).toBe(true);
      expect(Object.is(source.positions[1], -0)).toBe(true);
    });
  }

  for (const encoding of ['binary', 'binary_compressed'] as const) {
    it(`reports encoded f32 precision for ${encoding}`, () => {
      const source = decodeIfcxPointSource(attrs('pcd::base64', b64(pcd(encoding, 4))))!;
      expect(source.sourcePrecision).toBe('f32');
      expect(Array.from(source.positions)).toEqual(xyz.map(Math.fround));
    });
  }

  it('decodes multi-row compressed f64 field blocks without losing precision', () => {
    const header = new TextEncoder().encode('FIELDS x y z\nSIZE 8 8 8\nTYPE F F F\nWIDTH 2\nPOINTS 2\nDATA binary_compressed\n');
    const raw = new Uint8Array(48);
    const view = new DataView(raw.buffer);
    [xyz[0], xyz[0] + 0.001, -0, 1, xyz[2], xyz[2] - 0.001].forEach((value, i) => view.setFloat64(i * 8, value, true));
    const body = lzfLiteralBody(raw);
    const bytes = new Uint8Array(header.length + body.length);
    bytes.set(header); bytes.set(body, header.length);
    const source = decodeIfcxPointSource(attrs('pcd::base64', b64(bytes)))!;
    expect(Array.from(source.positions)).toEqual([...xyz, xyz[0] + 0.001, 1, xyz[2] - 0.001]);
  });

  it('retains compressed-body size and binary truncation errors', () => {
    const compressed = pcd('binary_compressed');
    const brokenSize = compressed.slice();
    const bodyOffset = new TextDecoder().decode(compressed).indexOf('DATA binary_compressed\n') + 'DATA binary_compressed\n'.length;
    new DataView(brokenSize.buffer).setUint32(bodyOffset + 4, 1, true);
    for (const [bytes, error] of [
      [pcd('binary').subarray(0, -1), 'body bytes but only'],
      [compressed.subarray(0, bodyOffset + 7), 'PCD binary_compressed: truncated size header'],
      [brokenSize, 'does not match fields*points=30'],
    ] as const) {
      const attributes = attrs('pcd::base64', b64(bytes));
      expect(() => decodeIfcxPointSource(attributes)).toThrow(error);
      expect(() => decodeIfcxPointAttribute(attributes)).toThrow(error);
    }
  });

  it('retains inline positions and colors, including signed zero and nonfinite numbers', () => {
    const attributes = attrs('points::array', { positions: [xyz, [NaN, Infinity, -Infinity]], colors: [[0.1, -0, 1 / 255], [0, 0, 0]] });
    const source = decodeIfcxPointSource(attributes)!;
    expect(Array.from(source.positions)).toEqual([...xyz, NaN, Infinity, -Infinity]);
    expect(Array.from(source.colors!)).toEqual([0.1, -0, 1 / 255, 0, 0, 0]);
    expect(source.sourcePrecision).toBe('f64');
    expect(source.sourceEncoding).toBe('points-array');
    const chunk = decodeIfcxPointAttribute(attributes)!;
    expect(Array.from(chunk.positions)).toEqual([...xyz, NaN, Infinity, -Infinity].map(Math.fround));
    expect(chunk.bbox).toEqual({ min: xyz.map(Math.fround), max: xyz.map(Math.fround) });
    source.positions[0] = 0;
    expect(xyz[0]).toBe(5000000.123456789);
  });

  it('widens base64 float32 channels without inventing precision', () => {
    const attributes = attrs('points::base64', { positions: floats(xyz), colors: floats([0.1, -0, 0.3]) });
    const source = decodeIfcxPointSource(attributes)!;
    expect(source.positions).toBeInstanceOf(Float64Array);
    expect(Array.from(source.positions)).toEqual(xyz.map(Math.fround));
    expect(Array.from(source.colors!)).toEqual([0.1, -0, 0.3].map(Math.fround));
    expect(source.sourcePrecision).toBe('f32');
    expect(source.sourceEncoding).toBe('points-base64');
  });

  it('shares PCD > inline > base64 selection, including ignored values', () => {
    const attributes = new Map<string, unknown>([
      ['pcd::base64', b64(pcd('ascii'))],
      ['points::array', { positions: [[7, 8, 9]] }],
      ['points::base64', { positions: floats([4, 5, 6]) }],
    ]);
    expect(decodeIfcxPointSource(attributes)?.sourceEncoding).toBe('pcd-ascii');
    attributes.set('pcd::base64', '');
    expect(Array.from(decodeIfcxPointSource(attributes)!.positions)).toEqual([7, 8, 9]);
    attributes.set('points::array', 'ignored');
    expect(Array.from(decodeIfcxPointSource(attributes)!.positions)).toEqual([4, 5, 6]);
    attributes.clear();
    expect(decodeIfcxPointSource(attributes)).toBeNull();
  });

  for (const [key, value, error] of [
    ['pcd::base64', b64(new TextEncoder().encode('not a PCD')), 'PCD: missing DATA line in header (scanned first 9 bytes)'],
    ['points::array', { positions: [] }, 'points::array: positions must contain at least one point'],
    ['points::array', { positions: [[1, 2]] }, 'points::array: positions[0] must be a [x,y,z] triple'],
    ['points::array', { positions: [[1, 2, 3]], colors: [] }, 'points::array: colors length (0) does not match positions length (1)'],
    ['points::base64', { positions: floats([1, 2]) }, 'points::base64: positions buffer length (2) is not a multiple of 3 floats'],
    ['points::base64', { positions: floats([1, 2, 3]), colors: '' }, 'points::base64: colors must be a non-empty base64 string when provided'],
  ] as const) {
    it(`retains the ${error} error without falling through`, () => {
      const attributes = attrs(key, value);
      if (key !== 'points::base64') attributes.set('points::base64', { positions: floats([1, 2, 3]) });
      for (const decode of [decodeIfcxPointSource, decodeIfcxPointAttribute]) {
        expect(() => decode(attributes)).toThrow(error);
      }
    });
  }
});
