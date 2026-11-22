/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { deferred } from '@/test/race';
import { installModelLoadCanceller } from '@/hooks/modelLoadCanceller';
import { assertWorkflowOwner, startWorkflowRun } from '@/lib/flow/run-session';
import { coordinationFlowOperations } from '@/lib/agent-tools/operations/coordination-flow';
import { newFlowDocument } from '@/lib/flow/persistence';
import { realignLoadedModels } from './realign-loaded-models';

const original = useViewerStore.getState();
const model = (id: string, loadedAt = 0) => ({
  ...fixtureModel(id), loadedAt, sourceFile: new File(['fixture'], `${id}.ifc`),
});
beforeEach(() => useViewerStore.setState(fixtureModels(model('A', 1), model('B', 2), model('C', 3))));
afterEach(() => useViewerStore.setState(original, true));

it('stops reloading snapshot sources when a primary replaces the federation (#10591)', async () => {
  const entered = deferred(), drain = deferred();
  const attempted: string[] = [];
  const pending = realignLoadedModels(async (_file, options) => {
    const id = options!.modelId!;
    attempted.push(id);
    if (id === 'B') {
      entered.resolve();
      await drain.promise;
      return null;
    }
    useViewerStore.getState().addModel(model(id));
    return id;
  });
  await entered.promise;
  const releasePrimary = installModelLoadCanceller('primary', () => {});
  try {
    useViewerStore.getState().clearAllModels();
    useViewerStore.getState().addModel(model('D'));
    drain.resolve();
    const result = await pending;
    assert.deepEqual(attempted, ['A', 'B']);
    assert.deepEqual([...useViewerStore.getState().models.keys()], ['D']);
    assert.equal(result.state, 'superseded');
  } finally {
    releasePrimary();
  }
});

it('owns the federation reload through ordinary add failures and releases on completion (#10591)', async () => {
  const entered = deferred(), drain = deferred();
  const attempted: string[] = [];
  const pending = realignLoadedModels(async (_file, options) => {
    assertWorkflowOwner(options?.workflowOwner);
    const id = options!.modelId!;
    attempted.push(id);
    if (id === 'A') {
      entered.resolve();
      await drain.promise;
    }
    if (id === 'B') return null;
    useViewerStore.getState().addModel(model(id));
    return id;
  });
  await entered.promise;
  let competing: ReturnType<typeof startWorkflowRun> | undefined;
  try {
    assert.throws(() => { competing = startWorkflowRun(); }, /already running/);
  } finally {
    competing?.release();
    drain.resolve();
    await pending;
  }
  assert.deepEqual(await pending, { state: 'partial', loaded: 2, total: 3, failed: ['B'] });
  assert.deepEqual(attempted, ['A', 'B', 'C']);
  startWorkflowRun().release();
});

const flowCancel = () => {
  const op = coordinationFlowOperations.find(candidate => candidate.id === 'flow.cancel');
  assert.ok(op);
  return op.execute({}, { commit: <T>(write: () => T) => write() } as never);
};

it('refuses to start while an admitted primary can still commit (#11263)', async () => {
  // Deferred supersession: this primary would commit later and clear whatever federation exists then.
  const releasePrimary = installModelLoadCanceller('primary', () => {}, () => null, undefined, () => true, true);
  const before = useViewerStore.getState().models;
  let adds = 0;
  try {
    await assert.rejects(realignLoadedModels(async () => { adds++; return null; }), /still loading/);
    assert.equal(useViewerStore.getState().models, before, 'nothing was cleared');
    assert.equal(adds, 0);
    startWorkflowRun().release(); // and no lease was taken
  } finally {
    releasePrimary();
  }
});

it('stops when models are cleared outside the lease mid-rebuild (#11263)', async () => {
  const entered = deferred(), drain = deferred();
  const attempted: string[] = [];
  const pending = realignLoadedModels(async (_file, options) => {
    const id = options!.modelId!;
    attempted.push(id);
    if (id === 'B') {
      entered.resolve();
      await drain.promise;
    }
    useViewerStore.getState().addModel(model(id));
    return id;
  });
  await entered.promise;
  useViewerStore.getState().clearAllModels(); // a multi-file open clears before its lease-checked load
  drain.resolve();
  const result = await pending;
  assert.equal(result.state, 'superseded');
  assert.deepEqual(attempted, ['A', 'B']);
});

it('keeps reloading when the flow document is edited mid-rebuild (#11263)', async () => {
  const entered = deferred(), drain = deferred();
  const pending = realignLoadedModels(async (_file, options) => {
    assertWorkflowOwner(options?.workflowOwner);
    const id = options!.modelId!;
    if (id === 'A') {
      entered.resolve();
      await drain.promise;
    }
    useViewerStore.getState().addModel(model(id));
    return id;
  });
  await entered.promise;
  const { setFlowDoc } = useViewerStore.getState();
  const flowDoc = newFlowDocument('Edited mid-rebuild');
  setFlowDoc(flowDoc);
  // flow.cancel (and the Flow panel Stop button, which shares its cancel) stops flow runs only.
  assert.deepEqual(await flowCancel(), { cancellation_requested: false, terminal: false });
  drain.resolve();
  assert.deepEqual(await pending, { state: 'completed', loaded: 3, total: 3, failed: [] });
  assert.deepEqual([...useViewerStore.getState().models.keys()].sort(), ['A', 'B', 'C']);

  // A flow run is still stale once its document changes.
  const flow = startWorkflowRun();
  try {
    setFlowDoc(flowDoc);
    assert.equal(flow.controller.signal.aborted, true);
  } finally {
    flow.release();
  }
  const cancelled = startWorkflowRun();
  try {
    assert.deepEqual(await flowCancel(), { cancellation_requested: true, terminal: false });
    assert.equal(cancelled.controller.signal.aborted, true);
  } finally {
    cancelled.release();
  }
});
