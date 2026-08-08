/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parsePropertyValue } from '@ifc-lite/encoding';
import { stringifyValue } from './filter-match.js';

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
