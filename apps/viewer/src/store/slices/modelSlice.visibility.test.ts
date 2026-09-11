/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Batched model visibility (issue #4215): `setModelsVisibility` and
 * `isolateModels` flip a federation in ONE store write, dedupe repeated ids,
 * ignore ids that are not loaded, and write nothing when nothing changes.
 * Driven through the real store so the slice wiring is what is tested.
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { federationRegistry } from '@ifc-lite/renderer';
import { useViewerStore } from '../index.js';
import type { FederatedModel } from '../types.js';

function model(id: string, visible = true): FederatedModel {
  return {
    id, name: `${id}.ifc`, ifcDataStore: null, geometryResult: null, visible, collapsed: false,
    schemaVersion: 'IFC4', loadedAt: 1, fileSize: 0, idOffset: 0, maxExpressId: 10,
  } as FederatedModel;
}

function seed(...ids: string[]): void {
  federationRegistry.clear();
  for (const id of ids) federationRegistry.registerModel(id, 10);
  useViewerStore.setState({ models: new Map(ids.map((id) => [id, model(id)])), activeModelId: ids[0] ?? null });
}

const visibility = () =>
  Object.fromEntries([...useViewerStore.getState().models].map(([id, m]) => [id, m.visible]));

describe('modelSlice batched visibility (#4215)', () => {
  beforeEach(() => seed('A', 'B', 'C'));

  it('isolateModels shows exactly the given models and hides every other loaded model, in one write', () => {
    let writes = 0;
    const unsubscribe = useViewerStore.subscribe((s, prev) => { if (s.models !== prev.models) writes += 1; });
    try {
      useViewerStore.getState().isolateModels(['A', 'C', 'A']);
    } finally {
      unsubscribe();
    }
    assert.deepEqual(visibility(), { A: true, B: false, C: true });
    assert.equal(writes, 1, 'a federation of three flips in ONE models-map write, not one per model');
  });

  it('isolateModels of an already-hidden model shows it again (isolate is absolute, not a toggle)', () => {
    useViewerStore.getState().setModelVisibility('B', false);
    useViewerStore.getState().isolateModels(['B']);
    assert.deepEqual(visibility(), { A: false, B: true, C: false });
  });

  it('setModelsVisibility applies to the listed models only, ignores unknown ids, and no-ops without a change', () => {
    const s = useViewerStore.getState();
    s.setModelsVisibility(['A', 'B', 'not-loaded'], false);
    assert.deepEqual(visibility(), { A: false, B: false, C: true });
    assert.equal(useViewerStore.getState().models.has('not-loaded'), false, 'an unknown id is not conjured into the federation');

    const before = useViewerStore.getState().models;
    useViewerStore.getState().setModelsVisibility(['A', 'B'], false);
    assert.equal(useViewerStore.getState().models, before, 'nothing changed → the models map identity is kept (no spurious re-render)');

    useViewerStore.getState().setModelsVisibility(new Set(['A', 'B']), true);
    assert.deepEqual(visibility(), { A: true, B: true, C: true });
  });

  it('the single-model writers still work through the shared field patch', () => {
    const s = useViewerStore.getState();
    s.setModelVisibility('B', false);
    s.setModelCollapsed('C', true);
    s.setModelName('A', 'Renamed');
    const models = useViewerStore.getState().models;
    assert.equal(models.get('B')?.visible, false);
    assert.equal(models.get('C')?.collapsed, true);
    assert.equal(models.get('A')?.name, 'Renamed');
    const before = useViewerStore.getState().models;
    s.setModelVisibility('nope', false);
    assert.equal(useViewerStore.getState().models, before, 'an unknown id writes nothing');
  });
});
