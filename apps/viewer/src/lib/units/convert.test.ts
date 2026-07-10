/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { convertValue, resolveFromUnit, type LinearUnit } from './convert.js';
import { alternativesForUnitType } from './alternatives.js';

function option(unitType: string, id: string) {
  const opt = alternativesForUnitType(unitType).find((o) => o.id === id);
  assert.ok(opt, `expected a curated ${unitType} option with id "${id}"`);
  return opt!;
}

describe('convertValue', () => {
  it('converts m³/s to m³/h', () => {
    const from = option('VOLUMETRICFLOWRATEUNIT', 'm3s'); // SI base, scale 1
    const to = option('VOLUMETRICFLOWRATEUNIT', 'm3h');
    const result = convertValue(0.013888888888888888, from, to);
    assert.ok(Math.abs(result - 50) < 1e-6, `expected ~50, got ${result}`);
  });

  it('is the identity when from and to are the same unit', () => {
    const mm = option('LENGTHUNIT', 'mm');
    const result = convertValue(3000, mm, mm);
    assert.strictEqual(result, 3000);
  });

  it('adds the offset when converting °C to K', () => {
    const celsius = option('THERMODYNAMICTEMPERATUREUNIT', 'c');
    const kelvin = option('THERMODYNAMICTEMPERATUREUNIT', 'k');
    const result = convertValue(0, celsius, kelvin);
    assert.ok(Math.abs(result - 273.15) < 1e-9, `expected 273.15, got ${result}`);
  });

  it('subtracts the offset when converting K to °C', () => {
    const kelvin = option('THERMODYNAMICTEMPERATUREUNIT', 'k');
    const celsius = option('THERMODYNAMICTEMPERATUREUNIT', 'c');
    const result = convertValue(273.15, kelvin, celsius);
    assert.ok(Math.abs(result - 0) < 1e-9, `expected 0, got ${result}`);
  });

  // #1573 follow-up: `to` accepts any plain LinearUnit (no `id`/`symbol`),
  // not just a curated `UnitOption` — the Lists single-target normalization
  // resolver targets a file-declared unit directly.
  it('accepts a plain LinearUnit (no id/symbol) as the target', () => {
    const from: LinearUnit = { scale: 1e-3 }; // mm
    const to: LinearUnit = { scale: 1 }; // m, a bare file-declared unit
    const result = convertValue(1000, from, to);
    assert.strictEqual(result, 1);
  });
});

describe('resolveFromUnit', () => {
  it('recovers the curated offset when the file unit symbol matches a curated option (°C)', () => {
    const from = resolveFromUnit('THERMODYNAMICTEMPERATUREUNIT', { symbol: '°C', siScale: 1 });
    assert.strictEqual(from.scale, 1);
    assert.strictEqual(from.offset, 273.15);
  });

  it('falls back to the raw SI scale with no offset for an uncurated unit type', () => {
    const from = resolveFromUnit('ELECTRICCURRENTUNIT', { symbol: 'A', siScale: 1 });
    assert.strictEqual(from.scale, 1);
    assert.strictEqual(from.offset, 0);
  });

  it('falls back to the raw SI scale when the file symbol matches no curated option', () => {
    // A file declaring an unusual/renamed length symbol we don't curate.
    const from = resolveFromUnit('LENGTHUNIT', { symbol: 'furlong', siScale: 201.168 });
    assert.strictEqual(from.scale, 201.168);
    assert.strictEqual(from.offset, 0);
  });
});
