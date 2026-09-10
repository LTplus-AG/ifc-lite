/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { federationRegistry } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { appearanceAssets, modelAppearanceAssets } from './model-assets.js';
import { coordinatedFixture } from './coordinated-command.fixture.js';

afterEach(() => {
  mock.restoreAll();
  useViewerStore.getState().clearAllMutations();
  useViewerStore.setState({ models: new Map(), mutationViews: new Map(), geometryResult: null });
  modelAppearanceAssets.clear(); appearanceAssets.clear(); federationRegistry.clear();
});

it('coordinated Apply publishes both IFC graphs, canonical geometry, and histories once #4420', async () => {
  const f = await coordinatedFixture();
  const original = f.entries.map(e => f.export(e.modelId));
  f.stage();
  const observed: number[] = [];
  const stop = useViewerStore.subscribe((current, previous) => {
    if (current.models !== previous.models) observed.push([...current.models.values()].filter(m => m.geometryResult?.meshes[0].texture).length);
  });
  await f.commit();
  assert.deepEqual(observed, [2], 'no observer sees only one canonical model changed');
  for (const e of f.entries) {
    assert.equal(useViewerStore.getState().undoStacks.get(e.modelId)?.length, 1);
    assert.match(String(f.export(e.modelId)), /IFCIMAGETEXTURE/);
  }
  useViewerStore.getState().undo('b');
  assert.deepEqual(observed, [2, 0]);
  for (const [index, e] of f.entries.entries()) {
    assert.deepEqual(f.export(e.modelId), original[index]);
    assert.equal(f.scene.get(e.globalId)?.parts[0].texture, undefined);
  }
  useViewerStore.getState().redo('a');
  assert.deepEqual(observed, [2, 0, 2]);
  for (const e of f.entries) assert.deepEqual(f.scene.get(e.globalId)?.parts[0].texture?.rgba, new Uint8Array([0,0,255,255]));
  stop();
});

it('late second-model asset failure restores both IFC graphs, preview, and history #4420', async () => {
  const f = await coordinatedFixture(), initial = useViewerStore.getState();
  const original = f.entries.map(e => f.export(e.modelId)); f.stage();
  const register = modelAppearanceAssets.registerAuthored.bind(modelAppearanceAssets);
  mock.method(modelAppearanceAssets, 'registerAuthored', (modelId: string, commandId: string, ids: readonly string[]) => {
    register(modelId, commandId, ids);
    if (modelId === 'b') throw new Error('Injected late registration failure');
  });
  await assert.rejects(f.commit(), /late registration/);
  assert.equal(useViewerStore.getState().models, initial.models);
  assert.equal(useViewerStore.getState().undoStacks, initial.undoStacks);
  for (const [index, e] of f.entries.entries()) {
    assert.deepEqual(f.export(e.modelId), original[index]);
    assert.deepEqual(f.scene.get(e.globalId)?.parts[0], e.before);
    assert.equal(modelAppearanceAssets.exportResources(e.modelId).resources.size, 0);
  }
  appearanceAssets.releaseOwner(f.owner);
  assert.equal(appearanceAssets.get(f.asset.id), undefined);
  assert.equal(f.resources.filter(r => !r.released).length, 2);
});

it('a scene observer throwing after the second install restores the whole preview #4420', async () => {
  const f = await coordinatedFixture(); f.failInstall(f.entries[1].globalId);
  assert.throws(() => f.stage(), /Scene observer/);
  for (const e of f.entries) {
    assert.deepEqual(f.scene.get(e.globalId)?.parts[0], e.before);
    assert.equal(e.view.getMutations().length, 0);
  }
  assert.equal(f.resources.filter(r => !r.released).length, 2);
});

it('a newer ordinary edit in the other participant refuses grouped Undo without scene changes #4420', async () => {
  const f = await coordinatedFixture(); f.stage(); await f.commit();
  useViewerStore.getState().setPositionalAttribute('b', 25, 2, 'New name');
  const before = f.entries.map(e => f.export(e.modelId));
  assert.throws(() => useViewerStore.getState().undo('a'), /newer changes/);
  for (const [index, e] of f.entries.entries()) {
    assert.deepEqual(f.export(e.modelId), before[index]);
    assert.deepEqual(f.scene.get(e.globalId)?.parts[0].texture?.rgba, new Uint8Array([0,0,255,255]));
  }
});

it('a late state observer error reports committed status with both models and Undo retained #4420', async () => {
  const f = await coordinatedFixture(); f.stage();
  const observed: number[] = [];
  const stop = useViewerStore.subscribe((current, previous) => {
    if (current.models === previous.models) return;
    observed.push([...current.models.values()].filter(model => model.geometryResult?.meshes[0].texture).length);
    throw new Error('Injected subscriber exception after complete publication');
  });
  let receipt: Awaited<ReturnType<typeof f.commit>>;
  try { receipt = await f.commit(); } finally { stop(); }
  assert.equal(receipt.observerFailed, true);
  assert.deepEqual(observed, [2]);
  for (const e of f.entries) {
    assert.equal(useViewerStore.getState().undoStacks.get(e.modelId)?.length, 1);
    assert.match(f.export(e.modelId), /IFCIMAGETEXTURE/);
  }
  useViewerStore.getState().undo('a');
  for (const e of f.entries) assert.equal(f.scene.get(e.globalId)?.parts[0].texture, undefined);
});


it('GPU commit emits no install observer between the membership fence and grouped publication #4420', async () => {
  const f = await coordinatedFixture(); f.stage();
  let callbacks = 0;
  f.observeInstall(() => {
    callbacks++;
    const state = useViewerStore.getState(), models = new Map(state.models);
    models.delete('b'); useViewerStore.setState({models});
  });
  await f.commit();
  assert.equal(callbacks,0,'installation and externally visible scene changes finish in reversible preview staging');
  assert.equal(useViewerStore.getState().models.size,2);
  for (const entry of f.entries) assert.equal(useViewerStore.getState().undoStacks.get(entry.modelId)?.length,1);
});
