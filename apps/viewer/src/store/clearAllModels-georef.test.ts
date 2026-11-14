/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { MutablePropertyView } from '@ifc-lite/mutations';
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
