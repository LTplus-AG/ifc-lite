/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { isFilterRule } from '@ifc-lite/rules';
import { migrateLegacyListConditions } from './legacy-condition-migration.js';
import type { ConditionOperator, PropertyCondition } from './types.js';

const property = (operator: ConditionOperator): PropertyCondition => ({
  source: 'property', psetName: 'Pset_WallCommon', propertyName: 'FireRating',
  operator, value: '2HR',
});

describe('v1 List condition migration (#5894)', () => {
  it('preserves every persisted operator in one AND group for the new Rules evaluator', () => {
    const conditions: PropertyCondition[] = [
      'equals', 'notEquals', 'contains', 'exists', 'gt', 'gte', 'lt', 'lte',
    ].map((operator) => property(operator as ConditionOperator));
    const before = JSON.stringify(conditions);
    const result = migrateLegacyListConditions(conditions);

    expect(result.unreadableConditions).toEqual([]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].combinator).toBe('AND');
    expect(result.groups[0].rules.map((rule) => rule.kind === 'property' ? rule.op : null)).toEqual([
      'eq', 'ne', 'contains', 'isNonEmpty', 'gt', 'gte', 'lt', 'lte',
    ]);
    expect(result.groups[0].rules.every(isFilterRule)).toBe(true);
    expect(result.groups[0].rules.every((rule) => rule.kind === 'property'
      && rule.nameCaseMode === 'exact' && rule.legacyListFirst === true)).toBe(true);
    expect(JSON.stringify(conditions)).toBe(before);
  });

  it('retains every non-lossless condition as an explicit unreadable row', () => {
    const unknown = { ...property('equals'), operator: 'new-op' as ConditionOperator };
    const regex = { ...property('equals'), psetName: '/Pset_.*/i' };
    const inherited = { ...property('equals'), inherit: 'aggregation' as const };
    const attribute: PropertyCondition = { source: 'attribute', propertyName: 'Name', operator: 'contains', value: 'Wall' };
    const zone: PropertyCondition = { source: 'zone', psetName: 'zone-set', propertyName: 'Zone', operator: 'equals', value: 'West' };
    const result = migrateLegacyListConditions([property('equals'), unknown, regex, inherited, attribute, zone]);

    expect(result.groups[0].rules).toHaveLength(1);
    expect(result.unreadableConditions).toEqual([
      { condition: unknown, reason: 'operator' },
      { condition: regex, reason: 'name-pattern' },
      { condition: inherited, reason: 'inherit' },
      { condition: attribute, reason: 'unsupported-attribute' },
      { condition: zone, reason: 'unsupported-source' },
    ]);
  });
});
