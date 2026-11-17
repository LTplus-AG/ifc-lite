// SPDX-License-Identifier: MPL-2.0
/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it, vi } from 'vitest';
import { MutablePropertyView } from './mutable-property-view.js';
import { recordCompoundMutation, undoRecordedMutationOperations } from './compound-recording.js';
import { NewEntityMap } from './new-entity-map.js';

for (const snapshotBetween of [false, true]) it(`#9411 compound undo restores creation order (snapshotBetween=${snapshotBetween})`, () => {
  const view = new MutablePropertyView(null, 'ordered');
  const ids = [1, 2, 3, 4].map(i => view.createEntity('IfcCartesianPoint', [[i, 0, 0]]).expressId);
  recordCompoundMutation(view, draft => { draft.deleteEntity(ids[1]); draft.deleteEntity(ids[0]); });
  if (snapshotBetween) view.prepareAtomic(() => {}).commit();
  undoRecordedMutationOperations(view, 1, () => { throw new Error('Expected compound inverse'); });
  expect(view.getNewEntities().map(row => row.expressId)).toEqual(ids);
  expect([...view.getNewEntitiesOfType('IfcCartesianPoint')].map(row => row.expressId)).toEqual(ids);
});

it('#9411 successive compound undos retain stable creation positions inside a sparse draft', () => {
  const view = new MutablePropertyView(null, 'ordered-nested');
  const ids = [1, 2, 3, 4].map(i => view.createEntity('IfcCartesianPoint', [[i, 0, 0]]).expressId);
  view.runAtomic(outer => {
    recordCompoundMutation(outer, draft => draft.deleteEntity(ids[1]));
    recordCompoundMutation(outer, draft => draft.deleteEntity(ids[2]));
    undoRecordedMutationOperations(outer, 2, () => { throw new Error('Expected compound inverse'); });
    expect(outer.getNewEntities().map(row => row.expressId)).toEqual(ids);
    expect([...outer.getNewEntitiesOfType('IfcCartesianPoint')].map(row => row.expressId)).toEqual(ids);
  });
  expect(view.getNewEntities().map(row => row.expressId)).toEqual(ids);
});

it('#9411 restores records first created in the outer draft before their compound deletion', () => {
  const view = new MutablePropertyView(null, 'created-in-draft');
  view.runAtomic(outer => {
    const ids = [1, 2, 3].map(i => outer.createEntity('IfcCartesianPoint', [[i, 0, 0]]).expressId);
    recordCompoundMutation(outer, draft => { draft.deleteEntity(ids[1]); draft.deleteEntity(ids[0]); });
    undoRecordedMutationOperations(outer, 1, () => { throw new Error('Expected compound inverse'); });
    expect(outer.getNewEntities().map(row => row.expressId)).toEqual(ids);
  });
  expect(view.getNewEntities().map(row => row.expressId)).toEqual([1, 2, 3]);
});

it('#9411 captures deletion order without enumerating the authored prefix', () => {
  const view = new MutablePropertyView(null, 'order-complexity');
  for (let i = 0; i < 2000; i++) view.createEntity('IfcCartesianPoint', [[i, 0, 0]]);
  let visits = 0;
  const keys = NewEntityMap.prototype.keys;
  const spy = vi.spyOn(NewEntityMap.prototype, 'keys').mockImplementation(function* (this: NewEntityMap) {
    for (const key of keys.call(this)) { visits++; yield key; }
    return undefined;
  });
  try {
    recordCompoundMutation(view, draft => draft.deleteEntity(1000));
    expect(visits).toBe(0);
  } finally { spy.mockRestore(); }
  undoRecordedMutationOperations(view, 1, () => { throw new Error('Expected compound inverse'); });
  expect(view.getNewEntities().map(row => row.expressId)).toEqual(Array.from({ length: 2000 }, (_, i) => i + 1));
});

it('#9411 reorders undo indices without rereading unrelated geometry payloads', () => {
  const view = new MutablePropertyView(null, 'order-payloads');
  const first = view.createEntity('IfcCartesianPoint', [[1, 0, 0]]).expressId;
  const coordinates = [2, 0, 0], second = view.createEntity('IfcCartesianPoint', [coordinates]).expressId;
  recordCompoundMutation(view, draft => draft.deleteEntity(first));
  let visits = 0;
  Object.defineProperty(coordinates, 0, { enumerable: true, get() { visits++; return 2; } });
  undoRecordedMutationOperations(view, 1, () => { throw new Error('Expected compound inverse'); });
  expect(visits).toBe(0);
  expect(view.getNewEntities().map(row => row.expressId)).toEqual([first, second]);
});
