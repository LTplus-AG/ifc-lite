/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';

import { applyUnitConversion } from './units.js';

/**
 * IDS literal values are always base SI (metres), but the IFC store keeps
 * the raw author value in the project's declared length unit. When a
 * project is authored in millimetres (`lengthUnitScale = 0.001`), a stored
 * `1000` means `1.0 metre` and must be converted before an IDS numeric
 * check can match it.
 */
describe('applyUnitConversion', () => {
  it('is a no-op when scale is undefined', () => {
    const result = applyUnitConversion(1000, ['1000'], 'IFCLENGTHMEASURE', undefined);
    expect(result).toEqual({ value: 1000, values: ['1000'] });
  });

  it('is a no-op when scale is 1 (already base SI)', () => {
    const result = applyUnitConversion(1000, ['1000'], 'IFCLENGTHMEASURE', 1);
    expect(result).toEqual({ value: 1000, values: ['1000'] });
  });

  it('converts a single IFCLENGTHMEASURE value by lengthUnitScale (mm -> m)', () => {
    // 1000 mm stored, scale 0.001 -> 1 metre for the IDS base-SI check.
    const result = applyUnitConversion(1000, undefined, 'IfcLengthMeasure', 0.001);
    expect(result.value).toBe(1);
    expect(result.values).toBeUndefined();
  });

  it('converts IFCPOSITIVELENGTHMEASURE the same way as IFCLENGTHMEASURE', () => {
    const result = applyUnitConversion(2500, undefined, 'IfcPositiveLengthMeasure', 0.001);
    expect(result.value).toBe(2.5);
  });

  it('converts every entry of an array-valued length measure', () => {
    const result = applyUnitConversion(
      null,
      ['1000', '2000', '500'],
      'IFCLENGTHMEASURE',
      0.001
    );
    expect(result.values).toEqual(['1', '2', '0.5']);
  });

  it('leaves non-length typed values untouched', () => {
    const result = applyUnitConversion('Concrete', ['Concrete'], 'IfcLabel', 0.001);
    expect(result).toEqual({ value: 'Concrete', values: ['Concrete'] });
  });

  it('double-appends raw and scaled forms for an untyped table (dataType undefined)', () => {
    // IfcPropertyTableValue columns mix labels and measures with no
    // declared dataType, so every numeric candidate must be surfaced in
    // both unit spaces for an IDS check to match either one.
    const result = applyUnitConversion(null, ['1000', 'Concrete'], undefined, 0.001);
    // Numeric entry expands to raw + scaled; non-numeric entry stays as-is.
    expect(result.values).toEqual(['1000', '1', 'Concrete']);
    // The scalar value is passed through unchanged for the table case.
    expect(result.value).toBeNull();
  });

  it('does not duplicate an untyped-table entry when raw and scaled render identically', () => {
    // 0 mm scales to 0 m either way; the string forms are identical so no
    // duplicate should be appended.
    const result = applyUnitConversion(null, ['0'], undefined, 0.001);
    expect(result.values).toEqual(['0']);
  });

  it('skips the untyped-table conversion when rawValues is empty', () => {
    const result = applyUnitConversion('x', [], undefined, 0.001);
    expect(result).toEqual({ value: 'x', values: [] });
  });
});
