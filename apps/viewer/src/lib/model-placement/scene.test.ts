/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { getGlobalRenderer, setGlobalRendererRef } from '@/hooks/useBCF';
import { modelIndices } from './model-indices';
import { modelBounds } from './scene';

it('#11246 never uses the index-zero model’s bounds for a removed model', t => {
  const initial = useViewerStore.getState(), previous = getGlobalRenderer();
  t.after(() => {
    setGlobalRendererRef({ current: previous });
    useViewerStore.setState(initial, true);
    modelIndices(initial.models);
  });
  useViewerStore.setState(fixtureModels());
  modelIndices(useViewerStore.getState().models);
  const live = fixtureModel('live'), removed = fixtureModel('removed');
  const federation = fixtureModels(live, removed);
  useViewerStore.setState(federation);
  const indices = modelIndices(federation.models);
  assert.equal(indices.get(live.id), 0);
  assert.equal(indices.get(removed.id), 1);

  const liveBounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
  const renderer = new Renderer(document.createElement('canvas'));
  t.mock.method(renderer, 'getModelPlacementBounds', (index: number) => index === 0 ? liveBounds : null);
  let removeOnRead = false;
  setGlobalRendererRef({
    get current() {
      // Publish the removal after modelBounds captures its state and before it reads the index.
      if (removeOnRead) {
        removeOnRead = false;
        useViewerStore.setState(fixtureModels(live));
      }
      return renderer;
    },
  });
  removeOnRead = true;

  assert.equal(modelBounds(removed.id), null);
  assert.deepEqual(modelBounds(live.id), liveBounds);
});
