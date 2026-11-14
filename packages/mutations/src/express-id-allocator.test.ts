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

it('notifies createEntity observers after records, history and revision are coherent (#10139)', () => {
  const view = new MutablePropertyView(null, 'model');
  const before = view.getMutationRevision();
  const observed: unknown[] = [];
  view.configureExpressIdAllocator(() => 1, () => observed.push({
    history: view.getMutationCount(), revision: view.getMutationRevision(),
    ids: [...view.getNewEntitiesOfType('IfcMaterial')].map(entity => entity.expressId),
  }));
  view.createEntity('IfcMaterial', ['Live']);
  expect(observed).toEqual([{ history: 1, revision: before + 1, ids: [1] }]);
});

it('tracks every claimed ID without mistaking source floors for authorship (#10139)', () => {
  const view = new MutablePropertyView(null, 'model');
  view.setExpressIdWatermark(100);
  expect(view.highestAuthoredExpressId()).toBe(0);
  const first = view.createEntity('IfcMaterial', ['First']);
  view.setAttribute(first.expressId, 'Name', 'Edited');
  view.deleteEntity(first.expressId);
  view.restoreFromTombstone(first.expressId); // Forgotten/stashed claims survive without a tombstone.
  expect(view.highestAuthoredExpressId()).toBe(101);
  view.setExpressIdWatermark(500);
  const later = view.createEntity('IfcMaterial', ['Later']);
  expect(view.highestAuthoredExpressId()).toBe(501);
  expect(view.highestAuthoredExpressId(150)).toBe(101);
  const prepared = view.prepareAtomic(draft => { draft.deleteEntity(later.expressId); return draft.highestAuthoredExpressId(); });
  expect(prepared.result).toBe(501);
  prepared.commit();
  expect(view.highestAuthoredExpressId()).toBe(501);
  prepared.rollback();
  expect(view.highestAuthoredExpressId()).toBe(501);
  view.clear();
  expect(view.highestAuthoredExpressId()).toBe(0);
});

it('restoreNewEntity observers see unstashed edits and attribute indexes (#10139)', () => {
  // Exercise the high-ID import/restore branch with a lower allocator, retaining undo state.
  class RestorableView extends MutablePropertyView {
    resetAllocation() { this.resetExpressIdAllocator(); }
  }
  const view = new RestorableView(null, 'model');
  const entity = view.createEntity('IfcMaterial', ['Original']);
  view.setAttribute(entity.expressId, 'Name', 'Edited');
  view.deleteEntity(entity.expressId);
  view.resetAllocation();
  const observed: unknown[] = [];
  view.configureExpressIdAllocator(() => 1, () => observed.push({
    edits: view.getAttributeMutationsForEntity(entity.expressId),
    ids: view.getAttributeOverrideEntityIds(),
  }));
  view.restoreNewEntity(entity);
  expect(observed).toEqual([{ edits: [{ name: 'Name', value: 'Edited' }], ids: [entity.expressId] }]);
});
