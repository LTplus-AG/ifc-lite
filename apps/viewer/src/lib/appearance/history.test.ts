/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from 'zustand/vanilla';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { createMutationSlice } from '@/store/slices/mutationSlice.js';
import type { ViewerState } from '@/store/index.js';
import { applyAppearanceEntities, replayAppearanceEntities } from './apply-plan.js';
import { prepareAppearanceHistory, registerAppearanceHistory } from './history.js';

async function fixture(modelId = 'model') {
  const source = new TextEncoder().encode(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Appearance history fixture'),'2;1');
FILE_NAME('appearance.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCCOLOURRGB($,1.,0.,0.);
#2=IFCSURFACESTYLERENDERING(#1,0.,$,$,$,$,$,$,.NOTDEFINED.);
#10=IFCPROJECT('0Project0000000000000a',$,'History',$,$,$,$,$,#12);
#11=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#12=IFCUNITASSIGNMENT((#11));
ENDSEC;
END-ISO-10303-21;`);
  const data = await new IfcParser().parseColumnar(source.buffer);
  const view = new MutablePropertyView(data.properties, modelId);
  const editor = new StoreEditor(data, view);
  const store = createStore<ViewerState>((...args) => ({
    ...createMutationSlice(...args), canCollabEdit: () => true,
    models: new Map(), storeEditors: new Map([[modelId, editor]]),
  } as ViewerState));
  store.getState().registerMutationView(modelId, view);
  const apply = () => {
    const next = view.peekNextExpressId();
    return applyAppearanceEntities(editor, view, {
      sourceRevision: 'current', nextExpressId: next,
      created: [{ expressId: next, type: 'IfcColourRgb', attributes: [null, 0, 0, 1] }],
      edits: [{ expressId: 2, index: 0, value: `#${next}` }], removed: [],
    }, 'current');
  };
  return { store, view, editor, apply, modelId };
}

describe('appearance command history #4243', () => {
  it('undoes and redoes the whole IFC graph in order with ordinary edits', async () => {
    const { store, view, editor, apply, modelId } = await fixture();
    store.getState().setPositionalAttribute(modelId, 2, 1, 0.25);
    const edit = apply();
    let disposed = 0;
    const final = registerAppearanceHistory(store, modelId, {
      mutations: edit.mutations, replay: direction => replayAppearanceEntities(view, edit, direction),
      dispose: () => { disposed++; },
    });
    assert.strictEqual(final, edit.mutations.at(-1));
    assert.equal(store.getState().undoStacks.get(modelId)?.length, 2);
    store.getState().setPositionalAttribute(modelId, 2, 1, 0.5);
    store.getState().undo(modelId);
    assert.equal(view.getPositionalMutationsForEntity(2)?.get(1), 0.25);
    assert.ok(editor.getNewEntity(edit.created[0].expressId));
    store.getState().undo(modelId);
    assert.equal(editor.getNewEntity(edit.created[0].expressId), null);
    assert.equal(view.getPositionalMutationsForEntity(2)?.has(0), false);
    assert.equal(view.getPositionalMutationsForEntity(2)?.get(1), 0.25);
    assert.equal(disposed, 0, 'redo retains image resources');
    store.getState().redo(modelId);
    assert.deepEqual(editor.getNewEntity(edit.created[0].expressId)?.attributes, [null, 0, 0, 1]);
    assert.equal(view.getPositionalMutationsForEntity(2)?.get(0), `#${edit.created[0].expressId}`);
    store.getState().redo(modelId);
    assert.equal(view.getPositionalMutationsForEntity(2)?.get(1), 0.5);
    store.getState().clearAllMutations();
    assert.equal(disposed, 1);
  });

  it('keeps IFC and both stacks unchanged when replay fails, allowing retry', async () => {
    const { store, view, editor, apply, modelId } = await fixture();
    const edit = apply();
    let fail = true;
    registerAppearanceHistory(store, modelId, {
      mutations: edit.mutations,
      replay: direction => {
        if (fail) throw new Error('GPU staging failed');
        replayAppearanceEntities(view, edit, direction);
      }, dispose: () => {},
    });
    for (const direction of ['undo', 'redo'] as const) {
      const before = store.getState();
      const entityBefore = editor.getNewEntity(edit.created[0].expressId);
      assert.throws(() => store.getState()[direction](modelId), /GPU staging failed/);
      assert.strictEqual(store.getState().undoStacks, before.undoStacks);
      assert.strictEqual(store.getState().redoStacks, before.redoStacks);
      assert.equal(store.getState().mutationVersion, before.mutationVersion);
      assert.deepEqual(editor.getNewEntity(edit.created[0].expressId), entityBefore);
      fail = false;
      store.getState()[direction](modelId);
      fail = true;
    }
    store.getState().clearAllMutations();
  });

  it('releases discarded redo assets on a new ordinary edit without releasing another model', async () => {
    const { store, view, apply, modelId } = await fixture();
    const other = await fixture('other');
    store.getState().registerMutationView('other', other.view);
    const disposed: string[] = [];
    for (const [id, targetView, edit] of [[modelId, view, apply()], ['other', other.view, other.apply()]] as const) {
      registerAppearanceHistory(store, id, {
        mutations: edit.mutations, replay: direction => replayAppearanceEntities(targetView, edit, direction),
        dispose: () => { disposed.push(id); },
      });
    }
    store.getState().undo(modelId);
    store.getState().setPositionalAttribute(modelId, 2, 1, 0.75);
    assert.deepEqual(disposed, [modelId]);
    assert.equal(view.getPositionalMutationsForEntity(2)?.get(1), 0.75);
    store.getState().undo('other');
    assert.equal(other.editor.getNewEntities().length, 0);
    assert.deepEqual(disposed, [modelId]);
    store.getState().clearMutationView('other');
    assert.deepEqual(disposed, [modelId, 'other']);
  });

  it('releases leases on view replacement and session history reset', async () => {
    for (const teardown of ['replace', 'reset'] as const) {
      const { store, view, apply, modelId } = await fixture();
      const edit = apply();
      let disposed = 0;
      registerAppearanceHistory(store, modelId, {
        mutations: edit.mutations, replay: direction => replayAppearanceEntities(view, edit, direction),
        dispose: () => { disposed++; },
      });
      if (teardown === 'replace') store.getState().registerMutationView(modelId, new MutablePropertyView(null, modelId));
      else store.setState({ undoStacks: new Map(), redoStacks: new Map(), mutationViews: new Map() });
      assert.equal(disposed, 1);
      assert.equal(store.getState().canUndo(modelId), false, 'old command cannot replay against replacement entity IDs');
      store.getState().clearAllMutations();
      assert.equal(disposed, 1, 'released once and subscription removed');
    }
  });

  it('preflights missing or duplicate domain records without taking asset ownership', async () => {
    const { store, view, apply, modelId } = await fixture();
    const edit = apply();
    let disposed = 0;
    const command = { mutations: edit.mutations, replay: (direction: 'undo' | 'redo') => replayAppearanceEntities(view, edit, direction), dispose: () => { disposed++; } };
    assert.throws(() => prepareAppearanceHistory(store, modelId, { ...command, mutations: [] }), /applied mutations/);
    assert.throws(() => prepareAppearanceHistory(store, 'missing', command), /applied mutations/);
    assert.throws(() => prepareAppearanceHistory(store, modelId, { ...command, mutations: [{ ...edit.mutations[0], id: 'not-applied' }] }), /missing or already/);
    const commit = prepareAppearanceHistory(store, modelId, command);
    assert.equal(store.getState().canUndo(modelId), false);
    commit();
    commit(); // harmless repeated completion never appends another stack entry
    assert.equal(store.getState().undoStacks.get(modelId)?.length, 1);
    assert.throws(() => prepareAppearanceHistory(store, modelId, command), /missing or already/);
    assert.equal(disposed, 0);
    store.getState().clearAllMutations();
    assert.equal(disposed, 1);
  });
});
