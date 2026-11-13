/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The hierarchy must not keep a replaced model alive (#9629 review).
 *
 * The idle-built structure closes over the models, stores and geometry it was
 * built from. Holding it in React state kept the PREVIOUS model reachable
 * until the next idle build, which cannot run while the next load is in
 * progress, so a reopen or a new file carried two models at peak (the Holter
 * snapshot-reopen memory rise in the timed A/B).
 *
 * Real hook and store; the old model's data store is watched through a
 * WeakRef with forced garbage collection.
 */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { useHierarchyTree } from './useHierarchyTree';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

type IdleGlobal = typeof globalThis & {
  requestIdleCallback?: (callback: IdleRequestCallback) => number;
  cancelIdleCallback?: (handle: number) => void;
};
const idleGlobal = globalThis as IdleGlobal;
const realIdle = { request: idleGlobal.requestIdleCallback, cancel: idleGlobal.cancelIdleCallback };
let heldIdle: (() => void) | null = null;
beforeEach(() => {
  heldIdle = null;
  idleGlobal.requestIdleCallback = (callback: IdleRequestCallback) => { heldIdle = () => callback({ didTimeout: false, timeRemaining: () => 50 }); return 1; };
  idleGlobal.cancelIdleCallback = () => { heldIdle = null; };
});
afterEach(() => {
  cleanup();
  idleGlobal.requestIdleCallback = realIdle.request;
  idleGlobal.cancelIdleCallback = realIdle.cancel;
  useViewerStore.setState({ ...fixtureModels(), loading: false });
});

/** A model whose data store is only reachable through the store and whatever the hook keeps. */
function publishModel(id: string): WeakRef<object> {
  const model = fixtureModel(id, { entities: [
    { expressId: 7, type: 'IfcWall', name: `${id} wall A` },
    { expressId: 8, type: 'IfcWall', name: `${id} wall B` },
  ] });
  const weak = new WeakRef(model.ifcDataStore as object);
  useViewerStore.setState({ ...fixtureModels(model), hierarchyMode: 'type', loading: false });
  return weak;
}

it('a replaced model is not kept alive by the idle-built hierarchy structure while the next load runs', async () => {
  let tree!: ReturnType<typeof useHierarchyTree>;
  function Probe() {
    const models = useViewerStore((s) => s.models);
    tree = useHierarchyTree({ models, ifcDataStore: null, isMultiModel: false });
    return null;
  }
  // The panel mounts before any model, as in the app. (Callbacks memoized on
  // the first render keep that render's closure context, and so its models,
  // for the hook's lifetime; that is unrelated to the structure and holds
  // whatever was loaded at mount, here nothing.)
  useViewerStore.setState({ ...fixtureModels(), hierarchyMode: 'type', loading: false });
  render(<Probe />);
  heldIdle = null;
  let oldStore!: WeakRef<object>;
  act(() => { oldStore = publishModel('old'); });
  assert.ok(heldIdle, 'the structure build waits for idle');
  act(() => { const task = heldIdle; heldIdle = null; task?.(); });
  assert.equal(tree.treeData.length, 1);

  // The next file starts loading: the store drops the old model, and the idle
  // build cannot run while `loading` is true.
  act(() => {
    const next = fixtureModel('next', { entities: [{ expressId: 9, type: 'IfcSlab', name: 'next slab' }] });
    useViewerStore.setState({ ...fixtureModels(next), loading: true });
  });
  // Let React drop its previous fibers' state too.
  act(() => { tree.setSearchQuery(''); });
  act(() => { tree.setSearchQuery(' '); });

  // `deref()` keeps its target alive until the current job ends, so collect in
  // fresh tasks and only look afterwards.
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    gc();
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(oldStore.deref(), undefined, 'the previous model\'s data store must be collectable during the next load');
});
