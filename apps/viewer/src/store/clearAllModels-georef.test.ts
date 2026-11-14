/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { MutablePropertyView, type Mutation } from '@ifc-lite/mutations';
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
  } finally {
    store.setState({ mutationViews: before.mutationViews, georefMutations: before.georefMutations, dirtyModels: before.dirtyModels });
  }
});

it('discarding overlapping kept creations keeps the georeference edit unsaved and undoable (#10139)', () => {
  const store = useViewerStore;
  const before = store.getState();
  const view = new MutablePropertyView(null, 'm');
  view.setExpressIdWatermark(100);
  view.createEntity('IfcMaterial', ['Kept']); // #101, which the reloaded source overlaps
  const created = { id: 'c1', type: 'CREATE_ENTITY', modelId: 'm', entityId: 101, attributeName: 'IfcMaterial', timestamp: 2 } as Mutation;
  const georef = { id: 'g1', type: 'UPDATE_ATTRIBUTE', modelId: 'm', entityId: 0, attributeName: 'georef.mapConversion.eastings', oldValue: 0, newValue: 1, timestamp: 1 } as Mutation;
  const edit: GeorefMutationData = { mapConversion: { eastings: 1 } };
  store.setState({
    mutationViews: new Map([['m', view]]),
    georefMutations: new Map([['m', edit]]),
    dirtyModels: new Set(['m']),
    undoStacks: new Map([['m', [georef, created]]]),
  });
  try {
    assert.equal(discardOverlappingRetainedEdits(store.getState(), 'm', 200), 0);
    const after = store.getState();
    assert.equal(after.mutationViews.has('m'), false, 'the overlapping creations are gone');
    assert.equal(after.dirtyModels.has('m'), true, 'the georeference edit is still unsaved');
    assert.deepEqual(after.undoStacks.get('m'), [georef], 'and still undoable');
    assert.equal(after.georefMutations.get('m'), edit);
  } finally {
    store.setState({ mutationViews: before.mutationViews, georefMutations: before.georefMutations, dirtyModels: before.dirtyModels, undoStacks: before.undoStacks });
  }
});
