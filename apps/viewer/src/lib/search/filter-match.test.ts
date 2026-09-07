/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parsePropertyValue } from '@ifc-lite/encoding';
import { stringifyValue, nameMatches, matchPropertyRule, matchQuantityRule } from './filter-match.js';
import { Rule } from './filter-rules.js';

/**
 * `discoverFilterValues` (filter-schema.ts) populates the List Builder /
 * Search chip value dropdowns by stringifying sampled property values with
 * `stringifyValue`. The property TABLE and the list engine's own display
 * (`packages/lists/src/engine.ts` → `@ifc-lite/encoding`'s
 * `parsePropertyValue`) both render an IFC boolean as "True"/"False".
 *
 * If discovery's stringification disagrees with the display/compare side,
 * the dropdown offers a value ("true") the user never actually sees in the
 * table ("True") — issue reported: user picks the dropdown value for
 * Pset_WallCommon.IsExternal and the filter matches nothing.
 */
describe('stringifyValue — boolean rendering matches the display/compare side', () => {
  it('renders a boolean the same way parsePropertyValue (the engine/table display) does', () => {
    assert.strictEqual(stringifyValue(true), parsePropertyValue(true).displayValue);
    assert.strictEqual(stringifyValue(false), parsePropertyValue(false).displayValue);
  });

  it('BOUNDING CONTROL: a plain string value (e.g. a FireRating) is unchanged', () => {
    assert.strictEqual(stringifyValue('EI60'), 'EI60');
  });

  it('BOUNDING CONTROL: numeric values are unchanged', () => {
    assert.strictEqual(stringifyValue(0.24), '0.24');
    assert.strictEqual(stringifyValue(42), '42');
  });

  it('null/undefined still stringify to empty string', () => {
    assert.strictEqual(stringifyValue(null), '');
    assert.strictEqual(stringifyValue(undefined), '');
  });
});

/**
 * `/Pset_.*Common/.FireRating` — the selector syntax's regex property-set and
 * property names (#4091). Only `nameMatches` decides which rows a property or
 * quantity rule can see, so this is where one rule reaches several sets.
 */
describe('nameMatches — regex property-set / property names', () => {
  it('a /…/ literal matches several real set names', () => {
    assert.strictEqual(nameMatches('/Pset_.*Common/', 'Pset_WallCommon'), true);
    assert.strictEqual(nameMatches('/Pset_.*Common/', 'Pset_SlabCommon'), true);
    assert.strictEqual(nameMatches('/Pset_.*Common/', 'Qto_WallBaseQuantities'), false);
  });

  it('a plain name stays an exact, case-insensitive compare', () => {
    assert.strictEqual(nameMatches('Pset_WallCommon', 'PSET_WALLCOMMON'), true);
    assert.strictEqual(nameMatches('Pset_WallCommon', 'Pset_WallCommonExtra'), false);
  });

  it('an invalid pattern matches nothing rather than throwing', () => {
    assert.doesNotThrow(() => nameMatches('/Pset_[/', 'Pset_WallCommon'));
    assert.strictEqual(nameMatches('/Pset_[/', 'Pset_WallCommon'), false);
  });
});

describe('matchPropertyRule / matchQuantityRule read names through nameMatches', () => {
  const psetRows = [
    { setName: 'Pset_WallCommon', propertyName: 'FireRating', value: 'REI 60' },
    { setName: 'Pset_SlabCommon', propertyName: 'LoadBearing', value: 'True' },
  ];

  it('one regex set name reaches a property in a differently-named set', () => {
    assert.strictEqual(
      matchPropertyRule(Rule.property('/Pset_.*Common/', 'LoadBearing', 'eq', 'True'), psetRows),
      true,
    );
    assert.strictEqual(
      matchPropertyRule(Rule.property('Pset_WallCommon', 'LoadBearing', 'eq', 'True'), psetRows),
      false,
    );
  });

  it('isSet / isNotSet honour the same regex set name', () => {
    assert.strictEqual(
      matchPropertyRule(Rule.property('/Pset_.*Common/', 'FireRating', 'isSet', ''), psetRows),
      true,
    );
    assert.strictEqual(
      matchPropertyRule(Rule.property('/Qto_.*/', 'FireRating', 'isSet', ''), psetRows),
      false,
    );
  });

  it('a regex property VALUE op runs against the matched row, unanchored', () => {
    assert.strictEqual(
      matchPropertyRule(Rule.property('/Pset_.*Common/', 'FireRating', 'matches', 'REI.*'), psetRows),
      true,
    );
    // Unanchored, so a substring is a match: 'REI 60' contains 'EI 60'.
    assert.strictEqual(
      matchPropertyRule(Rule.property('/Pset_.*Common/', 'FireRating', 'matches', 'EI [0-9]+$'), psetRows),
      true,
    );
    assert.strictEqual(
      matchPropertyRule(Rule.property('/Pset_.*Common/', 'FireRating', 'matches', '^EI [0-9]+$'), psetRows),
      false,
    );
  });

  it('quantity rules take the same regex set names', () => {
    const qtyRows = [{ setName: 'Qto_WallBaseQuantities', quantityName: 'NetVolume', value: 2.5 }];
    assert.strictEqual(matchQuantityRule(Rule.quantity('/Qto_.*/', 'NetVolume', 'gt', 1), qtyRows), true);
    assert.strictEqual(matchQuantityRule(Rule.quantity('/Qto_.*/', 'NetVolume', 'gt', 9), qtyRows), false);
  });
});
