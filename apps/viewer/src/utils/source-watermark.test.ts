/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { sourceWatermark } from './source-watermark.js';
import { useViewerStore } from '@/store';

it('an indexless table store still owns its table-only rows (#10139)', () => {
  const tabular = { entityIndex: {}, entities: { expressId: new Uint32Array([3, 900, 12]) } } as unknown as IfcDataStore;
  assert.equal(sourceWatermark(tabular), 900);
  assert.equal(sourceWatermark({ entityIndex: {} } as unknown as IfcDataStore), 0, 'a test double owns none');
  assert.equal(sourceWatermark(null), 0);
});

it('clearing all models keeps the unsaved state of a model with only georeference edits (#10139)', () => {
  const store = useViewerStore;
  const view = new MutablePropertyView(null, 'georef');
  store.setState({
    mutationViews: new Map([['georef', view]]),
    georefMutations: new Map([['georef', { eastings: 1 }]]) as never,
    dirtyModels: new Set(['georef']),
  });
  try {
    store.getState().clearAllModels();
    assert.equal(store.getState().mutationViews.get('georef'), view, 'the view is kept');
    assert.equal(store.getState().dirtyModels.has('georef'), true, 'the georeference edit is still unsaved');
  } finally {
    store.setState({ mutationViews: new Map(), georefMutations: new Map(), dirtyModels: new Set() });
  }
});
