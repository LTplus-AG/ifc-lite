/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { toPropertyValueType, defaultValue, inlineControlKind } from './bsddInlineValue.js';
import { PropertyValueType } from '@ifc-lite/data';
import type { BsddClassProperty } from '@/services/bsdd';

function prop(partial: Partial<BsddClassProperty>): BsddClassProperty {
  return {
    name: 'P',
    dataType: null,
    allowedValues: null,
    propertySet: 'Pset_Test',
    ...partial,
  } as BsddClassProperty;
}

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

describe('inlineControlKind', () => {
  it('offers a boolean control for a Boolean dataType', () => {
    assert.strictEqual(inlineControlKind(prop({ dataType: 'Boolean' })), 'boolean');
  });

  it('offers an enum control when allowedValues are present', () => {
    assert.strictEqual(
      inlineControlKind(prop({ dataType: 'Character', allowedValues: [{ value: 'A' }, { value: 'B' }] })),
      'enum',
    );
  });

  it('prefers boolean over enum when both could apply', () => {
    assert.strictEqual(
      inlineControlKind(prop({ dataType: 'Boolean', allowedValues: [{ value: 'X' }] })),
      'boolean',
    );
  });

  it('returns null for a plain string property (no inline control, manual entry)', () => {
    assert.strictEqual(inlineControlKind(prop({ dataType: 'Character', allowedValues: null })), null);
    assert.strictEqual(inlineControlKind(prop({ dataType: 'Character', allowedValues: [] })), null);
  });
});
