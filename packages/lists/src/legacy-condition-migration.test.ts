/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { Rule, isFilterRule } from '@ifc-lite/rules';
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
    expect(normalized.groups[0].rules.map((rule) => rule.kind)).toEqual(['property', 'listCondition']);
    expect(normalized.groups[0].rules[1]).toEqual({ kind: 'listCondition', ...old.conditions[1] });
    expect(normalized.unreadableConditions).toBeUndefined();
    expect('conditions' in normalized).toBe(false);
    expect(migrate(normalized)).toEqual(normalized);
  });

  it('rejects malformed whole definitions before execution (#5894)', async () => {
    const migrateLegacyListDefinition = (await import('./index.js')).migrateLegacyListDefinition;
    const valid = { id: 'walls', name: 'Walls', createdAt: 1, updatedAt: 1,
      entityTypes: [], columns: [], groups: [] };
    for (const malformed of [[], { id: 'x' }, { ...valid, id: '' }, { ...valid, columns: {} },
      { ...valid, groups: {} },
      { ...valid, expressIdsByModel: { m1: 'bad' } },
      { ...valid, expressIdsByModel: { m1: [1, 'bad'] } },
      { ...valid, grouping: { columnId: 'name' } },
      { ...valid, grouping: { columnId: 'name', sumColumnIds: [42] } }]) {
      expect(() => migrateLegacyListDefinition(malformed)).toThrow('Invalid saved list definition');
    }
    expect(migrateLegacyListDefinition(valid)).toEqual(valid);
  });

  it('keeps a malformed or unknown rule visible instead of dropping the whole list (#6190)', async () => {
    const migrate = (await import('./index.js')).migrateLegacyListDefinition;
    const name = Rule.name('eq', 'A');
    const future = { kind: 'futureKind', op: 'eq', value: 'x' };
    const broken = { kind: 'listCondition', source: 'zone', propertyName: 'Zone', operator: 'equals', value: null };
    const migrated = migrate({ id: 'g', name: 'G', createdAt: 1, updatedAt: 1, entityTypes: [], columns: [],
      groups: [{ combinator: 'AND', rules: [name, future] }, null, { combinator: 'OR', rules: [broken] }] });
    expect(migrated.groups).toEqual([{ combinator: 'AND', rules: [name] }, { combinator: 'OR', rules: [] }]);
    expect(migrated.unreadableConditions).toEqual([
      { condition: future, reason: 'invalid-condition' },
      { condition: null, reason: 'invalid-condition' },
      { condition: broken, reason: 'invalid-condition' },
    ]);
    expect(migrate(migrated)).toEqual(migrated);
  });

  it('ANDs saved flat conditions and provider-only rows into every group, losslessly (#6190)', async () => {
    const migrate = (await import('./index.js')).migrateLegacyListDefinition;
    const attribute: PropertyCondition = { source: 'attribute', propertyName: 'Name', operator: 'equals', value: 'A' };
    const zone: PropertyCondition = { source: 'zone', psetName: 'zs', propertyName: 'Straddles', operator: 'equals', value: 'true' };
    const a = Rule.name('eq', 'A');
    const b = Rule.name('eq', 'B');
    const c = Rule.name('eq', 'C');
    const old = { id: 'mixed', name: 'Mixed', createdAt: 1, updatedAt: 1, entityTypes: [], columns: [],
      groups: [{ combinator: 'OR', rules: [a, b] }, { combinator: 'AND', rules: [c] }, { combinator: 'AND', rules: [] }],
      unreadableConditions: [
        { condition: attribute, reason: 'unsupported-attribute' },
        { condition: null, reason: 'invalid-condition' },
      ],
      conditions: [zone, null],
    };
    const migrated = migrate(old);
    const carried = [Rule.listCondition(attribute), Rule.listCondition(zone)];
    // (A OR B) AND x  +  C AND x  ==  (A AND x) OR (B AND x) OR (C AND x); the empty group matched nothing.
    expect(migrated.groups).toEqual([
      { combinator: 'AND', rules: [a, ...carried] },
      { combinator: 'AND', rules: [b, ...carried] },
      { combinator: 'AND', rules: [c, ...carried] },
    ]);
    expect(migrated.unreadableConditions).toEqual([
      { condition: null, reason: 'invalid-condition' },
      { condition: null, reason: 'invalid-condition' },
    ]);
    expect('conditions' in migrated).toBe(false);
    expect(migrate(migrated)).toEqual(migrated);

    const v1 = migrate({ ...old, groups: undefined, unreadableConditions: undefined });
    expect(v1.groups).toEqual([{ combinator: 'AND', rules: [Rule.listCondition(zone)] }]);
    expect(v1.unreadableConditions).toEqual([{ condition: null, reason: 'invalid-condition' }]);
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

  it('carries every other Lists predicate as a listCondition rule; only unevaluable data stays unreadable (#6190)', () => {
    const unknown = { ...property('equals'), operator: 'new-op' as ConditionOperator };
    const future = { ...property('equals'), source: 'future' as PropertyCondition['source'] };
    const regex = { ...property('equals'), psetName: '/Pset_.*/i' };
    const inherited = { ...property('equals'), inherit: 'aggregation' as const };
    const attribute: PropertyCondition = { source: 'attribute', propertyName: 'GlobalId', operator: 'contains', value: 'Wall' };
    const zone: PropertyCondition = { source: 'zone', psetName: 'zone-set', propertyName: 'Volume (mesh)', operator: 'gt', value: 2 };
    const spatial: PropertyCondition = { source: 'spatial', propertyName: 'Building', operator: 'equals', value: 'B1' };
    const presence: PropertyCondition = { source: 'quantity', psetName: 'Qto', propertyName: 'NetVolume', operator: 'exists', value: '' };
    const result = migrateLegacyListConditions([property('equals'), unknown, future, regex, inherited, attribute, zone, spatial, presence]);

    expect(result.groups).toEqual([{ combinator: 'AND', rules: [
      result.groups[0].rules[0],
      ...[regex, inherited, attribute, zone, spatial, presence].map((condition) => ({ kind: 'listCondition', ...condition })),
    ] }]);
    expect(result.groups[0].rules[0].kind).toBe('property');
    expect(result.groups[0].rules.every(isFilterRule)).toBe(true);
    expect(result.unreadableConditions).toEqual([
      { condition: unknown, reason: 'operator' },
      { condition: future, reason: 'unsupported-source' },
    ]);
  });
});
