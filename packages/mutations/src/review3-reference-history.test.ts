// SPDX-License-Identifier: MPL-2.0
import { expect, it } from 'vitest';
import { NewEntityMap } from './new-entity-map.js';
import { MutablePropertyView } from './mutable-property-view.js';

it.each(['map', 'view'])('#10420 accessor-backed references refresh a warmed 33-row projection through %s', api => {
  const map = new NewEntityMap(), view = new MutablePropertyView(null, 'accessor-index');
  const insert = (row: Parameters<NewEntityMap['set']>[1]) => api === 'map' ? map.set(row.expressId, row) : view.restoreNewEntity(row);
  for (let i = 1; i <= 32; i++) insert({ expressId: i, type: 'IfcRelVoidsElement', attributes: [null, null, null, null, '#999', '#50'] });
  let attributes = [null, null, null, null, '#40', '#50'];
  insert({ expressId: 33, type: 'IfcRelVoidsElement', get attributes() { return attributes; } });
  const ids = (target: number) => api === 'map' ? [...map.referenceSlotIds('IFCRELVOIDSELEMENT', 4, target)]
    : view.getNewEntityReferenceSlotIds('IFCRELVOIDSELEMENT', 4, target);
  const refs = (target: number) => [...(api === 'map' ? map.referencing(target) : view.getNewEntitiesReferencing(target))].map(row => row.expressId);
  expect(ids(40)).toEqual([33]);
  attributes = [null, null, null, null, '#60', '#50'];
  expect.soft(refs(40)).toEqual([]);
  expect.soft(refs(60)).toEqual([33]);
  expect.soft(ids(40)).toEqual([]);
  expect.soft(ids(60)).toEqual([33]);
});

it('#10420 retained published drafts enumerate inherited X and appended A once', () => {
  const view = new MutablePropertyView(null, 'retained-history');
  const x = view.createEntity('IfcCartesianPoint', [[0, 0, 0]]).expressId;
  const draft = view.runAtomic(draft => { draft.createEntity('IfcCartesianPoint', [[1, 0, 0]]); return draft; });
  expect(draft.getMutations().map(row => row.entityId)).toEqual([x, x + 1]);
  expect(view.getMutations().map(row => row.entityId)).toEqual([x, x + 1]);
});
