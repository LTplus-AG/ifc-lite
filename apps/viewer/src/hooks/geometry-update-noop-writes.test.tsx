/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A geometry update (a re-meshed element publishes a new `models` map) must
 * not make the model-keyed sync hooks write back unchanged state (#6232 perf):
 * each write is a store notification and another render of every subscriber.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, advance } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useModelSelection } from './useModelSelection';
import { useLevelDisplayEffect } from './useLevelDisplayEffect';

function Hooks() {
  useModelSelection();
  useLevelDisplayEffect();
  return null;
}

describe('model-keyed sync hooks on a geometry update (#6232)', () => {
  afterEach(cleanup);

  it('write nothing when the selection and storey offsets are unchanged', async () => {
    useViewerStore.setState({ ...fixtureModels(fixtureModel('m')), selectedEntityId: 7, levelDisplayMode: 'stacked' });
    render(<Hooks />);
    await advance(10);
    const selection = useViewerStore.getState().selectedEntity;
    const offsets = useViewerStore.getState().appliedStoreyOffsets;
    assert.ok(selection, 'the selection resolved on mount');

    let writes = 0;
    const unsubscribe = useViewerStore.subscribe((next, prev) => {
      if (next.selectedEntity !== prev.selectedEntity || next.appliedStoreyOffsets !== prev.appliedStoreyOffsets) writes++;
    });
    // What replaceEntityMeshes publishes: a new map holding a new model object.
    const models = new Map(useViewerStore.getState().models);
    models.set('m', { ...models.get('m')! });
    useViewerStore.setState({ models });
    await advance(10);
    unsubscribe();
    assert.equal(writes, 0);
    assert.equal(useViewerStore.getState().selectedEntity, selection);
    assert.equal(useViewerStore.getState().appliedStoreyOffsets, offsets);
  });
});
