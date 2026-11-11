/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { isSceneSettled, whenSceneSettled } from './scene-settled';

const scene = { queued: false, fragments: false, finalizing: false };
function installRenderer(): void {
  const fake = { getScene: () => ({ hasQueuedMeshes: () => scene.queued, hasStreamingFragments: () => scene.fragments,
    isFinalizeInProgress: () => scene.finalizing }) } as unknown as Renderer;
  setGlobalRendererRef({ current: fake } as RefObject<Renderer | null>);
}

afterEach(() => {
  setGlobalRendererRef({ current: null } as RefObject<Renderer | null>);
  Object.assign(scene, { queued: false, fragments: false, finalizing: false });
  useViewerStore.setState({ loading: false, geometryStreamingActive: false, pendingInstancedShards: null });
});

it('is settled only when the store and the renderer have both finished the load', () => {
  installRenderer();
  useViewerStore.setState({ loading: false, geometryStreamingActive: false, pendingInstancedShards: null });
  assert.equal(isSceneSettled(), true);
  for (const state of [{ loading: true }, { geometryStreamingActive: true }, { pendingInstancedShards: [{ modelId: 'm', shards: [] }] }]) {
    useViewerStore.setState(state as never);
    assert.equal(isSceneSettled(), false, `store: ${Object.keys(state)[0]}`);
    useViewerStore.setState({ loading: false, geometryStreamingActive: false, pendingInstancedShards: null });
  }
  for (const key of ['queued', 'fragments', 'finalizing'] as const) {
    scene[key] = true;
    assert.equal(isSceneSettled(), false, `scene: ${key}`);
    scene[key] = false;
  }
  assert.equal(isSceneSettled(), true);
});

it('resolves once the renderer finishes its finalize, not before', async () => {
  installRenderer();
  scene.finalizing = true;
  let settled: boolean | undefined;
  const waiting = whenSceneSettled().then((value) => { settled = value; });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(settled, undefined, 'still waiting while the scene finalizes');
  scene.finalizing = false;
  await waiting;
  assert.equal(settled, true);
});

it('gives up as soon as the caller is superseded, and after its timeout', async () => {
  installRenderer();
  scene.fragments = true;
  let current = true;
  const superseded = whenSceneSettled(() => current);
  current = false;
  assert.equal(await superseded, false);
  assert.equal(await whenSceneSettled(() => true, 150), false, 'a scene that never settles times out');
});
