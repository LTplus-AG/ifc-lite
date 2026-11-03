/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7955 production opt-in (`VITE_RETAINED_GEOMETRY=lazy`): an exact load
 * never fetches the retained module; a retained load before the module has
 * arrived stops quietly and re-runs itself once it is in; a failed fetch
 * reports one error whose Retry loads exact.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { requestedGeometryKernel, saveGeometryKernel } from '@/store/geometryKernel';
import type { GeometryKernelLoad } from '@/hooks/ingest/geometryEventSource';
import type { RetainedKernel } from './kernel';
import { beginLazy, loadRetainedKernel, resetRetainedKernelForTest } from './lazy';

const file = new File(['ISO-10303-21;'], 'model.ifc');
const primary = { kind: 'primary' } as const;

function fakeModule() {
  const calls: string[] = [];
  const kernel: RetainedKernel = {
    requested: requestedGeometryKernel,
    begin: () => { calls.push('begin'); return { kind: 'retained' } as GeometryKernelLoad; },
    Chip: () => null,
    KernelSetting: () => null,
  };
  let imports = 0;
  const importer = async () => { imports++; return { retainedKernel: kernel }; };
  return { calls, importer, imports: () => imports };
}

afterEach(() => {
  resetRetainedKernelForTest();
  sessionStorage.clear();
  localStorage.clear();
  history.replaceState(null, '', '/');
  useViewerStore.getState().setError(null);
});

describe('#7955 lazy retained kernel', () => {
  it('an exact load gets the exact kernel and fetches nothing', () => {
    const module = fakeModule();
    assert.equal(beginLazy(file, primary, () => assert.fail('no re-run'), module.importer), null);
    assert.equal(module.imports(), 0);
  });

  it('a retained load before the module arrives stops quietly and re-runs once it is in', async () => {
    saveGeometryKernel('retained');
    const module = fakeModule();
    let retried = 0;
    const first = beginLazy(file, primary, () => { retried++; }, module.importer);
    assert.ok(first?.refused, 'the first attempt stops before any work');
    assert.equal(first.kind, 'retained');
    assert.equal(first.serverEnabled, false);
    assert.equal(first.refuseSource('ifc', 1, { modelId: 'm', activity: { fail: (m) => m } }), true);
    await first.refused;
    assert.equal(retried, 1, 'the same load runs again');
    assert.equal(useViewerStore.getState().error, null, 'no message for the quiet stop');
    const second = beginLazy(file, primary, () => assert.fail('no second re-run'), module.importer);
    assert.equal(second?.kind, 'retained');
    assert.deepEqual(module.calls, ['begin'], 'the re-run is decided by the retained module');
    assert.equal(module.imports(), 1);
  });

  it('a failed fetch reports one error; its Retry loads exact in this tab only', async () => {
    saveGeometryKernel('retained');
    let retried = 0;
    const failing = async () => { throw new Error('offline'); };
    const load = beginLazy(file, primary, () => { retried++; }, failing);
    await load?.refused;
    const state = useViewerStore.getState();
    assert.match(String(state.error), /could not be downloaded/);
    assert.equal(retried, 0);
    state.lastLoadRetry?.();
    assert.equal(retried, 1);
    assert.equal(requestedGeometryKernel(), 'exact', 'the retry loads exact');
    sessionStorage.clear();
    assert.equal(requestedGeometryKernel(), 'retained', 'the saved choice is kept for the next tab');
    const module = fakeModule();
    await loadRetainedKernel(module.importer);
    assert.equal(module.imports(), 1, 'a failed fetch is not cached');
  });
});
