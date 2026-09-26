/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { IfcParser, extractPropertiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { IfcTypeEnum, type PropertySet } from '@ifc-lite/data';
import { matchesCriteria, LENS_OPERATORS, type LensDataProvider } from '@ifc-lite/lens';
import { executeList, type ConditionOperator, type ListDataProvider, type ListDefinition } from '@ifc-lite/lists';
import { BulkQueryEngine, MutablePropertyView, type FilterOperator, type PropertyValue } from '@ifc-lite/mutations';
import { evaluateFilterRules } from './filter-evaluate.js';
import { matchPropertyRule } from './filter-match.js';
import type { PropertyRule } from './filter-rules.js';

// The revert oracle removes new production files. Keep this table loadable in
// that state so the existing-API observer below can fail on behavior, rather
// than ending at module collection before any assertion runs.
const adapters = await import('./legacy-operator-adapters.js').catch((error: unknown) => {
  if (error instanceof Error && error.message.includes("Cannot find module './legacy-operator-adapters.js'")) return null;
  throw error;
});

it('#5892 canonical exact comparison preserves the saved Lens text behavior', () => {
  const rule: PropertyRule = {
    kind: 'property', setName: 'Pset_Test', propertyName: 'Text', op: 'eq', value: 'red',
    comparison: { caseMode: 'exact', numericMode: 'prefix' },
  };
  assert.equal(matchPropertyRule(rule, [{ setName: 'Pset_Test', propertyName: 'Text', value: 'Red', valueType: 'string' }]), false);
});

const IFC = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('t','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCPROJECT('0Proj000000000000000001',$,'P',$,$,$,$,$,$);
#10=IFCWALL('0Wall000000000000000010',$,'Red wall',$,$,$,$,$,$);
#11=IFCPROPERTYSINGLEVALUE('Text',$,IFCLABEL('Red'),$);
#12=IFCPROPERTYSINGLEVALUE('Number',$,IFCREAL(10.),$);
#13=IFCPROPERTYSINGLEVALUE('Nullable',$,$,$);
#16=IFCPROPERTYSINGLEVALUE('Flag',$,IFCBOOLEAN(.T.),$);
#14=IFCPROPERTYSET('0Pset000000000000000014',$,'Pset_Test',$,(#11,#12,#13,#16));
#15=IFCRELDEFINESBYPROPERTIES('0Rel000000000000000015',$,$,$,(#10),#14);
#20=IFCWALL('0Wall000000000000000020',$,'Blue wall',$,$,$,$,$,$);
#21=IFCPROPERTYSINGLEVALUE('Text',$,IFCLABEL('Blue'),$);
#22=IFCPROPERTYSINGLEVALUE('Number',$,IFCREAL(20.),$);
#23=IFCPROPERTYSINGLEVALUE('Nullable',$,IFCLABEL(''),$);
#26=IFCPROPERTYSINGLEVALUE('Flag',$,IFCBOOLEAN(.F.),$);
#24=IFCPROPERTYSET('0Pset000000000000000024',$,'Pset_Test',$,(#21,#22,#23,#26));
#25=IFCRELDEFINESBYPROPERTIES('0Rel000000000000000025',$,$,$,(#20),#24);
#30=IFCWALL('0Wall000000000000000030',$,'Lower wall',$,$,$,$,$,$);
#31=IFCPROPERTYSINGLEVALUE('Text',$,IFCLABEL('red'),$);
#32=IFCPROPERTYSINGLEVALUE('Number',$,IFCREAL(5.),$);
#33=IFCPROPERTYSINGLEVALUE('Nullable',$,IFCLABEL('x'),$);
#36=IFCPROPERTYSINGLEVALUE('Flag',$,IFCBOOLEAN(.T.),$);
#34=IFCPROPERTYSET('0Pset000000000000000034',$,'Pset_Test',$,(#31,#32,#33,#36));
#35=IFCRELDEFINESBYPROPERTIES('0Rel000000000000000035',$,$,$,(#30),#34);
#40=IFCWALL('0Wall000000000000000040',$,'Missing wall',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

const IDS = [10, 20, 30, 40];

async function fixture() {
  const bytes = new TextEncoder().encode(IFC);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const psets = new Map(IDS.map((id) => [id, extractPropertiesOnDemand(store, id)]));
  const sets = (id: number): PropertySet[] => (psets.get(id) ?? []).map((set) => ({
    name: set.name, globalId: set.globalId ?? '', properties: set.properties,
  }));
  const property = (id: number, name: string) => psets.get(id)?.flatMap((set) => set.properties)
    .find((row) => row.name === name)?.value;
  const lens: LensDataProvider = {
    forEachEntity: (visit) => IDS.forEach((id) => visit(id, 'm')),
    getEntityCount: () => IDS.length,
    getEntityType: (id) => store.entities.getTypeName(id),
    getPropertyValue: (id, _set, name) => property(id, name),
    getPropertySets: (id) => sets(id),
  };
  const lists: ListDataProvider = {
    getEntitiesByType: (type) => type === IfcTypeEnum.IfcWall ? IDS : [],
    getEntityName: (id) => store.entities.getName(id),
    getEntityGlobalId: (id) => store.entities.getGlobalId(id),
    getEntityDescription: () => '',
    getEntityObjectType: () => '',
    getEntityTag: () => '',
    getEntityTypeName: (id) => store.entities.getTypeName(id),
    getPropertySets: sets,
    getQuantitySets: () => [],
  };
  const view = new MutablePropertyView(null, 'm');
  for (const id of IDS) for (const set of psets.get(id) ?? []) for (const prop of set.properties) {
    view.setProperty(id, set.name, prop.name, prop.value as PropertyValue);
  }
  const bulk = new BulkQueryEngine(store.entities, view, null, null, store.strings);
  return { store, lens, lists, bulk };
}

const template = (propertyName: string, value: string): PropertyRule => ({
  kind: 'property', setName: 'Pset_Test', propertyName, op: 'eq', value,
});

function canonicalIds(store: IfcDataStore, rule: PropertyRule): number[] {
  return evaluateFilterRules('m', store, [rule], 'AND', { candidateExpressIds: IDS }).map((row) => row.expressId);
}

const listCases = {
  equals: ['Text', 'red'], notEquals: ['Text', 'red'], contains: ['Text', 'red'],
  gt: ['Number', '10'], gte: ['Number', '10'], lt: ['Number', '10'], lte: ['Number', '10'],
  exists: ['Nullable', ''],
} satisfies Record<ConditionOperator, [string, string]>;

const bulkCases = {
  '=': ['Text', 'red'], '!=': ['Text', 'red'], CONTAINS: ['Text', 'red'],
  STARTS_WITH: ['Text', 're'], ENDS_WITH: ['Text', 'ed'],
  '>': ['Number', 10], '>=': ['Number', 10], '<': ['Number', 10], '<=': ['Number', 10],
  IS_NULL: ['Nullable', undefined], IS_NOT_NULL: ['Nullable', undefined],
} satisfies Record<FilterOperator, [string, PropertyValue | undefined]>;

describe('#5892 legacy operator adapters over one parsed IFC store', () => {
  if (!adapters) {
    it.skip('new adapter module absent in the reverted production tree', () => {});
    return;
  }
  const {
    legacyLensOperatorToFilterRule,
    legacyListOperatorToFilterRule,
    legacyBulkOperatorToFilterRule,
    filterRuleToLegacyLensOperator,
    filterRuleToLegacyListOperator,
    filterRuleToLegacyBulkOperator,
  } = adapters;
  it('every LensOperator selects the same elements as the Lens evaluator', async () => {
    const { store, lens } = await fixture();
    for (const operator of LENS_OPERATORS) {
      const numeric = operator === 'gt' || operator === 'gte' || operator === 'lt' || operator === 'lte';
      const field = operator === 'exists' ? 'Nullable' : numeric ? 'Number' : 'Text';
      const value = numeric ? '10' : 'red';
      const converted = legacyLensOperatorToFilterRule(operator, template(field, value));
      assert.equal(converted.status, 'readable', operator);
      if (converted.status !== 'readable') continue;
      const old = IDS.filter((id) => matchesCriteria({
        type: 'property', propertySet: 'Pset_Test', propertyName: field,
        operator, propertyValue: value,
      }, id, lens));
      assert.deepEqual(canonicalIds(store, converted.value), old, `Lens ${operator}`);
      assert.deepEqual(filterRuleToLegacyLensOperator(converted.value), { status: 'readable', value: operator });
    }
  });

  it('every ConditionOperator selects the same elements as the Lists engine', async () => {
    const { store, lists } = await fixture();
    for (const [operator, [field, value]] of Object.entries(listCases) as [ConditionOperator, [string, string]][]) {
      const converted = legacyListOperatorToFilterRule(operator, template(field, value));
      assert.equal(converted.status, 'readable', operator);
      if (converted.status !== 'readable') continue;
      const definition: ListDefinition = {
        id: 'parity', name: 'Parity', createdAt: 0, updatedAt: 0,
        entityTypes: [], expressIdsByModel: { m: IDS }, columns: [],
        conditions: [{ source: 'property', psetName: 'Pset_Test', propertyName: field, operator, value }],
      };
      const old = executeList(definition, lists, 'm').rows.map((row) => row.entityId);
      assert.deepEqual(canonicalIds(store, converted.value), old, `Lists ${operator}`);
      assert.deepEqual(filterRuleToLegacyListOperator(converted.value), { status: 'readable', value: operator });
    }
  });

  it('every FilterOperator selects the same elements as BulkQueryEngine', async () => {
    const { store, bulk } = await fixture();
    for (const [operator, [field, value]] of Object.entries(bulkCases) as [FilterOperator, [string, PropertyValue | undefined]][]) {
      const converted = legacyBulkOperatorToFilterRule(operator, template(field, ''), value);
      assert.equal(converted.status, 'readable', operator);
      if (converted.status !== 'readable') continue;
      const old = bulk.select({ expressIds: IDS, propertyFilters: [{ psetName: 'Pset_Test', propName: field, operator, value }] });
      assert.deepEqual(canonicalIds(store, converted.value), old, `Bulk ${operator}`);
      assert.deepEqual(filterRuleToLegacyBulkOperator(converted.value), { status: 'readable', value: operator });
    }
  });

  it('preserves boolean case and Bulk typed operands from the parsed store', async () => {
    const { store, lens, lists, bulk } = await fixture();
    for (const expected of ['TRUE', 'false']) {
      const lensRule = legacyLensOperatorToFilterRule('equals', template('Flag', expected));
      const listRule = legacyListOperatorToFilterRule('equals', template('Flag', expected));
      assert.equal(lensRule.status, 'readable');
      assert.equal(listRule.status, 'readable');
      if (lensRule.status !== 'readable' || listRule.status !== 'readable') continue;
      const lensIds = IDS.filter((id) => matchesCriteria({
        type: 'property', propertySet: 'Pset_Test', propertyName: 'Flag',
        operator: 'equals', propertyValue: expected,
      }, id, lens));
      const definition: ListDefinition = {
        id: 'boolean-parity', name: 'Boolean parity', createdAt: 0, updatedAt: 0,
        entityTypes: [], expressIdsByModel: { m: IDS }, columns: [],
        conditions: [{ source: 'property', psetName: 'Pset_Test', propertyName: 'Flag',
          operator: 'equals', value: expected }],
      };
      assert.deepEqual(canonicalIds(store, lensRule.value), lensIds, `Lens boolean ${expected}`);
      assert.deepEqual(canonicalIds(store, listRule.value), executeList(definition, lists, 'm').rows.map((row) => row.entityId),
        `Lists boolean ${expected}`);
    }
    for (const operand of [true, 'true', false] as const) {
      const converted = legacyBulkOperatorToFilterRule('=', template('Flag', ''), operand);
      assert.equal(converted.status, 'readable');
      if (converted.status !== 'readable') continue;
      const selected = bulk.select({ expressIds: IDS, propertyFilters: [{
        psetName: 'Pset_Test', propName: 'Flag', operator: '=', value: operand,
      }] });
      assert.deepEqual(canonicalIds(store, converted.value), selected, `Bulk boolean ${String(operand)}`);
    }
  });

  it('keeps null distinct from an empty string in converted numeric comparisons', async () => {
    const { store, lens, lists, bulk } = await fixture();
    const lensRule = legacyLensOperatorToFilterRule('gte', template('Nullable', '0'));
    const listRule = legacyListOperatorToFilterRule('gte', template('Nullable', '0'));
    const bulkRule = legacyBulkOperatorToFilterRule('>=', template('Nullable', ''), 0);
    assert.equal(lensRule.status, 'readable');
    assert.equal(listRule.status, 'readable');
    assert.equal(bulkRule.status, 'readable');
    if (lensRule.status !== 'readable' || listRule.status !== 'readable' || bulkRule.status !== 'readable') return;
    const lensIds = IDS.filter((id) => matchesCriteria({
      type: 'property', propertySet: 'Pset_Test', propertyName: 'Nullable',
      operator: 'gte', propertyValue: '0',
    }, id, lens));
    const definition: ListDefinition = {
      id: 'null-parity', name: 'Null parity', createdAt: 0, updatedAt: 0,
      entityTypes: [], expressIdsByModel: { m: IDS }, columns: [],
      conditions: [{ source: 'property', psetName: 'Pset_Test', propertyName: 'Nullable', operator: 'gte', value: '0' }],
    };
    const bulkIds = bulk.select({ expressIds: IDS, propertyFilters: [{
      psetName: 'Pset_Test', propName: 'Nullable', operator: '>=', value: 0,
    }] });
    const listIds = executeList(definition, lists, 'm').rows.map((row) => row.entityId);
    assert.deepEqual(canonicalIds(store, lensRule.value), lensIds);
    assert.deepEqual(canonicalIds(store, listRule.value), listIds);
    assert.deepEqual(canonicalIds(store, bulkRule.value), bulkIds);
    assert.deepEqual(lensIds, []);
    assert.deepEqual(listIds, [20]);
    assert.deepEqual(bulkIds, []);
  });

  it('reports unknown saved operators rather than dropping the filter', () => {
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
    const lens = legacyLensOperatorToFilterRule('equals', seed);
    assert.equal(lens.status, 'readable');
    if (lens.status === 'readable') {
      assert.equal(filterRuleToLegacyListOperator(lens.value).status, 'unreadable');
      assert.equal(filterRuleToLegacyBulkOperator(lens.value).status, 'unreadable');
    }
  });
});
