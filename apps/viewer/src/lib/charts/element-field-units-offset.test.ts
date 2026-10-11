/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A property whose own `Unit` is an `IfcConversionBasedUnitWithOffset` (°F)
 * converts into the column's unit with its offset: 68 °F is 293.15 K, not the
 * 37.78 a scale alone gives.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ElementFieldBinding } from '@ifc-lite/charts';
import type { ListColumnUnitResolver } from '@/lib/units/list-column-units';
import { resolveFieldCell } from './element-field-units.js';

const kelvin: ListColumnUnitResolver = {
  unitSymbol: () => 'K',
  sourceUnitSymbol: () => 'K',
  targetUnit: () => ({ scale: 1, offset: 0, symbol: 'K' }),
  convertCell: (_i, value) => value,
};

const field: ElementFieldBinding = {
  kind: 'property', psetName: 'Temps', propertyName: 'Own', valueKind: 'number', dataType: 'IFCTHERMODYNAMICTEMPERATUREMEASURE',
};

describe('a chart cell in its own offset unit (°F)', () => {
  it('converts 68 °F to 293.15 K, offset included', () => {
    const cell = resolveFieldCell(
      { value: 68, status: 'value', unit: 'Fahrenheit', unitSiScale: 5 / 9, unitSiOffset: 459.67 * 5 / 9, dataType: 'IFCTHERMODYNAMICTEMPERATUREMEASURE' },
      { field, index: 0, columnUnit: 'K', modelId: 'm', projectUnits: undefined, resolver: kelvin },
    );
    assert.equal(cell.status, 'value');
    assert.ok(Math.abs((cell.value as number) - 293.15) < 1e-9, `expected 293.15, got ${String(cell.value)}`);
  });
});
