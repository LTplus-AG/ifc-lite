/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IfcParser, extractPropertiesOnDemand, extractTypePropertiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { IfcTypeEnum, type PropertySet } from '@ifc-lite/data';
import type { PersistedV1LensOperator } from './persisted-v1-criteria.js';
import { executeList, migrateLegacyListConditions, type ConditionOperator, type ListDataProvider, type ListDefinition } from '@ifc-lite/lists';
import {
  evaluateFilterRules,
  evaluateFilterGroups,
  type PropertyRule,
  legacyLensOperatorToFilterRule,
  legacyListOperatorToFilterRule,
  filterRuleToLegacyLensOperator,
  filterRuleToLegacyListOperator,
} from '@ifc-lite/rules';

import { IFC, IDS, listCases } from './__fixtures__/legacy-operator.js';

async function fixture() {
  const bytes = new TextEncoder().encode(IFC);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const psets = new Map(IDS.map((id) => [id, extractPropertiesOnDemand(store, id)]));
  const sets = (id: number): PropertySet[] => (psets.get(id) ?? []).map((set) => ({
    name: set.name, globalId: set.globalId ?? '', properties: set.properties,
  }));
  const typeSets = (id: number): PropertySet[] => (extractTypePropertiesOnDemand(store, id)?.properties ?? [])
    .map((set) => ({ name: set.name, globalId: set.globalId ?? '', properties: set.properties }));
  const lists: ListDataProvider = {
    getEntitiesByType: (type) => type === IfcTypeEnum.IfcWall ? IDS : [],
    getEntityName: (id) => store.entities.getName(id),
    getEntityGlobalId: (id) => store.entities.getGlobalId(id),
    getEntityDescription: () => '',
    getEntityObjectType: () => '',
    getEntityTag: () => '',
    getEntityTypeName: (id) => store.entities.getTypeName(id),
    getPropertySets: sets,
    getTypePropertySets: typeSets,
    getQuantitySets: () => [],
  };
  return { store, lists };
}

// Captured from the v1 Lens matcher on the parsed IFC above before #5896
// removed that implementation. Keep these independent of the new evaluator.
const legacyLensIds: Record<PersistedV1LensOperator, number[]> = {
  equals: [30], contains: [10, 30], exists: [20, 30], ne: [20],
  gt: [20], gte: [10, 20], lt: [30], lte: [10, 30],
};

const template = (propertyName: string, value: string): PropertyRule => ({
  kind: 'property', setName: 'Pset_Test', propertyName, op: 'eq', value,
});

function canonicalIds(store: IfcDataStore, rule: PropertyRule): number[] {
  return evaluateFilterRules('m', store, [rule], 'AND', { candidateExpressIds: IDS }).map((row) => row.expressId);
}

describe('#5892 legacy operator adapters over one parsed IFC store', () => {
  it('every LensOperator preserves the recorded v1 Lens selection', async () => {
    const { store } = await fixture();
    for (const operator of Object.keys(legacyLensIds) as PersistedV1LensOperator[]) {
      const numeric = operator === 'gt' || operator === 'gte' || operator === 'lt' || operator === 'lte';
      const field = operator === 'exists' ? 'Nullable' : numeric ? 'Number' : 'Text';
      const value = numeric ? '10' : 'red';
      const converted = legacyLensOperatorToFilterRule(operator, template(field, value));
      assert.equal(converted.status, 'readable', operator);
      if (converted.status !== 'readable') continue;
      assert.deepEqual(canonicalIds(store, converted.value), legacyLensIds[operator], `Lens ${operator}`);
      assert.deepEqual(filterRuleToLegacyLensOperator(converted.value), { status: 'readable', value: operator });
    }
  });

  it('every ConditionOperator selects the same elements as the Lists engine', async () => {
    const { store, lists } = await fixture();
    for (const [operator, [field, value]] of Object.entries(listCases) as [ConditionOperator, [string, string]][]) {
      const definition: ListDefinition = {
        id: 'parity', name: 'Parity', createdAt: 0, updatedAt: 0,
        entityTypes: [], expressIdsByModel: { m: IDS }, columns: [],
        groups: [], legacyConditions: [{ source: 'property', psetName: 'Pset_Test', propertyName: field, operator, value }],
      };
      const old = executeList(definition, lists, 'm').rows.map((row) => row.entityId);
      const migrated = migrateLegacyListConditions(definition.legacyConditions ?? []);
      assert.deepEqual(migrated.unreadableConditions, [], `Lists ${operator} migrates losslessly`);
      const rule = migrated.groups[0]?.rules[0];
      assert.equal(rule?.kind, 'property', operator);
      if (!rule || rule.kind !== 'property') continue;
      const actual = evaluateFilterGroups('m', store, migrated.groups, { candidateExpressIds: IDS, limit: IDS.length })
        .map((row) => row.expressId);
      assert.deepEqual(actual, old, `Lists ${operator} after v1 migration`);
      assert.deepEqual(filterRuleToLegacyListOperator(rule), { status: 'readable', value: operator });
    }
  });

  it('uses the first of two same-named parsed IFC property sets for saved v1 Lists (#5894)', async () => {
    const { store, lists } = await fixture();
    const ownSets = lists.getPropertySets(10).filter((set) => set.name === 'Pset_Test');
    assert.equal(ownSets[0]?.properties.some((property) => property.name === 'FireRating'), false,
      'the first own set lacks FireRating, so a type merge must not put TYPE before a later own value');
    const matching = ownSets.flatMap((set) => set.properties.filter((property) => property.name === 'FireRating'));
    assert.deepEqual(matching.map((property) => property.value), ['1HR', '2HR']);

    assert.equal(lists.getTypePropertySets?.(10)?.[0]?.properties[0]?.value, 'TYPE');
    for (const [operator, value] of [
      ['equals', '1HR'], ['notEquals', '1HR'],
      ['equals', '2HR'], ['notEquals', '2HR'],
      ['equals', 'TYPE'], ['notEquals', 'TYPE'],
    ] as const) {
      const definition: ListDefinition = {
        id: 'first-pset', name: 'First pset', createdAt: 0, updatedAt: 0,
        entityTypes: [], expressIdsByModel: { m: [10] }, columns: [],
        groups: [], legacyConditions: [{ source: 'property', psetName: 'Pset_Test', propertyName: 'FireRating',
          operator, value }],
      };
      const old = executeList(definition, lists, 'm').rows.map((row) => row.entityId);
      const migrated = migrateLegacyListConditions(definition.legacyConditions ?? []);
      assert.deepEqual(migrated.unreadableConditions, []);
      const actual = evaluateFilterGroups('m', store, migrated.groups, { candidateExpressIds: [10], limit: 1 })
        .map((row) => row.expressId);
      assert.deepEqual(actual, old, `${operator} ${value} must read own sets before the type`);
    }
  });

  it('compares the scalar display of a parsed IFC list property for saved v1 Lists (#5894)', async () => {
    const { store, lists } = await fixture();
    const colors = lists.getPropertySets(10).flatMap((set) => set.properties)
      .find((property) => property.name === 'Colors');
    assert.equal(colors?.structure, 'list');
    assert.equal(colors?.value, 'Red, Blue');

    for (const [operator, value] of [
      ['equals', 'Blue'], ['contains', 'Red, Blue'],
    ] as const) {
      const definition: ListDefinition = {
        id: 'list-value', name: 'List value', createdAt: 0, updatedAt: 0,
        entityTypes: [], expressIdsByModel: { m: [10] }, columns: [],
        groups: [], legacyConditions: [{ source: 'property', psetName: 'Pset_Test', propertyName: 'Colors', operator, value }],
      };
      const old = executeList(definition, lists, 'm').rows.map((row) => row.entityId);
      const migrated = migrateLegacyListConditions(definition.legacyConditions ?? []);
      const actual = evaluateFilterGroups('m', store, migrated.groups, { candidateExpressIds: [10], limit: 1 })
        .map((row) => row.expressId);
      assert.deepEqual(actual, old, `${operator} must compare the displayed list, not an individual member`);
    }
  });

  it('preserves boolean case from the parsed store', async () => {
    const { store, lists } = await fixture();
    for (const expected of ['TRUE', 'false']) {
      const lensRule = legacyLensOperatorToFilterRule('equals', template('Flag', expected));
      const listRule = legacyListOperatorToFilterRule('equals', template('Flag', expected));
      assert.equal(lensRule.status, 'readable');
      assert.equal(listRule.status, 'readable');
      if (lensRule.status !== 'readable' || listRule.status !== 'readable') continue;
      const lensIds = expected === 'TRUE' ? [10, 30] : [20];
      const definition: ListDefinition = {
        id: 'boolean-parity', name: 'Boolean parity', createdAt: 0, updatedAt: 0,
        entityTypes: [], expressIdsByModel: { m: IDS }, columns: [],
        groups: [], legacyConditions: [{ source: 'property', psetName: 'Pset_Test', propertyName: 'Flag',
          operator: 'equals', value: expected }],
      };
      assert.deepEqual(canonicalIds(store, lensRule.value), lensIds, `Lens boolean ${expected}`);
      assert.deepEqual(canonicalIds(store, listRule.value), executeList(definition, lists, 'm').rows.map((row) => row.entityId),
        `Lists boolean ${expected}`);
    }
  });

  it('keeps null distinct from an empty string in converted numeric comparisons', async () => {
    const { store, lists } = await fixture();
    const lensRule = legacyLensOperatorToFilterRule('gte', template('Nullable', '0'));
    const listRule = legacyListOperatorToFilterRule('gte', template('Nullable', '0'));
    assert.equal(lensRule.status, 'readable');
    assert.equal(listRule.status, 'readable');
    if (lensRule.status !== 'readable' || listRule.status !== 'readable') return;
    const lensIds: number[] = []; // v1 treated null, empty string and text as non-numeric.
    const definition: ListDefinition = {
      id: 'null-parity', name: 'Null parity', createdAt: 0, updatedAt: 0,
      entityTypes: [], expressIdsByModel: { m: IDS }, columns: [],
      groups: [], legacyConditions: [{ source: 'property', psetName: 'Pset_Test', propertyName: 'Nullable', operator: 'gte', value: '0' }],
    };
    const listIds = executeList(definition, lists, 'm').rows.map((row) => row.entityId);
    assert.deepEqual(canonicalIds(store, lensRule.value), lensIds);
    assert.deepEqual(canonicalIds(store, listRule.value), listIds);
    assert.deepEqual(lensIds, []);
    assert.deepEqual(listIds, [20]);
  });

});
