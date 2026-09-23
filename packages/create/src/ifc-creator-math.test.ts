/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { EntityExtractor, IfcParser } from '@ifc-lite/parser';
import { num } from './ifc-creator-math.js';
import { IfcCreator } from './ifc-creator.js';

describe('num()', () => {
  // No-regression pins: the exact strings the normal path must keep
  // producing. These must stay byte-identical.
  it('formats an ordinary decimal unchanged', () => {
    expect(num(123.5)).toBe('123.5');
  });

  it('formats a small exponent-notation value as fixed decimal', () => {
    expect(num(1e-7)).toBe('0.00000010');
  });

  it('appends the trailing decimal point STEP requires for an integer value', () => {
    expect(num(5)).toBe('5.');
  });

  it('formats a negative ordinary decimal unchanged', () => {
    expect(num(-5)).toBe('-5.');
  });

  it('formats a negative small exponent-notation value as fixed decimal', () => {
    expect(num(-1e-7)).toBe('-0.00000010');
  });

  // #5195: `toFixed(10)` itself returns JS exponent form (`1e+21`, no
  // mantissa point, not a legal STEP real_literal) once |v| >= 1e21
  // (ECMA-262). Those magnitudes must come out in the STEP exponent form.
  it('writes 1e21 as a STEP exponent REAL with a mantissa point', () => {
    expect(num(1e21)).toBe('1.E+21');
  });

  it('writes Number.MAX_VALUE as a STEP exponent REAL', () => {
    expect(num(Number.MAX_VALUE)).toBe('1.7976931348623157E+308');
  });

  it('writes -1e21 as a STEP exponent REAL', () => {
    expect(num(-1e21)).toBe('-1.E+21');
  });

  it('every large-magnitude output matches the ISO 10303-21 REAL grammar', () => {
    const STEP_REAL = /^[+-]?\d+\.\d*(?:E[+-]?\d+)?$/;
    for (const v of [1e21, 2.5e21, -3e25, 1.23456789e100, Number.MAX_VALUE]) {
      expect(num(v)).toMatch(STEP_REAL);
    }
  });

  it('refuses NaN and Infinity', () => {
    expect(() => num(NaN)).toThrow('not a finite number');
    expect(() => num(Infinity)).toThrow('not a finite number');
  });

  it('keeps the fixed-decimal form just under 1e21', () => {
    expect(num(9.99e20)).toBe('999000000000000000000.');
  });

  it('keeps the fixed-decimal form for projected-coordinate-scale values', () => {
    expect(num(5e8)).toBe('500000000.');
    expect(num(1e15)).toBe('1000000000000000.');
  });
});

describe('end-to-end: ordinary authored wall still succeeds', () => {
  it('addIfcWall with ordinary dimensions does not throw and emits a wall', () => {
    const creator = new IfcCreator();
    const storey = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    const wallId = creator.addIfcWall(storey, {
      Start: [0, 0, 0],
      End: [5, 0, 0],
      Height: 3,
      Thickness: 0.2,
    });
    expect(wallId).toBeGreaterThan(0);
    const result = creator.toIfc();
    expect(result.content).toContain('IFCWALL');
  });

  it('a wall with a coordinate at 1e21 emits no JS exponent token (#5195)', () => {
    const creator = new IfcCreator();
    const storey = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    creator.addIfcWall(storey, {
      Start: [1e21, 0, 0],
      End: [1e21 + 5e6, 0, 0],
      Height: 3,
      Thickness: 0.2,
    });
    const { content } = creator.toIfc();
    expect(content).toContain('1.E+21');
    // A JS exponent without a mantissa point, e.g. `1e+21`, is the invalid token.
    expect(content).not.toMatch(/(?<![\w.'$])[+-]?\d+[eE][+-]?\d+/);
  });

  it('the STEP exponent token reads back as the same number through @ifc-lite/parser (#5195)', async () => {
    const creator = new IfcCreator();
    const storey = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    creator.addIfcWall(storey, { Start: [1e21, 0, 0], End: [1e21 + 5e6, 0, 0], Height: 3, Thickness: 0.2 });
    const bytes = new TextEncoder().encode(creator.toIfc().content);
    const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer);
    const extractor = new EntityExtractor(store.source);
    const xs = (store.entityIndex.byType.get('IFCCARTESIANPOINT') ?? []).map((id) => {
      const coords = extractor.extractEntity(store.entityIndex.byId.get(id)!)?.attributes?.[0];
      return Array.isArray(coords) ? coords[0] : undefined;
    });
    expect(xs).toContain(1e21);
  });
});
