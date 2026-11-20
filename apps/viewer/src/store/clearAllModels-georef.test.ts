/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { MutablePropertyView, type Mutation } from '@ifc-lite/mutations';
import { listExportModels } from '@/components/viewer/export-model-selection';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { discardOverlappingRetainedEdits } from '@/utils/model-mutation-view';
import { useViewerStore } from './index.js';
import type { GeorefMutationData } from './slices/mutationSlice.js';

// Pins the georef guard in discardUnchangedMutationViews (utils/model-mutation-view.ts),
// which clearAllModels calls: georeference edits live outside the view.

it('clearing all models keeps a model with only georeference edits and drops unchanged views (#10139)', () => {
  const store = useViewerStore;
  const before = store.getState();
  const georefView = new MutablePropertyView(null, 'georef');
  const plainView = new MutablePropertyView(null, 'plain');
  const edit: GeorefMutationData = { mapConversion: { eastings: 1 } };
  store.setState({
    mutationViews: new Map([['georef', georefView], ['plain', plainView]]),
    georefMutations: new Map([['georef', edit]]),
    dirtyModels: new Set(['georef']),
  });
  try {
    store.getState().clearAllModels();
    const after = store.getState();
    assert.equal(after.mutationViews.get('georef'), georefView, 'the georeferenced model keeps its view');
    assert.equal(after.dirtyModels.has('georef'), true, 'its edit is still unsaved');
    assert.equal(after.georefMutations.get('georef'), edit, 'and still there to save');
    assert.equal(after.mutationViews.has('plain'), false, 'an unchanged view is dropped');

    // A model whose only unsaved work is the schedule it owns stays unsaved too.
    const scheduled = new MutablePropertyView(null, 'sched');
    store.setState({ mutationViews: new Map([['sched', scheduled]]), dirtyModels: new Set(['sched']), scheduleSourceModelId: 'sched', scheduleIsEdited: true });
    store.getState().clearAllModels();
    assert.equal(store.getState().dirtyModels.has('sched'), true, 'the schedule edit is still unsaved');
  } finally {
    store.setState({ mutationViews: before.mutationViews, georefMutations: before.georefMutations, dirtyModels: before.dirtyModels,
      scheduleSourceModelId: before.scheduleSourceModelId, scheduleIsEdited: before.scheduleIsEdited });
  }
});

it('clearing a mutation view keeps schedule-only edits marked for export (#10469)', () => {
  const store = useViewerStore;
  const before = store.getState();
  const modelId = 'scheduled';
  const model = fixtureModel(modelId);
  try {
    store.setState({ ...fixtureModels(model), dirtyModels: new Set() });
    store.getState().registerMutationView(modelId, new MutablePropertyView(null, modelId));
    store.getState().setScheduleData({
      hasSchedule: true, workCalendars: [], workSchedules: [], sequences: [],
      tasks: [{
        expressId: 42, globalId: 'task', name: 'Before', isMilestone: false,
        childGlobalIds: [], productExpressIds: [], productGlobalIds: [], controllingScheduleGlobalIds: [],
      }],
    });
    store.getState().updateTask('task', { name: 'After' });
    assert.equal(store.getState().dirtyModels.has(modelId), true);

    store.getState().clearMutationView(modelId);

    const after = store.getState();
    assert.equal(after.mutationViews.has(modelId), false);
    assert.equal(after.scheduleData?.tasks[0].name, 'After');
    assert.equal(listExportModels(after.models, after.dirtyModels, null)[0].isDirty, true);
  } finally {
    store.setState(before);
  }
});

it('discarding overlapping kept creations keeps georeference history, its batch tags and a schedule edit (#10139)', () => {
  const store = useViewerStore;
  const before = store.getState();
  const view = new MutablePropertyView(null, 'm');
  view.setExpressIdWatermark(100);
  view.createEntity('IfcMaterial', ['Kept']); // #101, which the reloaded source overlaps
  const geo = (id: string, field: string) => ({ id, type: 'UPDATE_ATTRIBUTE', modelId: 'm', entityId: 0, attributeName: `georef.mapConversion.${field}`, oldValue: 0, newValue: 1, timestamp: 1 }) as Mutation;
  const created = { id: 'c1', type: 'CREATE_ENTITY', modelId: 'm', entityId: 101, attributeName: 'IfcMaterial', timestamp: 2 } as Mutation;
  const [east, north, redone] = [geo('g1', 'eastings'), geo('g2', 'northings'), geo('g3', 'scale')];
  const restore = () => store.setState({ mutationViews: before.mutationViews, georefMutations: before.georefMutations, dirtyModels: before.dirtyModels,
    undoStacks: before.undoStacks, redoStacks: before.redoStacks, mutationBatchTags: before.mutationBatchTags, storeEditors: before.storeEditors,
    scheduleIsEdited: before.scheduleIsEdited, scheduleSourceModelId: before.scheduleSourceModelId });
  const edit: GeorefMutationData = { mapConversion: { eastings: 1 } };
  const seed = () => store.setState({
    mutationViews: new Map([['m', view]]), dirtyModels: new Set(['m']), georefMutations: new Map([['m', edit]]),
    undoStacks: new Map([['m', [east, north, created]]]), redoStacks: new Map([['m', [redone]]]),
    mutationBatchTags: new Map([['g1', 'b'], ['g2', 'b'], ['c1', 'x']]),
  });
  try {
    seed();
    assert.equal(discardOverlappingRetainedEdits(store.getState(), 'm', 200), 0);
    let after = store.getState();
    assert.equal(after.mutationViews.has('m'), false, 'the overlapping creations are gone');
    assert.equal(after.dirtyModels.has('m'), true, 'the georeference edit is still unsaved');
    assert.equal(after.georefMutations.get('m'), edit, 'and still there to save');
    assert.deepEqual(after.undoStacks.get('m'), [east, north], 'and still undoable');
    assert.deepEqual(after.redoStacks.get('m'), [redone], 'an undone georef edit stays redoable');
    assert.deepEqual([after.mutationBatchTags.get('g1'), after.mutationBatchTags.get('g2'), after.mutationBatchTags.has('c1')], ['b', 'b', false], 'the georef batch keeps its tag');

    // A pending georeference value keeps the model unsaved even when its history was cleared.
    store.setState({ mutationViews: new Map([['m', view]]), dirtyModels: new Set(['m']), undoStacks: new Map([['m', [created]]]), redoStacks: new Map() });
    discardOverlappingRetainedEdits(store.getState(), 'm', 200);
    assert.equal(store.getState().dirtyModels.has('m'), true, 'the pending georeference value is still unsaved');

    // An undone georef edit (redo only, no pending value) does not: nothing is left to save.
    store.setState({ mutationViews: new Map([['m', view]]), dirtyModels: new Set(['m']), georefMutations: new Map(),
      undoStacks: new Map([['m', [created]]]), redoStacks: new Map([['m', [redone]]]) });
    discardOverlappingRetainedEdits(store.getState(), 'm', 200);
    assert.equal(store.getState().dirtyModels.has('m'), false, 'an undone georef edit leaves nothing to save');
    assert.deepEqual(store.getState().redoStacks.get('m'), [redone], 'but stays redoable');

    // Without georef, only the schedule the model owns keeps it dirty.
    store.setState({ mutationViews: new Map([['m', view]]), dirtyModels: new Set(['m']), undoStacks: new Map([['m', [created]]]), redoStacks: new Map(),
      scheduleIsEdited: true, scheduleSourceModelId: 'm' });
    discardOverlappingRetainedEdits(store.getState(), 'm', 200);
    after = store.getState();
    assert.equal(after.dirtyModels.has('m'), true, 'the schedule edit is still unsaved');
    store.setState({ mutationViews: new Map([['m', view]]), dirtyModels: new Set(['m']), undoStacks: new Map([['m', [created]]]), scheduleIsEdited: false });
    discardOverlappingRetainedEdits(store.getState(), 'm', 200);
    assert.equal(store.getState().dirtyModels.has('m'), false, 'nothing left to save');
  } finally {
    restore();
  }
});
