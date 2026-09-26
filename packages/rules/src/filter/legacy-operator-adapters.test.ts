/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { it } from 'vitest';
import { matchPropertyRule } from './filter-match.js';
import type { PropertyRule } from './filter-rules.js';
import {
  legacyLensOperatorToFilterRule, legacyListOperatorToFilterRule,
  legacyBulkOperatorToFilterRule, filterRuleToLegacyLensOperator,
  filterRuleToLegacyListOperator, filterRuleToLegacyBulkOperator,
} from './legacy-operator-adapters.js';

const template = (propertyName: string, value: string): PropertyRule => ({
  kind: 'property', setName: 'Pset_Test', propertyName, op: 'eq', value,
});

it('#5892 canonical exact comparison preserves saved Lens text behavior', () => {
  const rule: PropertyRule = {
    ...template('Text', 'red'),
    comparison: { caseMode: 'exact', numericMode: 'prefix' },
  };
  assert.equal(matchPropertyRule(rule, [{ setName: 'Pset_Test', propertyName: 'Text', value: 'Red', valueType: 'string' }]), false);
});

it('#5892 unknown saved operators stay unreadable across all adapters', () => {
  const seed = template('Text', 'red');
  for (const result of [
    legacyLensOperatorToFilterRule('new-op', seed),
    legacyListOperatorToFilterRule('new-op', seed),
    legacyBulkOperatorToFilterRule('new-op', seed),
  ]) assert.equal(result.status, 'unreadable');
  const bulk = legacyBulkOperatorToFilterRule('=', seed, 'red');
  assert.equal(bulk.status, 'readable');
  if (bulk.status === 'readable') {
    assert.equal(filterRuleToLegacyBulkOperator({ ...bulk.value, op: 'matches' }).status, 'unreadable');
  }
  assert.equal(filterRuleToLegacyLensOperator(seed).status, 'unreadable');
  assert.equal(filterRuleToLegacyListOperator(seed).status, 'unreadable');
  assert.equal(filterRuleToLegacyBulkOperator(seed).status, 'unreadable');
});
