/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6232 D4: every edit that enters history is filed in the active change set
 * (`recordHistory`), undo takes it out, redo files it back where it was; the
 * first edit with no active set starts "Unsaved changes". Plus the set
 * actions the Change sets panel uses: rename, delete, import returning an id.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PropertyValueType } from '@ifc-lite/data';
import { MutablePropertyView, type Mutation } from '@ifc-lite/mutations';
import { useViewerStore, type ViewerState } from '@/store/index.js';
import { fixtureModel } from '@/test/store-fixture';
import { pushCreateEntityUndo } from './mutation-cost-undo.js';

const UNSAVED_CHANGE_SET_NAME = 'Unsaved changes';
const initial = useViewerStore.getState();
const store = () => useViewerStore.getState();
const ids = (id: string) => store().changeSets.get(id)?.mutations.map((m) => m.id) ?? [];

function install(): MutablePropertyView {
  const view = new MutablePropertyView(null, 'A');
  useViewerStore.setState({
    models: new Map([['A', fixtureModel('A')]]), activeModelId: 'A',
    mutationViews: new Map([['A', view]]), undoStacks: new Map(), redoStacks: new Map(),
    mutationBatchTags: new Map(), dirtyModels: new Set(), mutationVersion: 0,
    changeSets: new Map(), activeChangeSetId: null, editEnabled: true, collabRoomId: null,
  });
  return view;
}

/** A change-set action, asserted to exist, so its absence fails as an assertion rather than a TypeError. */
function action<K extends 'renameChangeSet' | 'deleteChangeSet'>(name: K): ViewerState[K] {
  const fn = store()[name];
  assert.equal(typeof fn, 'function', `the slice has ${name}`);
  return fn;
}

function edit(entityId: number, value: string): Mutation {
  const mutation = store().setProperty('A', entityId, 'Pset_Test', 'Code', value, PropertyValueType.Label);
  assert.ok(mutation);
  return mutation;
}

describe('change sets collect the edits that enter history (#6232 D4)', () => {
  beforeEach(install);
  afterEach(() => useViewerStore.setState(initial));

  it('the first edit with no active set starts "Unsaved changes" and makes it active', () => {
    const first = edit(1, 'a');
    const [set] = store().changeSets.values();
    assert.equal(set.name, UNSAVED_CHANGE_SET_NAME);
    assert.equal(store().activeChangeSetId, set.id);
    assert.deepEqual(ids(set.id), [first.id]);
    edit(2, 'b');
    assert.equal(store().changeSets.size, 1, 'later edits join the same set');
  });

  it('edits land in whichever set is active', () => {
    const a = store().createChangeSet('A');
    const one = edit(1, 'a');
    const b = store().createChangeSet('B');
    const two = edit(2, 'b');
    store().setActiveChangeSet(a);
    const three = edit(3, 'c');
    assert.deepEqual(ids(a), [one.id, three.id]);
    assert.deepEqual(ids(b), [two.id]);
  });

  it('every recording path files its edit: attributes, psets, quantities, georef, batches, cost creates', () => {
    const id = store().createChangeSet('All');
    store().setAttribute('A', 1, 'Name', 'Wall', 'Old');
    store().createPropertySet('A', 1, 'Pset_New', []);
    store().setQuantity('A', 1, 'Qto_Test', 'Length', 2);
    store().setGeorefFields('A', 'mapConversion', [{ field: 'Eastings', value: 10, oldValue: 0 }]);
    const view = store().mutationViews.get('A')!;
    const batch = [view.setProperty(5, 'Pset_Bulk', 'X', '1', PropertyValueType.Label), view.setProperty(6, 'Pset_Bulk', 'X', '1', PropertyValueType.Label)];
    store().recordMutationBatch('A', batch);
    pushCreateEntityUndo(useViewerStore.setState, 'A', 42, 'IFCCOSTITEM');
    const recorded = store().undoStacks.get('A')!.map((m) => m.id);
    assert.equal(recorded.length, 7);
    assert.deepEqual(ids(id), recorded, 'the set holds exactly what history holds, in order');
  });

  it('undo takes a whole batch out of its set and redo puts it back in order, even after switching sets', () => {
    const origin = store().createChangeSet('Origin');
    const single = edit(1, 'a');
    const view = store().mutationViews.get('A')!;
    const batch = [1, 2, 3].map((n) => view.setProperty(10 + n, 'Pset_Bulk', 'X', `${n}`, PropertyValueType.Label));
    store().recordMutationBatch('A', batch);
    assert.deepEqual(ids(origin), [single.id, ...batch.map((m) => m.id)]);

    store().undo('A');
    assert.deepEqual(ids(origin), [single.id], 'one undo removes the whole batch');
    const other = store().createChangeSet('Other');
    store().redo('A');
    assert.deepEqual(ids(origin), [single.id, ...batch.map((m) => m.id)], 'redo files it back where it came from');
    assert.deepEqual(ids(other), [], 'not into the set that is active now');
  });

  it('redo of an edit whose set was discarded files it in the active set', () => {
    const doomed = store().createChangeSet('Doomed');
    const mutation = edit(1, 'a');
    store().undo('A');
    action('deleteChangeSet')(doomed);
    assert.equal(store().activeChangeSetId, null, 'deleting the active set clears it');
    store().redo('A');
    const [set] = store().changeSets.values();
    assert.equal(set.name, UNSAVED_CHANGE_SET_NAME);
    assert.deepEqual(ids(set.id), [mutation.id]);
  });

  it('a new edit after undo leaves the undone edit out of every set', () => {
    const id = store().createChangeSet('Set');
    edit(1, 'a');
    store().undo('A');
    const kept = edit(2, 'b');
    assert.deepEqual(ids(id), [kept.id]);
  });
});

describe('change set actions (#6232 D4)', () => {
  beforeEach(install);
  afterEach(() => useViewerStore.setState(initial));

  it('rename keeps the set, its edits and the active choice', () => {
    const id = store().createChangeSet('Draft');
    const mutation = edit(1, 'a');
    action('renameChangeSet')(id, 'Final');
    assert.equal(store().changeSets.get(id)?.name, 'Final');
    assert.deepEqual(ids(id), [mutation.id]);
    assert.equal(store().activeChangeSetId, id);
    action('renameChangeSet')('missing', 'x');
    assert.equal(store().changeSets.size, 1);
  });

  it('delete drops the set but not the edits; deleting another set keeps the active one', () => {
    const a = store().createChangeSet('A');
    edit(1, 'a');
    const b = store().createChangeSet('B');
    action('deleteChangeSet')(a);
    assert.equal(store().changeSets.has(a), false);
    assert.equal(store().activeChangeSetId, b);
    assert.equal(store().undoStacks.get('A')?.length, 1, 'history is untouched');
  });

  it('activating an unknown set is ignored', () => {
    const id = store().createChangeSet('A');
    store().setActiveChangeSet('missing');
    assert.equal(store().activeChangeSetId, id);
  });

  it('export then import round-trips the edits into a new, inactive set and returns its id', () => {
    const id = store().createChangeSet('Share');
    edit(1, 'a');
    edit(2, 'b');
    const json = store().exportChangeSet(id);
    assert.ok(json);
    const imported = store().importChangeSet(json);
    assert.ok(imported);
    assert.notEqual(imported, id);
    const copy = store().changeSets.get(imported);
    assert.equal(copy?.name, 'Share');
    assert.deepEqual(copy?.mutations, store().changeSets.get(id)?.mutations);
    assert.equal(store().activeChangeSetId, id);
  });

  it('import returns null for text that is not a change set', () => {
    for (const text of ['not json', '{}', '{"changeSet":{"name":"x"}}', 'null']) {
      assert.equal(store().importChangeSet(text), null, text);
    }
    assert.equal(store().changeSets.size, 0);
  });
});
