/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it } from 'vitest';
import { MutablePropertyView } from './mutable-property-view.js';
import { StoreEditor } from './store-editor.js';

it('seeds and resets above both source IDs and a changing external ownership floor', () => {
  for (const sourceMax of [5, 30]) {
    const view = new MutablePropertyView(null, 'model');
    let minNext = 12;
    view.configureExpressIdAllocator(() => minNext);
    const store = { entityIndex: { byId: new Map([[sourceMax, { expressId: sourceMax, type: 'IFCWALL', byteOffset: 0, byteLength: 0, lineNumber: 0 }]]) } };
    const editor = new StoreEditor(store, view);
    expect(editor.addEntity('IfcMaterial', ['Unpublished']).expressId).toBe(Math.max(sourceMax + 1, minNext));
    minNext = 50;
    view.clear();
    expect(view.peekNextExpressId()).toBe(50);
    expect(editor.addEntity('IfcMaterial', ['After clear']).expressId).toBe(50);
  }
});

it('notifies next-ID consumers for direct creates, detached commit/rollback and clear', () => {
  const view = new MutablePropertyView(null, 'model');
  const nextIds: number[] = [];
  view.configureExpressIdAllocator(() => 11, () => nextIds.push(view.peekNextExpressId()));
  view.createEntity('IfcMaterial', ['Live']);
  const prepared = view.prepareAtomic(draft => draft.createEntity('IfcMaterial', ['Draft']));
  expect(nextIds).toEqual([11, 12]);
  prepared.commit();
  prepared.rollback();
  view.clear();
  expect(nextIds).toEqual([11, 12, 13, 12, 11]);
});

it('a detached clear retains the source and external floor', () => {
  const view = new MutablePropertyView(null, 'model');
  view.setExpressIdWatermark(30);
  view.configureExpressIdAllocator(() => 12);
  const transaction = view.prepareAtomic(draft => {
    draft.clear();
    return draft.createEntity('IfcMaterial', ['After detached clear']).expressId;
  });
  expect(transaction.result).toBe(31);
  transaction.commit();
  expect(view.peekNextExpressId()).toBe(32);
});

// #10139: allocator subscribers may read the complete overlay during commit/rollback.
it('notifies restored allocator observers only after history, indexes and revision are coherent', () => {
  const view = new MutablePropertyView(null, 'model');
  const before = view.getMutationRevision();
  const observed: Array<{ history: number; revision: number; ids: number[] }> = [];
  view.configureExpressIdAllocator(() => 1, () => {
    observed.push({ history: view.getMutationCount(), revision: view.getMutationRevision(),
      ids: [...view.getNewEntitiesOfType('IfcMaterial')].map(entity => entity.expressId) });
  });
  const prepared = view.prepareAtomic(draft => draft.createEntity('IfcMaterial', ['Draft']));
  prepared.commit();
  expect(observed).toEqual([{ history: 1, revision: before + 1, ids: [1] }]);
  prepared.rollback();
  expect(observed).toEqual([{ history: 1, revision: before + 1, ids: [1] },
    { history: 0, revision: before + 2, ids: [] }]);
});
