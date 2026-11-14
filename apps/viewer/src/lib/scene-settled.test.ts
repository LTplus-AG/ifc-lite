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
import { discardInstancedShards, enqueueInstancedShards, instancedShardGeneration } from '@/store/instancedShardQueue';
import { afterSceneSettled, isSceneSettled, whenSceneSettled } from './scene-settled';
import { noteLiveFrame } from './live-frame-count';

const scene = { queued: false, fragments: false, finalizing: false };
/** A draw the viewport has been asked for and not submitted yet (`peekRenderRequest`). */
const draw = { pending: false };
function installRenderer(): void {
  const fake = { getScene: () => ({ hasQueuedMeshes: () => scene.queued, hasStreamingFragments: () => scene.fragments,
    isFinalizeInProgress: () => scene.finalizing }), getGPUDevice: () => ({}), peekRenderRequest: () => draw.pending } as unknown as Renderer;
  setGlobalRendererRef({ current: fake } as RefObject<Renderer | null>);
}

afterEach(() => {
  setGlobalRendererRef({ current: null } as RefObject<Renderer | null>);
  Object.assign(scene, { queued: false, fragments: false, finalizing: false });
  draw.pending = false;
  useViewerStore.setState({ loading: false, geometryStreamingActive: false });
});

it('is settled only when the store and the renderer have both finished the load', () => {
  installRenderer();
  useViewerStore.setState({ loading: false, geometryStreamingActive: false });
  assert.equal(isSceneSettled(), true);
  for (const state of [{ loading: true }, { geometryStreamingActive: true }]) {
    useViewerStore.setState(state as never);
    assert.equal(isSceneSettled(), false, `store: ${Object.keys(state)[0]}`);
    useViewerStore.setState({ loading: false, geometryStreamingActive: false });
  }
  // Instanced shards wait in their own queue, outside the store (#9628).
  enqueueInstancedShards('m', [new ArrayBuffer(8)], instancedShardGeneration());
  assert.equal(isSceneSettled(), false, 'instanced shards still queued');
  discardInstancedShards();
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

it('resolves only after the viewport has drawn the settled scene, not when the scene first reads settled', async () => {
  installRenderer();
  draw.pending = true; // finalize asked for its frame; the animation loop has not submitted it (or holds it back)
  let settled: boolean | undefined;
  const waiting = whenSceneSettled().then((value) => { settled = value; });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(settled, undefined, 'settled but not drawn: work behind this promise would run in front of that frame');
  noteLiveFrame(); draw.pending = false; // the animation loop submits the frame
  await waiting;
  assert.equal(settled, true);
});

it('a load superseded while waiting for the settled frame runs nothing', async () => {
  installRenderer();
  draw.pending = true;
  let current = true;
  let ran = false;
  const waiting = whenSceneSettled(() => current).then((value) => { if (value) ran = true; return value; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  current = false; // a new load (or a cancel) supersedes this one before its frame is drawn
  noteLiveFrame(); draw.pending = false;
  assert.equal(await waiting, false);
  assert.equal(ran, false);
});

it('a scene that stops being settled while its frame is awaited waits for the next settle', async () => {
  installRenderer();
  draw.pending = true;
  let settled: boolean | undefined;
  const waiting = whenSceneSettled().then((value) => { settled = value; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  scene.fragments = true; // a late fragment arrives before the frame
  noteLiveFrame(); draw.pending = false;
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(settled, undefined, 'the frame showed an unsettled scene');
  scene.fragments = false;
  await waiting;
  assert.equal(settled, true);
});

it('a wait cancelled while the settled frame is awaited calls nothing (an unmount, a disposed sync)', async () => {
  installRenderer();
  draw.pending = true;
  const calls: boolean[] = [];
  const cancel = afterSceneSettled((settled) => calls.push(settled));
  await new Promise((resolve) => setTimeout(resolve, 50));
  cancel();
  noteLiveFrame(); draw.pending = false;
  await new Promise((resolve) => setTimeout(resolve, 1_200)); // past the frame wait's backstop
  assert.deepEqual(calls, []);
});

it('the caller\'s timeout holds through the frame wait: a draw that never submits reports false at the deadline, not true at the backstop', async () => {
  installRenderer();
  draw.pending = true; // settled, but its draw stays pending
  const calls: boolean[] = [];
  afterSceneSettled((settled) => calls.push(settled), () => true, 150);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(calls, [false], 'timed out at 150 ms, before the 1 s frame backstop');
  await new Promise((resolve) => setTimeout(resolve, 1_000)); // past the backstop
  assert.deepEqual(calls, [false], 'and nothing after it');
});

it('an Infinity timeout means no limit, not an immediate timeout (the placed spatial index waits this way)', async () => {
  installRenderer();
  draw.pending = true;
  const calls: boolean[] = [];
  const cancel = afterSceneSettled((settled) => calls.push(settled), () => true, Infinity);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(calls, [], 'still waiting for the frame');
  noteLiveFrame(); draw.pending = false;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(calls, [true]);
  cancel();
});

it('a load that starts and ends while the frame is awaited is waited for again: the old backstop is no proof the new scene was drawn', async () => {
  installRenderer();
  draw.pending = true; // scene A settled, its draw held back
  const calls: boolean[] = [];
  const cancel = afterSceneSettled((settled) => calls.push(settled), () => true, Infinity);
  await new Promise((resolve) => setTimeout(resolve, 50));
  useViewerStore.setState({ loading: true }); // load B starts...
  await new Promise((resolve) => setTimeout(resolve, 350));
  useViewerStore.setState({ loading: false }); // ...and ends with its own draw pending
  await new Promise((resolve) => setTimeout(resolve, 750)); // past A's 1 s frame backstop
  assert.deepEqual(calls, [], 'B\'s scene is not drawn yet');
  noteLiveFrame(); draw.pending = false;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(calls, [true]);
  cancel();
});
