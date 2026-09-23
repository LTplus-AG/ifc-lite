/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5185: `queryEntities()` and `entitiesMatchingActiveFilter()` ran the
 * `entityIndex.byType` loop straight off the parsed store, with no
 * `isDeleted` tombstone check and no fold of overlay-created entities — the
 * CLI (`packages/cli/src/headless-backend.ts`'s `isDeleted`/`foldNewEntities`)
 * and MCP (`packages/mcp/src/backend-query.ts`'s `pending?.deleted`/
 * `pending?.createdAll`) both apply both halves.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { IfcParser } from '@ifc-lite/parser';
import { createQueryAdapter } from './query-adapter.js';
import type { StoreApi } from './types.js';
import { Rule } from '@ifc-lite/rules';

function guid(mnemonic: string): string {
  return (mnemonic + '0'.repeat(22)).slice(0, 22);
}

// Two pre-existing walls with DIFFERENT names/GlobalIds (Wall A #3, Wall B
// #4) -- deleting one and keeping the other is only a valid test if the two
// are not interchangeable, which distinct names/ids guarantee.
const MODEL = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('m','2026',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCPROJECT('${guid('PROJ')}',$,'Project',$,$,$,$,$,$);
#3=IFCWALL('${guid('WALA')}',$,'Wall A',$,$,$,$,$,$);
#4=IFCWALL('${guid('WALB')}',$,'Wall B',$,$,$,$,$,$);
ENDSEC;END-ISO-10303-21;`;

async function harness() {
  const dataStore = await new IfcParser().parseColumnar(new TextEncoder().encode(MODEL).buffer as ArrayBuffer);
  const view = new MutablePropertyView(dataStore.properties, 'm');
  view.setExpressIdWatermark(4);
  const state = {
    models: new Map([['m', { id: 'm', ifcDataStore: dataStore }]]),
    activeModelId: 'm',
    ifcDataStore: dataStore,
    mutationViews: new Map([['m', view]]),
    getMutationView: (id: string) => (id === 'm' ? view : null),
    searchFilter: null as unknown,
    modelTagAssignments: new Map(),
  };
  const store = { getState: () => state, subscribe: () => () => {} } as unknown as StoreApi;
  return { adapter: createQueryAdapter(store), view };
}

test('query.entities() omits an entity deleted this session (#5185)', async () => {
  const { adapter, view } = await harness();

  const before = adapter.entities({ types: ['IfcWall'] });
  assert.deepEqual(before.map((e) => e.name).sort(), ['Wall A', 'Wall B'], 'sanity: both walls present before delete');

  view.deleteEntity(4);
  const after = adapter.entities({ types: ['IfcWall'] });
  assert.deepEqual(after.map((e) => e.name), ['Wall A'], 'the tombstoned wall must not be enumerated');
});

test('query.entities() includes an entity created this session (#5185)', async () => {
  const { adapter, view } = await harness();

  const before = adapter.entities({ types: ['IfcWall'] });
  assert.deepEqual(before.map((e) => e.name).sort(), ['Wall A', 'Wall B'], 'sanity: only the two parsed walls exist so far');

  view.createEntity('IfcWall', [`'${guid('WALC')}'`, null, `'Wall C'`]);
  const after = adapter.entities({ types: ['IfcWall'] });
  assert.deepEqual(after.map((e) => e.name).sort(), ['Wall A', 'Wall B', 'Wall C'], 'the overlay-created wall must be enumerated before export');
});

test('query.entities() with no type filter still folds overlay creations and tombstones (#5185)', async () => {
  const { adapter, view } = await harness();

  view.deleteEntity(4);
  view.createEntity('IfcWall', [`'${guid('WALC')}'`, null, `'Wall C'`]);
  const results = adapter.entities({});
  // No `types` filter falls back to `isProductType` (skip relationships,
  // property defs) -- IfcProject is itself a product-tree entity, so it is
  // expected here alongside the surviving/created walls.
  assert.deepEqual(results.map((e) => e.name).sort(), ['Project', 'Wall A', 'Wall C']);
});

test('query.entities() lists a retyped entity under its new class only (#5249)', async () => {
  const { adapter, view } = await harness();

  view.setEntityType(4, 'IfcColumn', null, 'IfcWall');
  assert.deepEqual(adapter.entities({ types: ['IfcWall'] }).map((e) => e.name), ['Wall A'],
    'a wall retyped to a column is no longer a wall');
  const columns = adapter.entities({ types: ['IfcColumn'] });
  assert.deepEqual(columns.map((e) => [e.name, e.type]), [['Wall B', 'IfcColumn']],
    'it is listed as a column, with its effective class');
});

test('query.entities() applies deletion, creation and retype in one enumeration (#5249)', async () => {
  const { adapter, view } = await harness();

  view.deleteEntity(3);
  view.setEntityType(4, 'IfcColumn', null, 'IfcWall');
  view.createEntity('IfcWall', [`'${guid('WALC')}'`, null, `'Wall C'`]);
  assert.deepEqual(adapter.entities({ types: ['IfcWall'] }).map((e) => e.name), ['Wall C']);
  assert.deepEqual(adapter.entities({ types: ['IfcColumn'] }).map((e) => e.name), ['Wall B']);
});

test('query.entities() with a type no entity has returns nothing, not every entity (#5249)', async () => {
  const { adapter } = await harness();
  assert.deepEqual(adapter.entities({ types: ['IfcNoSuchType'] }), []);
});

test('entitiesMatchingActiveFilter() omits an entity deleted this session (#5185)', async () => {
  const dataStore = await new IfcParser().parseColumnar(new TextEncoder().encode(MODEL).buffer as ArrayBuffer);
  const view = new MutablePropertyView(dataStore.properties, 'm');
  view.setExpressIdWatermark(4);
  const state = {
    models: new Map([['m', { id: 'm', ifcDataStore: dataStore }]]),
    activeModelId: 'm',
    ifcDataStore: dataStore,
    mutationViews: new Map([['m', view]]),
    getMutationView: (id: string) => (id === 'm' ? view : null),
    // An "active filter" that matches every IfcWall -- the modal's own chip
    // rule shape (`Rule.ifcType`), so this exercises the SAME evaluator the
    // Search modal's Filter tab uses, not a synthetic stand-in for it.
    searchFilter: { groups: [{ rules: [Rule.ifcType(['IFCWALL'], 'in')], combinator: 'AND' as const }] },
    modelTagAssignments: new Map(),
    modelTags: new Map(),
  };
  const store = { getState: () => state, subscribe: () => () => {} } as unknown as StoreApi;
  const adapter = createQueryAdapter(store);

  const before = adapter.entitiesMatchingActiveFilter();
  assert.deepEqual(before?.map((e) => e.name).sort(), ['Wall A', 'Wall B'], 'sanity: both walls match the active filter before delete');

  view.deleteEntity(4);
  const after = adapter.entitiesMatchingActiveFilter();
  assert.deepEqual(after?.map((e) => e.name), ['Wall A'], 'the tombstoned wall must not be reported as a filter match');
});
