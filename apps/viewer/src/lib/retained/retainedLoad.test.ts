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
import { RETAINED_MAX_SOURCE_BYTES } from './retained-protocol';
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
    ['an oversize source', stepFile('huge.ifc', RETAINED_MAX_SOURCE_BYTES + 1), 'primary', /limited to 256 MiB/],
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
    assert.match(model?.loadError ?? '', /limited to 256 MiB/);
    assert.equal(activity.result().outcome, 'failed');
    assert.equal(kernel.refuseSource('ifcx', 10, { modelId: 'm', activity }), true);
    assert.equal(load.spawned(), 0);
  });

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
