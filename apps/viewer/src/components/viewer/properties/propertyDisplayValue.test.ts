/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectUnits } from '@ifc-lite/parser';
import { QuantityType } from '@ifc-lite/data';
import { propertyDisplayValue, quantityDisplayValue } from './propertyDisplayValue';

// #9950: the property, quantity and structural cards print a number by one rule: the app locale,
// six significant digits or three decimals, whichever keeps more.
describe('the one measure number format', () => {
  const units = ProjectUnits.empty();
  const length = (value: number) => ({ name: 'L', type: QuantityType.Length, value }) as Parameters<typeof quantityDisplayValue>[0];

  it('keeps a small stated value whole and a large one to its three decimals', () => {
    assert.equal(quantityDisplayValue(length(0.0125), units, {}, 'en'), '0.0125 m');
    assert.equal(quantityDisplayValue(length(1234567.891), units, {}, 'en'), '1,234,567.891 m');
    assert.equal(quantityDisplayValue(length(1234.56789), units, {}, 'en'), '1,234.568 m');
    assert.equal(quantityDisplayValue(length(0.000123456789), units, {}, 'en'), '0.000123457 m');
  });

  it('uses the separators of the app locale', () => {
    assert.equal(quantityDisplayValue(length(1234.5), units, {}, 'de'), '1.234,5 m');
    assert.equal(quantityDisplayValue(length(1234.5), units, {}, 'en'), '1,234.5 m');
    assert.equal(quantityDisplayValue(length(1234.5), units, {}, 'not a locale'), '1,234.5 m');
  });
});

describe('the cards give the same value the same text', () => {
  const units = ProjectUnits.empty();
  const property = { name: 'Span', value: 0.0125, dataType: 'IfcLengthMeasure' };
  const length = { name: 'Span', type: QuantityType.Length, value: 0.0125 } as Parameters<typeof quantityDisplayValue>[0];

  it('prints a converted property and a converted quantity alike', () => {
    // 0.0125 m shown in millimetres is 12.5 mm in both.
    const overrides = { LENGTHUNIT: 'mm' };
    assert.equal(propertyDisplayValue(property, units, overrides, true, 'en').value, '12.5');
    assert.equal(quantityDisplayValue(length, units, overrides, 'en'), '12.5 mm');
  });

  it('keeps an unconverted quantity of 0.0125 m at 0.0125, not 0.013', () => {
    assert.equal(quantityDisplayValue(length, units, {}, 'en'), '0.0125 m');
  });

  it('formats an unconverted measure property by the same rule and locale', () => {
    const big = { name: 'Span', value: 1234.56789, dataType: 'IfcLengthMeasure' };
    assert.equal(propertyDisplayValue(big, units, {}, true, 'en').value, '1,234.568');
    assert.equal(propertyDisplayValue(big, units, {}, true, 'de').value, '1.234,568');
    assert.equal(propertyDisplayValue(big, units, {}, true, 'de').full, '1.234,568 m');
    // Text and unit-less values keep their parsed display.
    assert.equal(propertyDisplayValue({ name: 'Mark', value: 'A-12', dataType: 'IfcLabel' }, units, {}, true, 'de').value, 'A-12');
  });

  it('follows the locale in a converted property too', () => {
    const big = { name: 'Span', value: 1.2345, dataType: 'IfcLengthMeasure' };
    assert.equal(propertyDisplayValue(big, units, { LENGTHUNIT: 'mm' }, true, 'de').value, '1.234,5');
    assert.equal(propertyDisplayValue(big, units, { LENGTHUNIT: 'mm' }, true, 'en').value, '1,234.5');
  });
});
