/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { isFilterRule } from '@ifc-lite/rules';
import { migrateLegacyListConditions } from './legacy-condition-migration.js';
import type { ConditionOperator, ListDefinition, PropertyCondition } from './types.js';

const property = (operator: ConditionOperator): PropertyCondition => ({
  source: 'property', psetName: 'Pset_WallCommon', propertyName: 'FireRating',
  operator, value: '2HR',
});

describe('v1 List condition migration (#5894)', () => {
  it('preserves malformed JSON members as explicit unreadable rows without throwing', () => {
    const result = migrateLegacyListConditions([null, 42, { source: 'property' }, property('equals')]);
    expect(result.groups[0].rules).toHaveLength(1);
    expect(result.unreadableConditions).toEqual([
      { condition: null, reason: 'invalid-condition' },
      { condition: 42, reason: 'invalid-condition' },
      { condition: { source: 'property' }, reason: 'invalid-condition' },
    ]);
  });

  it('normalizes persisted v1 definitions without saving the removed conditions field', async () => {
    // Resolve the new export at assertion time so reverting #5894 leaves a
    // failing behavior assertion rather than an ESM module-load failure.
    const migrate = (await import('./index.js')).migrateLegacyListDefinition;
    expect(typeof migrate).toBe('function');
    const old: Omit<ListDefinition, 'groups'> & { conditions: PropertyCondition[] } = {
      id: 'old', name: 'Old', createdAt: 1, updatedAt: 1, entityTypes: [], columns: [],
      conditions: [property('contains'), { source: 'attribute', propertyName: 'Name', operator: 'contains', value: 'Wall' }],
    };
    const normalized = migrate(old);
    expect(normalized.groups[0].rules).toHaveLength(1);
    expect(normalized.unreadableConditions?.[0].condition).toEqual(old.conditions[1]);
    expect('conditions' in normalized).toBe(false);
    expect(migrate(normalized)).toEqual(normalized);
  });

  it('rejects malformed whole definitions and malformed Rules groups before execution (#5894)', async () => {
    const migrateLegacyListDefinition = (await import('./index.js')).migrateLegacyListDefinition;
    const valid = { id: 'walls', name: 'Walls', createdAt: 1, updatedAt: 1,
      entityTypes: [], columns: [], groups: [] };
    for (const malformed of [[], { id: 'x' }, { ...valid, id: '' }, { ...valid, columns: {} },
      { ...valid, groups: [null] }, { ...valid, groups: [{ combinator: 'AND', rules: [null] }] }]) {
      expect(() => migrateLegacyListDefinition(malformed)).toThrow('Invalid saved list definition');
    }
    expect(migrateLegacyListDefinition(valid)).toEqual(valid);
  });

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
