/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { Rule, isFilterRule, type FilterRule } from './filter-rules.js';
import { parseFilterGroups } from './filter-groups.js';

const valid: FilterRule[] = [
  Rule.model([]), Rule.modelTag('hasAny', []), Rule.storey([], 'in', [{ modelId: 'm', expressId: 42 }]),
  Rule.ifcType([]), Rule.predefinedType([]), Rule.globalId([]), Rule.name('contains', ''),
  Rule.attribute('', 'isSet', ''), Rule.property('', '', 'isSet', ''),
  Rule.quantity('', '', 'gt', 0), Rule.material('contains', ''), Rule.classification('', 'isSet', ''),
  Rule.elevation('gte', -1.5), Rule.typeName('eq', ''), Rule.parent('contains', ''),
  Rule.group('isSet', ''), Rule.modelFact('georef.crs', 'isSet', ''),
  Rule.listCondition({ source: 'property', propertyName: 'Code', operator: 'equals', value: false }),
];

describe('FilterRule structural JSON boundary (#7554)', () => {
  it('preserves every factory kind, blank editor fields and numeric operands through JSON', () => {
    const raw: unknown[] = JSON.parse(JSON.stringify(valid));
    assert.ok(raw.every(isFilterRule));
    assert.deepEqual(parseFilterGroups([{ combinator: 'AND', rules: raw }]), [{ combinator: 'AND', rules: raw }]);
  });

  for (const rule of valid) {
    it(`refuses a missing or unknown operator on ${rule.kind}`, () => {
      const raw: Record<string, unknown> = JSON.parse(JSON.stringify(rule));
      const field = rule.kind === 'listCondition' ? 'operator' : 'op';
      delete raw[field];
      assert.equal(isFilterRule(raw), false);
      raw[field] = 'unknown';
      assert.equal(isFilterRule(raw), false);
    });
  }

  it('refuses missing/non-string operands and names instead of manufacturing empty comparisons', () => {
    for (const kind of ['name', 'material', 'type', 'classification', 'attribute', 'property']) {
      const template = valid.find(rule => rule.kind === kind);
      assert.ok(template);
      for (const value of [undefined, null, 12, false, []]) {
        const raw: unknown = JSON.parse(JSON.stringify({ ...template, value }));
        assert.equal(isFilterRule(raw), false, `${kind} operand ${String(value)}`);
        assert.equal(parseFilterGroups([{ combinator: 'AND', rules: [Rule.ifcType(['IfcWall']), raw] }]), null);
      }
    }
    for (const raw of [
      { kind: 'property', propertyName: 'Code', op: 'eq', value: 'x' },
      { kind: 'quantity', setName: 'Q', op: 'gt', value: 1 },
      { kind: 'attribute', op: 'eq', value: 'x' },
      { kind: 'classification', system: 1, op: 'contains', value: 'x' },
      { kind: 'ifcType', values: [1], op: 'in' },
      { kind: 'model', op: 'in' },
      { kind: 'storey', values: [], op: 'in', refs: [{ modelId: 1, expressId: 42 }] },
      { kind: 'property', setName: '', propertyName: '', op: 'eq', value: '', propertyNameKind: 'glob' },
      { kind: 'attribute', name: 'Name', op: 'eq', value: 'x', comparison: [] },
    ]) assert.equal(isFilterRule(raw), false);
  });

  it('requires finite numeric quantity/elevation values without coercing strings', () => {
    for (const kind of ['quantity', 'elevation']) {
      const template = valid.find(rule => rule.kind === kind);
      assert.ok(template);
      for (const value of [undefined, null, '1', NaN, Infinity]) {
        assert.equal(isFilterRule({ ...template, value }), false);
      }
      assert.equal(isFilterRule({ ...template, value: -2.5 }), true);
    }
  });
});
