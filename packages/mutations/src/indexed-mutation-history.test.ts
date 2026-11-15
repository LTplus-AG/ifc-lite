// SPDX-License-Identifier: MPL-2.0
import { expect, it } from 'vitest';
import { MutablePropertyView } from './mutable-property-view.js';
import { recordCompoundMutation, undoRecordedMutationOperations } from './compound-recording.js';
import { cooperativeOverlay } from './cooperative-overlay-access.js';

it('#8452 replacing a bounded join profile does not read unrelated journal records', () => {
  const view = new MutablePropertyView(null, 'bounded-delete');
  const profile = view.createEntity('IfcRectangleProfileDef', [null, null, null, 2, 0.3]);
  for (let i = 0; i < 200; i++) view.createEntity('IfcCartesianPoint', [[i, 0, 0]]);
  let reads = 0;
  const journal = view.getMutations();
  for (const row of journal.slice(1)) {
    const id = row.entityId;
    Object.defineProperty(row, 'entityId', { configurable: true, enumerable: true, get() { reads++; return id; } });
  }
  view.runAtomic(draft => { draft.deleteEntity(profile.expressId); });
  expect(reads).toBe(0);
  expect(view.getMutationsForEntity(profile.expressId).map(row => row.type)).toEqual(['DELETE_ENTITY']);
  expect(view.getNewEntityCount()).toBe(200);
});

it('#8452 compound undo restores removed journal rows in exact order with detached nested drafts', () => {
  const view = new MutablePropertyView(null, 'journal-undo');
  const ids = Array.from({ length: 6 }, (_, i) => view.createEntity('IfcCartesianPoint', [[i, 0, 0]]).expressId);
  const before = structuredClone(view.getMutations());
  const entities = structuredClone(view.getNewEntities());
  recordCompoundMutation(view, draft => draft.runAtomic(inner => {
    inner.deleteEntity(ids[3]!); inner.deleteEntity(ids[1]!);
    inner.createEntity('IfcCartesianPoint', [[100, 0, 0]]);
  }));
  const after = structuredClone(view.getMutations());
  expect(after.filter(row => row.type === 'CREATE_ENTITY').map(row => row.entityId)).toEqual([ids[0], ids[2], ids[4], ids[5], 7]);
  expect(undoRecordedMutationOperations(view, 1, () => { throw Error('Expected compound undo'); })).toBeGreaterThan(0);
  expect(view.getMutations()).toEqual(before);
  expect(view.getNewEntities()).toEqual(entities);
  const state = cooperativeOverlay(view).capture();
  expect(JSON.parse(view.exportMutations()).mutations).toEqual(state.mutationHistory);
});
