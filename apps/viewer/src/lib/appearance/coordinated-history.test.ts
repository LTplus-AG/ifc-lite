/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from 'zustand/vanilla';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import type { ViewerState } from '@/store';
import { createMutationSlice } from '@/store/slices/mutationSlice.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { applyAppearanceEntities, replayAppearanceEntitiesInDraft } from './apply-plan.js';
import { prepareCoordinatedAppearanceHistory } from './coordinated-history.js';
const source = new TextEncoder().encode(`ISO-10303-21;HEADER;FILE_DESCRIPTION(('History'),'2;1');FILE_NAME('h.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;#1=IFCCOLOURRGB($,1.,0.,0.);#2=IFCSURFACESTYLERENDERING(#1,0.,$,$,$,$,$,$,.NOTDEFINED.);ENDSEC;END-ISO-10303-21;`);
async function fixture() {
  const data = await new IfcParser().parseColumnar(source.buffer, { disableWorkerScan: true });
  const entries = ['a', 'b'].map(modelId => {
    const view = new MutablePropertyView(data.properties, modelId), editor = new StoreEditor(data, view);
    const next = view.peekNextExpressId();
    const edit = applyAppearanceEntities(editor, view, { sourceRevision: 'base', nextExpressId: next,
      created: [{ expressId: next, type: 'IfcColourRgb', attributes: [null, 0, 0, 1] }],
      edits: [{ expressId: 2, index: 0, value: `#${next}` }], removed: [] }, 'base');
    return { modelId, view, editor, edit };
  });
  const store = createStore<ViewerState>((...args) => ({ ...createMutationSlice(...args), canCollabEdit: () => true,
    models: new Map(entries.map(entry => [entry.modelId, { ...fixtureModel(entry.modelId), ifcDataStore: data }])),
    storeEditors: new Map(entries.map(entry => [entry.modelId, entry.editor])),
    mutationViews: new Map(entries.map(entry => [entry.modelId, entry.view])),
  } as ViewerState));
  let disposed = 0, fail = false;
  prepareCoordinatedAppearanceHistory(store, entries.map(entry => ({ ...entry, mutations: entry.edit.mutations })), {
    replay(direction) {
      const transactions = entries.map(entry => entry.view.prepareAtomic(draft => replayAppearanceEntitiesInDraft(draft, entry.edit, direction)));
      try {
        transactions.forEach(transaction => transaction.validate());
        for (const [index, transaction] of transactions.entries()) { transaction.commit(); if (fail && index === 0) throw new Error('Injected second-model publication failure'); }
      } catch (error) { for (const transaction of transactions.reverse()) transaction.rollback(); throw error; }
      return {};
    }, dispose() { disposed++; },
  })({});
  return { store, entries, disposed: () => disposed, fail(value: boolean) { fail = value; } };
}
it('one ordinary Undo/Redo moves both model histories and IFC graphs together #4420', async () => {
  const f = await fixture();
  let publications = 0;
  const stop = f.store.subscribe((current, previous) => { if (current.undoStacks !== previous.undoStacks) publications++; });
  f.store.getState().undo('b');
  assert.equal(publications, 1);
  for (const entry of f.entries) { assert.equal(entry.editor.getNewEntity(entry.edit.created[0].expressId), null);
    assert.equal(f.store.getState().undoStacks.get(entry.modelId)?.length, 0); assert.equal(f.store.getState().redoStacks.get(entry.modelId)?.length, 1); }
  f.store.getState().redo('a');
  assert.equal(publications, 2);
  for (const entry of f.entries) assert.ok(entry.editor.getNewEntity(entry.edit.created[0].expressId));
  assert.equal(f.disposed(), 0);
  stop(); f.store.getState().clearAllMutations(); assert.equal(f.disposed(), 1);
});
it('a newer ordinary edit in either model blocks group Undo until ordering is restored #4420', async () => {
  const f = await fixture();
  f.store.getState().setPositionalAttribute('b', 2, 1, 0.5);
  assert.throws(() => f.store.getState().undo('a'), /newer changes/);
  assert.equal(f.store.getState().undoStacks.get('a')?.length, 1);
  assert.equal(f.store.getState().undoStacks.get('b')?.length, 2);
  f.store.getState().undo('b'); f.store.getState().undo('a');
  for (const entry of f.entries) assert.equal(entry.editor.getNewEntity(entry.edit.created[0].expressId), null);
  f.store.getState().clearAllMutations();
});
it('a failed multi-model replay leaves every stack and IFC graph unchanged and allows retry #4420', async () => {
  const f = await fixture();
  f.fail(true); const before = f.store.getState();
  assert.throws(() => f.store.getState().undo('a'), /second-model publication failure/);
  assert.equal(f.store.getState().undoStacks, before.undoStacks); assert.equal(f.store.getState().redoStacks, before.redoStacks);
  for (const entry of f.entries) assert.ok(entry.editor.getNewEntity(entry.edit.created[0].expressId));
  f.fail(false); f.store.getState().undo('b');
  for (const entry of f.entries) assert.equal(entry.editor.getNewEntity(entry.edit.created[0].expressId), null);
  f.store.getState().clearAllMutations();
});
it('reloading one participant retires the whole group without generic replay in other models #4420', async () => {
  const f = await fixture();
  f.store.setState(state => ({ mutationViews: new Map(state.mutationViews).set('b', new MutablePropertyView(null, 'b')) }));
  assert.equal(f.disposed(), 1);
  assert.equal(f.store.getState().undoStacks.get('a')?.length, 0); assert.equal(f.store.getState().undoStacks.get('b')?.length, 0);
  f.store.getState().undo('a');
  assert.ok(f.entries[0].editor.getNewEntity(f.entries[0].edit.created[0].expressId));
  f.store.getState().clearAllMutations(); assert.equal(f.disposed(), 1);
});
it('a new edit after group Undo disposes the entire coordinated redo entry once #4420', async () => {
  const f = await fixture(); f.store.getState().undo('a');
  f.store.getState().setPositionalAttribute('b', 2, 1, 0.75);
  assert.equal(f.disposed(), 1); assert.equal(f.store.getState().redoStacks.get('a')?.length, 0);
  assert.equal(f.store.getState().redoStacks.get('b')?.length, 0);
  f.store.getState().clearAllMutations();
});
