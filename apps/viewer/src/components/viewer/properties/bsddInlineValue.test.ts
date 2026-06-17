/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { toPropertyValueType, defaultValue } from './bsddInlineValue.js';
import { PropertyValueType } from '@ifc-lite/data';

describe('toPropertyValueType', () => {
  it('maps bSDD dataType strings (case-insensitive)', () => {
    assert.strictEqual(toPropertyValueType('Boolean'), PropertyValueType.Boolean);
    assert.strictEqual(toPropertyValueType('boolean'), PropertyValueType.Boolean);
    assert.strictEqual(toPropertyValueType('Real'), PropertyValueType.Real);
    assert.strictEqual(toPropertyValueType('Integer'), PropertyValueType.Integer);
    assert.strictEqual(toPropertyValueType('Character'), PropertyValueType.String);
    assert.strictEqual(toPropertyValueType(null), PropertyValueType.String);
    assert.strictEqual(toPropertyValueType('Enumeration'), PropertyValueType.Label);
  });
});

describe('defaultValue', () => {
  it('returns false for boolean so the value is valid the moment it is added', () => {
    assert.strictEqual(defaultValue('Boolean'), false);
    assert.strictEqual(defaultValue('boolean'), false);
  });

  it('returns empty string for every other type (manual entry)', () => {
    assert.strictEqual(defaultValue('Character'), '');
    assert.strictEqual(defaultValue('Real'), '');
    assert.strictEqual(defaultValue('Integer'), '');
    assert.strictEqual(defaultValue(null), '');
  });
});
