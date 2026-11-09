/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7955 M2-C retained scope (§2.1.3): a federated add, a non-STEP input or an
 * oversize source stops before any work — before any Worker spawns — with a
 * message, and its Retry loads with the exact kernel. Nothing is federated
 * onto an open retained model, whatever kernel the add asks for.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { chooseGeometryKernel, requestedGeometryKernel } from '@/store/geometryKernel';
import { createModelLoadActivity } from '@/hooks/modelLoadCanceller';
import { stepFile } from '@/test/retained-host-fixture';
import { RetainedClient } from './retained-client';
import { RETAINED_MAX_SOURCE_BYTES, RetainedHostError } from './retained-protocol';
import { beginRetainedLoad } from './retainedLoad';

function harness() {
  let spawned = 0;
  let retried = 0;
  const client = new RetainedClient(() => { spawned++; throw new Error('a refused load must not spawn a Worker'); });
  return {
    begin: (file: File, kind: 'primary' | 'federated' = 'primary') => beginRetainedLoad(client, file, { kind }, () => { retried++; }),
    spawned: () => spawned,
    retried: () => retried,
  };
}

function retryFromErrorCard(): void {
  const retry = useViewerStore.getState().lastLoadRetry;
  assert.ok(retry, 'the refusal offers a Retry');
  retry();
}

afterEach(() => {
  chooseGeometryKernel('exact');
  const state = useViewerStore.getState();
  state.setError(null);
  state.setLastLoadRetry(null);
  state.clearAllModels();
});

describe('#7955 M2-C retained scope', () => {
  it('an exact request is not retained at all', () => {
    assert.equal(harness().begin(stepFile()), null);
  });

  it('#8415: load admission does not exclude an exact add before the retained summary is published', () => {
    chooseGeometryKernel('retained');
    const load = harness();
    const primary = load.begin(stepFile('primary.ifc'));
    assert.equal(primary?.kind, 'retained');
    assert.equal(primary?.refused, undefined);
    // The canonical loader reads the source before opening this event stream,
    // which is where the first retained summary becomes visible to admission.
    chooseGeometryKernel('exact');
    assert.equal(load.begin(stepFile('exact-add.ifc'), 'federated'), null,
      'an in-flight retained request is not a fence: export gates must scope their own model IDs');
  });

  for (const [title, file, kind, message] of [
    ['a federated add', stepFile('second.ifc'), 'federated', /one model at a time/],
    ['a non-STEP input', stepFile('site.xml'), 'primary', /IFC \(STEP\) files only/],
    ['an IFCX input', stepFile('model.ifcx'), 'primary', /IFC \(STEP\) files only/],
    ['a source wasm32 cannot hold', stepFile('huge.ifc', RETAINED_MAX_SOURCE_BYTES + 1), 'primary', /cannot hold a source of 2048 MiB or more/],
  ] as const) {
    it(`${title} stops before any Worker spawns, and Retry loads it exact`, async () => {
      chooseGeometryKernel('retained');
      const load = harness();
      const kernel = load.begin(file, kind);
      assert.ok(kernel?.refused, 'refused before any work');
      await kernel.refused;
      assert.equal(load.spawned(), 0);
      assert.match(useViewerStore.getState().error ?? '', message);
      retryFromErrorCard();
      assert.equal(load.retried(), 1);
      assert.equal(requestedGeometryKernel(), 'exact', 'Retry switched the next load to the exact kernel');
    });
  }

  it('content that is not STEP, or unwraps past the cap, stops once it is known', () => {
    chooseGeometryKernel('retained');
    const load = harness();
    const kernel = load.begin(stepFile('archive.ifczip'));
    assert.ok(kernel && !kernel.refused);
    useViewerStore.getState().addModel({
      id: 'm', name: 'archive.ifczip', ifcDataStore: null, geometryResult: null, visible: true, collapsed: false,
      schemaVersion: 'IFC4', loadedAt: 0, fileSize: 0, idOffset: 0, maxExpressId: 0, loadState: 'streaming-geometry',
    });
    const activity = createModelLoadActivity('archive.ifczip');
    assert.equal(kernel.refuseSource('ifc', 1024, { modelId: 'm', activity }), false, 'STEP within the cap proceeds');
    assert.equal(kernel.refuseSource('ifc', RETAINED_MAX_SOURCE_BYTES + 1, { modelId: 'm', activity }), true);
    const model = useViewerStore.getState().models.get('m');
    assert.equal(model?.loadState, 'error');
    assert.match(model?.loadError ?? '', /cannot hold a source of 2048 MiB or more/);
    assert.equal(activity.result().outcome, 'failed');
    assert.equal(kernel.refuseSource('ifcx', 10, { modelId: 'm', activity }), true);
    assert.equal(load.spawned(), 0);
  });

  it('a source over the former 256 MiB cap is loaded retained: memory, not a byte cap, decides', () => {
    chooseGeometryKernel('retained');
    const load = harness();
    const kernel = load.begin(stepFile('archicad.ifc', 342_657_851));
    assert.ok(kernel && kernel.kind === 'retained' && !kernel.refused, 'not refused before any work');
    const activity = createModelLoadActivity('archicad.ifc');
    assert.equal(kernel.refuseSource('ifc', 342_657_851, { modelId: 'm', activity }), false);
    assert.equal(kernel.refuseSource('ifc', RETAINED_MAX_SOURCE_BYTES, { modelId: 'm', activity }), false, 'the largest source wasm32 can hold proceeds');
  });

  it('the bound is wasm32 isize::MAX: 2^31 - 1 bytes proceed, 2 GiB (2^31) is refused as "2048 MiB or more"', () => {
    assert.equal(RETAINED_MAX_SOURCE_BYTES, 2 ** 31 - 1);
    chooseGeometryKernel('retained');
    assert.ok(!harness().begin(stepFile('under.ifc', 2 ** 31 - 1))?.refused, '2^31 - 1 bytes is one allocation wasm32 can make');
    const kernel = harness().begin(stepFile('two-gib.ifc', 2 ** 31));
    assert.ok(kernel?.refused, 'exactly 2 GiB is refused');
    assert.match(useViewerStore.getState().error ?? '', /"two-gib\.ifc" is 2048 MiB; the retained engine cannot hold a source of 2048 MiB or more/);
  });

  it('#7955 an engine that does not load (missing deployment, network) falls back: its Retry loads exact', () => {
    chooseGeometryKernel('retained');
    const load = harness();
    const failure = load.begin(stepFile('wall.ifc', 1024))?.loadFailure?.(new RetainedHostError('engine_missing', 'Failed to fetch dynamically imported module'));
    assert.equal(failure?.message, 'The retained engine could not be loaded for "wall.ifc": Failed to fetch dynamically imported module. '
      + 'Retry loads it with the exact kernel.');
    const retry = failure?.retry;
    assert.ok(retry, 'the failure brings its own Retry');
    retry();
    assert.equal(load.retried(), 1);
    assert.equal(requestedGeometryKernel(), 'exact', 'Retry switched this tab to the exact kernel');
  });

  it('a run out of memory is worded as such, and its Retry loads the model exact', () => {
    chooseGeometryKernel('retained');
    const load = harness();
    const kernel = load.begin(stepFile('tower.ifc', 1_487_216_442));
    const loadFailure = kernel?.loadFailure;
    assert.ok(loadFailure);
    const failure = loadFailure(new RetainedHostError('out_of_memory', 'unreachable'));
    assert.match(failure?.message ?? '', /"tower\.ifc" did not fit in the retained engine's memory .*Retry loads it with the exact kernel/);
    assert.equal(requestedGeometryKernel(), 'retained', 'nothing switches until the user retries');
    const retry = failure?.retry;
    assert.ok(retry, 'an out-of-memory failure brings its own Retry');
    retry();
    assert.equal(load.retried(), 1);
    assert.equal(requestedGeometryKernel(), 'exact', 'Retry switched the next load to the exact kernel');
    const crash = loadFailure(new RetainedHostError('worker_crash', 'memory access out of bounds'));
    assert.equal(crash?.message, 'The retained engine stopped while processing "tower.ifc": memory access out of bounds. '
      + 'Retry runs the retained kernel again; the Retained geometry panel can reload it with the exact kernel.',
      'another trap is a crash in the host\'s words, never "ran out of memory"');
    assert.doesNotMatch(crash?.message ?? '', /Reload with exact kernel\./, 'no advice that its Retry does not follow');
    assert.equal(crash?.retry, undefined, 'and keeps the load\'s own Retry, which runs retained again');
    assert.equal(loadFailure(new Error('out of memory')), null, 'a failure outside the host keeps the loader wording');
  });

  // #7955 M2-C: `addModel` raises the load UI before `loadFile` asks for a
  // kernel, and a refusal returns before any canceller exists. The refusal
  // must end that UI itself, but never the UI of a load that is still running.
  for (const owner of ['no other load', 'another running load'] as const) {
    it(`a refused federated add with ${owner} leaves the load UI ${owner === 'no other load' ? 'idle' : 'to that load'}, with its message shown (#7955)`, async () => {
      chooseGeometryKernel('retained');
      const state = useViewerStore.getState();
      const running = { phase: 'Processing geometry', percent: 40 };
      if (owner !== 'no other load') state.setActiveLoadCanceller(() => {});
      state.setLoading(true);
      state.setLoadingFileName('second.ifc');
      state.setProgress(owner === 'no other load' ? { phase: 'Loading file', percent: 0 } : running);
      try {
        const kernel = harness().begin(stepFile('second.ifc'), 'federated');
        assert.ok(kernel?.refused);
        await kernel.refused;
        const after = useViewerStore.getState();
        assert.match(after.error ?? '', /one model at a time/);
        if (owner === 'no other load') {
          assert.equal(after.loading, false, 'no spinner stuck at 0% without a Cancel');
          assert.equal(after.progress, null);
          assert.equal(after.loadingFileName, null);
        } else {
          assert.equal(after.loading, true, 'the running load keeps its spinner');
          assert.deepEqual(after.progress, running);
        }
      } finally {
        state.setActiveLoadCanceller(null);
        state.setLoading(false);
        state.setProgress(null);
        state.setLoadingFileName(null);
      }
    });
  }

  it('M11-Z keeps federation refused for an open final retained model, including an exact add', async () => {
    useViewerStore.getState().addModel({
      id: 'r', name: 'r.ifc', ifcDataStore: null, geometryResult: null, visible: true, collapsed: false,
      schemaVersion: 'IFC4', loadedAt: 0, fileSize: 0, idOffset: 0, maxExpressId: 0, loadState: 'complete',
      retainedGeometry: { kernel: 'retained', candidates: 1, published: 1, refused: [], cancelled: 0, obligationsUnmet: [], completeness: 'complete' },
    });
    const load = harness();
    const kernel = load.begin(stepFile('exact-add.ifc'), 'federated');
    assert.ok(kernel?.refused);
    await kernel.refused;
    assert.match(useViewerStore.getState().error ?? '', /Reload it with the exact kernel/);
    assert.equal(useViewerStore.getState().lastLoadRetry, null, 'no Retry: an exact add would mix kernels in one view');
    assert.equal(load.begin(stepFile('replace.ifc'), 'primary'), null, 'a primary exact load replaces it normally');
  });
});
