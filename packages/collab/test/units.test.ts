/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { createCollabDoc } from '../src/doc/schema.js';
import { createEntity, setPropertyValue, getPropertyValue } from '../src/doc/entity.js';
import {
  convertEntityUnits,
  convertValue,
  familyOf,
} from '../src/doc/units.js';

describe('unit conversion', () => {
  it('familyOf classifies length/area/volume/angle', () => {
    expect(familyOf('m')).toBe('length');
    expect(familyOf('mm')).toBe('length');
    expect(familyOf('m^2')).toBe('area');
    expect(familyOf('m^3')).toBe('volume');
    expect(familyOf('deg')).toBe('angle');
    expect(familyOf('parsec')).toBeNull();
  });

  it('convertValue handles known length pairs', () => {
    expect(convertValue(1, 'm', 'mm')).toBe(1000);
    expect(convertValue(1000, 'mm', 'm')).toBe(1);
    expect(convertValue(1, 'ft', 'm')).toBeCloseTo(0.3048, 6);
  });

  it('convertValue rejects cross-family conversions', () => {
    expect(convertValue(1, 'm', 'm^2')).toBeNull();
    expect(convertValue(1, 'rad', 'm')).toBeNull();
    expect(convertValue(1, 'unknown', 'm')).toBeNull();
  });

  it('convertEntityUnits walks Psets and converts matching unit', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'wall');
    setPropertyValue(doc, 'wall', 'Pset_WallCommon', 'Length', {
      type: 'IfcReal',
      value: 1500,
      unit: 'mm',
    });
    setPropertyValue(doc, 'wall', 'Pset_WallCommon', 'FireRating', {
      type: 'IfcLabel',
      value: 'EI60',
    });

    const report = convertEntityUnits(doc, 'mm', 'm');
    expect(report.converted).toBe(1);

    const length = getPropertyValue(doc, 'wall', 'Pset_WallCommon', 'Length');
    expect(length?.value).toBe(1.5);
    expect(length?.unit).toBe('m');

    // Non-numeric / no unit untouched.
    const fr = getPropertyValue(doc, 'wall', 'Pset_WallCommon', 'FireRating');
    expect(fr?.value).toBe('EI60');
  });

  it('skips properties with mismatched unit', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'wall');
    setPropertyValue(doc, 'wall', 'P', 'L', { type: 'IfcReal', value: 1, unit: 'cm' });
    const report = convertEntityUnits(doc, 'mm', 'm');
    expect(report.converted).toBe(0);
    expect(report.skipped).toBe(1);
  });
});
