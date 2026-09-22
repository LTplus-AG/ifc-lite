/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { assertFinitePoint3, assertPositiveFinite, num } from './ifc-creator-math.js';
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

  // Fail-closed: values whose magnitude defeats the toFixed(10) fallback
  // (ECMA-262: toFixed itself returns exponential notation once |v| >= 1e21)
  // must be refused, not silently emitted as an invalid STEP token.
  it('refuses 1e21, naming the value', () => {
    expect(() => num(1e21)).toThrow(/1e\+21/);
  });

  it('refuses Number.MAX_VALUE, naming the value', () => {
    expect(() => num(Number.MAX_VALUE)).toThrow(/1\.7976931348623157e\+308/);
  });

  it('refuses -1e21', () => {
    expect(() => num(-1e21)).toThrow('STEP REAL');
  });

  it('refuses NaN and Infinity', () => {
    expect(() => num(NaN)).toThrow('not a finite number');
    expect(() => num(Infinity)).toThrow('not a finite number');
  });

  it('accepts the value just under the magnitude bound', () => {
    expect(() => num(9.99e20)).not.toThrow();
  });

  // Over-refusal pin: a plausible large-but-legitimate value (e.g. a
  // projected-CRS coordinate in millimetres, far below the 1e21 bound)
  // must still serialize. Catches a too-tight bound (e.g. rejecting at
  // 1e6) that the small-magnitude pins above cannot catch.
  it('accepts a large but legitimate projected-coordinate-scale value', () => {
    expect(num(5e8)).toBe('500000000.');
    expect(() => num(1e15)).not.toThrow();
  });
});

describe('assertPositiveFinite — magnitude bound', () => {
  it('rejects a dimension at the STEP REAL magnitude bound, naming the field', () => {
    expect(() => assertPositiveFinite({ Height: 1e21 }, 'addIfcWall')).toThrow(
      /addIfcWall: Height \(1e\+21\)/
    );
  });

  it('still accepts an ordinary positive dimension', () => {
    expect(() => assertPositiveFinite({ Height: 3, Thickness: 0.2 }, 'addIfcWall')).not.toThrow();
  });

  it('still accepts a large but legitimate dimension, far below the bound', () => {
    expect(() => assertPositiveFinite({ Height: 5e8 }, 'addIfcWall')).not.toThrow();
  });
});

describe('assertFinitePoint3 — magnitude bound', () => {
  it('rejects a point with an oversized coordinate, naming the field', () => {
    expect(() =>
      assertFinitePoint3({ Start: [0, 0, 0], End: [1e21, 0, 0] }, 'addIfcWall')
    ).toThrow(/addIfcWall: End/);
  });

  it('still accepts ordinary finite coordinates', () => {
    expect(() =>
      assertFinitePoint3({ Start: [0, 0, 0], End: [5, 0, 0] }, 'addIfcWall')
    ).not.toThrow();
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
});
