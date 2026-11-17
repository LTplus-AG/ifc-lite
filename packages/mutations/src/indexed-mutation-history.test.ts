// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from 'vitest';
import { MutablePropertyView } from './mutable-property-view.js';
import { recordCompoundMutation, undoRecordedMutationOperations } from './compound-recording.js';
import { cooperativeOverlay } from './cooperative-overlay-access.js';
import { indexedHistory, historyForEntity, purgeEntityHistory } from './indexed-mutation-history.js';

it('#8452 indexes single-row entity journals without allocating a Set per authored record', () => {
  const view = new MutablePropertyView(null, 'singleton-journal');
  for (let i = 0; i < 35; i++) view.createEntity('IfcCartesianPoint', [[i, 0, 0]]);
  const rows = [...view.getMutations()];
  const OriginalSet = globalThis.Set;
  let allocations = 0;
  let journal: ReturnType<typeof indexedHistory>;
  vi.stubGlobal('Set', new Proxy(OriginalSet, {
    construct(target, args, newTarget) {
      allocations++;
      return Reflect.construct(target, args, newTarget);
    },
  }));
  try { journal = indexedHistory(rows); }
  finally { vi.unstubAllGlobals(); }
  expect(allocations).toBe(0);
  expect([...journal!]).toEqual(rows);
  // Promotion to multiple rows must retain exact entity lookup and removal.
  const first = rows[0]!;
  const second = { ...first, id: first.id + '-second' };
  journal!.push(second);
  expect(historyForEntity(journal!, first.entityId)).toEqual([first, second]);
  expect(purgeEntityHistory(journal!, first.entityId)).toEqual([first, second]);
  expect([...journal!]).toEqual(rows.slice(1));
});

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

it('#8452 restores an edited journal row whose original successor was removed by the same compound operation', () => {
  const view = new MutablePropertyView(null, 'journal-successor');
  const a = view.createEntity('IfcCartesianPoint', [[1, 0, 0]]).expressId;
  const b = view.createEntity('IfcCartesianPoint', [[2, 0, 0]]).expressId;
  const before = structuredClone(view.getMutations());
  recordCompoundMutation(view, draft => {
    draft.getMutations()[0]!.attributeName = 'changed in draft';
    draft.deleteEntity(b);
  });
  undoRecordedMutationOperations(view, 1, () => { throw Error('Expected compound undo'); });
  expect(view.getMutations()).toEqual(before);
  expect(view.getNewEntities().map(row => row.expressId)).toEqual([a, b]);
});


it('#8452 clones appended journal rows as one detached batch without visiting old history', () => {
  const view = new MutablePropertyView(null, 'journal-batch');
  for (let i = 0; i < 200; i++) view.createEntity('IfcCartesianPoint', [[i, 0, 0]]);
  let retained: ReturnType<MutablePropertyView['getMutations']>[number] | undefined;
  const clones = vi.spyOn(globalThis, 'structuredClone');
  let rowClones = 0, batches = 0;
  try {
    view.runAtomic(draft => {
      for (let i = 0; i < 35; i++) draft.createEntity('IfcCartesianPoint', [[i, 1, 0]]);
      retained = draft.getMutations(234)[0];
    });
    for (const [value] of clones.mock.calls) {
      if (value && typeof value === 'object' && 'type' in value && value.type === 'CREATE_ENTITY') rowClones++;
      if (Array.isArray(value) && value.length === 35 && value.every(row => row.type === 'CREATE_ENTITY')) batches++;
    }
  } finally { clones.mockRestore(); }
  expect(rowClones).toBe(0);
  expect(batches).toBe(1);
  expect(view.getMutationCount()).toBe(235);
  expect(retained).toBeDefined();
  retained!.attributeName = 'changed after publication';
  expect(view.getMutations().at(-1)?.attributeName).not.toBe('changed after publication');
});
