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

  /**
   * Area and volume do NOT scale by the length factor — area scales by
   * its SQUARE, volume by its CUBE. A fix that (wrongly) reused the
   * length-conversion direction would multiply by `scale` (1e-3) instead
   * of `scale ** 2` (1e-6) / `scale ** 3` (1e-9); these pin the exponent
   * explicitly so that regression can't sneak back in.
   */
  describe('area and volume measures', () => {
    it('converts IFCAREAMEASURE by the SQUARE of the length scale, not the length scale itself', () => {
      // 2,000,000 mm² == 2 m². scale ** 2 = 1e-6, not scale = 1e-3
      // (which would wrongly yield 2000) and not scale ** 3 = 1e-9
      // (which would wrongly yield 0.002).
      const result = applyUnitConversion(2_000_000, undefined, 'IFCAREAMEASURE', 0.001);
      expect(result.value).toBe(2);
    });

    it('converts IFCVOLUMEMEASURE by the CUBE of the length scale, not the square', () => {
      // 3,000,000,000 mm³ == 3 m³. scale ** 3 = 1e-9, not scale ** 2 = 1e-6
      // (which would wrongly yield 3000).
      const result = applyUnitConversion(3_000_000_000, undefined, 'IFCVOLUMEMEASURE', 0.001);
      expect(result.value).toBe(3);
    });

    it('converts an array of IFCAREAMEASURE values by the squared scale', () => {
      const result = applyUnitConversion(
        null,
        ['1000000', '2000000'],
        'IFCAREAMEASURE',
        0.001
      );
      expect(result.values).toEqual(['1', '2']);
    });

    it('prefers an explicitly-passed area scale over deriving one from the length scale', () => {
      // A project can declare AREAUNIT independently of LENGTHUNIT (an
      // IFCSIUNIT/IFCCONVERSIONBASEDUNIT with no arithmetic relationship
      // to the length unit). When the caller supplies a resolved area
      // scale (see `resolveMeasureScales`), it must win over the
      // length-derived fallback (`scale ** 2`).
      const declaredAreaScale = 1; // e.g. AREAUNIT declared as plain m², length in mm
      const result = applyUnitConversion(2, undefined, 'IFCAREAMEASURE', 0.001, {
        area: declaredAreaScale,
      });
      expect(result.value).toBe(2); // NOT 2 * (0.001 ** 2) = 0.000002
    });

    it('prefers an explicitly-passed volume scale over deriving one from the length scale', () => {
      const declaredVolumeScale = 1;
      const result = applyUnitConversion(3, undefined, 'IFCVOLUMEMEASURE', 0.001, {
        volume: declaredVolumeScale,
      });
      expect(result.value).toBe(3);
    });

    it('falls back to scale ** 2 / scale ** 3 when no declared area/volume scale is supplied', () => {
      const area = applyUnitConversion(2_000_000, undefined, 'IFCAREAMEASURE', 0.001, {});
      const volume = applyUnitConversion(3_000_000_000, undefined, 'IFCVOLUMEMEASURE', 0.001, {});
      expect(area.value).toBe(2);
      expect(volume.value).toBe(3);
    });

    it('is a no-op for area/volume when scale is 1 (already base SI)', () => {
      const area = applyUnitConversion(2, undefined, 'IFCAREAMEASURE', 1);
      const volume = applyUnitConversion(3, undefined, 'IFCVOLUMEMEASURE', 1);
      expect(area.value).toBe(2);
      expect(volume.value).toBe(3);
    });
  });

  /**
   * Regression guard: IFCCOUNTMEASURE, IFCMASSMEASURE and IFCTIMEMEASURE
   * must NEVER be scaled by any length-derived factor. A count silently
   * multiplied by 1000 would be a far worse bug than the gap this file
   * closes for length/area/volume.
   */
  describe('count, mass and time are never scaled', () => {
    it('leaves IFCCOUNTMEASURE untouched regardless of scale', () => {
      const result = applyUnitConversion(5, undefined, 'IFCCOUNTMEASURE', 0.001);
      expect(result.value).toBe(5);
    });

    it('leaves IFCMASSMEASURE untouched regardless of scale', () => {
      const result = applyUnitConversion(1000, undefined, 'IFCMASSMEASURE', 0.001);
      expect(result.value).toBe(1000);
    });

    it('leaves IFCTIMEMEASURE untouched regardless of scale', () => {
      const result = applyUnitConversion(60, undefined, 'IFCTIMEMEASURE', 0.001);
      expect(result.value).toBe(60);
    });
  });
});
