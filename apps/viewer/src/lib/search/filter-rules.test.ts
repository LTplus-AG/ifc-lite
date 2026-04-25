/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  setOpMatches,
  stringOpMatches,
  numericOpMatches,
  valueOpMatches,
  combineRuleResults,
  isFilterRule,
  parseFilterRules,
  Rule,
} from './filter-rules.js';

describe('setOpMatches', () => {
  it('matches case-insensitively for "in"', () => {
    assert.strictEqual(setOpMatches('in', 'IfcWall', ['ifcwall', 'IfcDoor']), true);
    assert.strictEqual(setOpMatches('in', 'IfcSlab', ['IfcWall', 'IfcDoor']), false);
  });
  it('inverts for "notIn"', () => {
    assert.strictEqual(setOpMatches('notIn', 'IfcSlab', ['IfcWall']), true);
    assert.strictEqual(setOpMatches('notIn', 'IfcWall', ['IfcWall']), false);
  });
  it('treats an empty values list as no match for "in"', () => {
    assert.strictEqual(setOpMatches('in', 'IfcWall', []), false);
    assert.strictEqual(setOpMatches('notIn', 'IfcWall', []), true);
  });
});

describe('stringOpMatches', () => {
  it('eq / ne are case-insensitive', () => {
    assert.strictEqual(stringOpMatches('eq', 'Foo', 'FOO'), true);
    assert.strictEqual(stringOpMatches('ne', 'Foo', 'bar'), true);
    assert.strictEqual(stringOpMatches('ne', 'Foo', 'foo'), false);
  });
  it('contains / notContains ignore case', () => {
    assert.strictEqual(stringOpMatches('contains', 'Wall-EXT', 'ext'), true);
    assert.strictEqual(stringOpMatches('notContains', 'Wall-EXT', 'int'), true);
  });
  it('startsWith ignores case', () => {
    assert.strictEqual(stringOpMatches('startsWith', 'IfcWallStandardCase', 'ifcwall'), true);
    assert.strictEqual(stringOpMatches('startsWith', 'IfcWall', 'wall'), false);
  });
});

describe('numericOpMatches', () => {
  it('eq uses 1e-9 epsilon (matches Rust impl)', () => {
    assert.strictEqual(numericOpMatches('eq', 1.0 + 1e-12, 1.0), true);
    assert.strictEqual(numericOpMatches('eq', 1.0 + 1e-7, 1.0), false);
  });
  it('gt/gte/lt/lte are exact', () => {
    assert.strictEqual(numericOpMatches('gt', 5, 5), false);
    assert.strictEqual(numericOpMatches('gte', 5, 5), true);
    assert.strictEqual(numericOpMatches('lt', 5, 5), false);
    assert.strictEqual(numericOpMatches('lte', 5, 5), true);
  });
});

describe('valueOpMatches', () => {
  it('isSet / isNotSet check string presence', () => {
    assert.strictEqual(valueOpMatches('isSet', 'foo', ''), true);
    assert.strictEqual(valueOpMatches('isSet', '', ''), false);
    assert.strictEqual(valueOpMatches('isNotSet', '', ''), true);
  });
  it('eq / ne / contains pass through case-insensitive', () => {
    assert.strictEqual(valueOpMatches('eq', 'Concrete', 'concrete'), true);
    assert.strictEqual(valueOpMatches('contains', 'C30/37', '30'), true);
    assert.strictEqual(valueOpMatches('notContains', 'C30/37', '50'), true);
  });
  it('numeric ops parse both sides as floats; NaN parses fail closed', () => {
    assert.strictEqual(valueOpMatches('gt', '12.5', '10'), true);
    assert.strictEqual(valueOpMatches('lt', '12.5', '10'), false);
    assert.strictEqual(valueOpMatches('gt', 'abc', '10'), false);
    assert.strictEqual(valueOpMatches('gt', '12', 'abc'), false);
  });
});

describe('combineRuleResults', () => {
  it('AND requires all true', () => {
    assert.strictEqual(combineRuleResults('AND', [true, true]), true);
    assert.strictEqual(combineRuleResults('AND', [true, false]), false);
  });
  it('OR requires any true', () => {
    assert.strictEqual(combineRuleResults('OR', [false, true]), true);
    assert.strictEqual(combineRuleResults('OR', [false, false]), false);
  });
  it('returns false on an empty list (no rule = no match)', () => {
    assert.strictEqual(combineRuleResults('AND', []), false);
    assert.strictEqual(combineRuleResults('OR', []), false);
  });
});

describe('isFilterRule / parseFilterRules', () => {
  it('accepts every known kind', () => {
    assert.strictEqual(isFilterRule(Rule.storey(['L1'])), true);
    assert.strictEqual(isFilterRule(Rule.ifcType(['IfcWall'])), true);
    assert.strictEqual(isFilterRule(Rule.predefinedType(['SOLID'])), true);
    assert.strictEqual(isFilterRule(Rule.name('contains', 'wall')), true);
    assert.strictEqual(isFilterRule(Rule.property('Pset_X', 'P', 'eq', 'v')), true);
    assert.strictEqual(isFilterRule(Rule.quantity('Qto_X', 'Q', 'gt', 1)), true);
  });
  it('rejects unknown kinds and non-objects', () => {
    assert.strictEqual(isFilterRule({ kind: 'bogus' }), false);
    assert.strictEqual(isFilterRule(null), false);
    assert.strictEqual(isFilterRule('storey'), false);
  });
  it('parseFilterRules drops invalid entries', () => {
    const parsed = parseFilterRules([
      { kind: 'ifcType', values: ['IfcWall'], op: 'in' },
      { kind: 'unknown' },
      'nope',
    ]);
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].kind, 'ifcType');
  });

  it('rejects rules with the right kind but missing required fields', () => {
    // Tampered localStorage payloads — saved-filters round-trips through
    // parseFilterRules, so a `{kind:'ifcType'}` without values would
    // crash the evaluator at `rule.values.some(...)`. The shape guard
    // catches it at the deserialise boundary.
    assert.strictEqual(isFilterRule({ kind: 'ifcType' }), false);
    assert.strictEqual(isFilterRule({ kind: 'ifcType', values: 'not-array', op: 'in' }), false);
    assert.strictEqual(isFilterRule({ kind: 'ifcType', values: [1, 2], op: 'in' }), false);
    assert.strictEqual(isFilterRule({ kind: 'ifcType', values: [], op: 'bogus' }), false);

    assert.strictEqual(isFilterRule({ kind: 'name' }), false);
    assert.strictEqual(isFilterRule({ kind: 'name', value: 'x', op: 'unknown' }), false);

    assert.strictEqual(isFilterRule({ kind: 'property', setName: 'P', propertyName: 'X' }), false);
    assert.strictEqual(
      isFilterRule({ kind: 'property', setName: 'P', propertyName: 'X', op: 'eq', value: 42 }),
      false,
      'value must be a string for property',
    );

    assert.strictEqual(isFilterRule({ kind: 'quantity', setName: 'Q', quantityName: 'V' }), false);
    assert.strictEqual(
      isFilterRule({ kind: 'quantity', setName: 'Q', quantityName: 'V', op: 'gt', value: '5' }),
      false,
      'quantity value must be a number',
    );
    assert.strictEqual(
      isFilterRule({ kind: 'quantity', setName: 'Q', quantityName: 'V', op: 'gt', value: NaN }),
      false,
      'NaN is not a finite number',
    );
  });
});
