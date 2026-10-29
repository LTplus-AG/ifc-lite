/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser } from '@ifc-lite/parser';
import { DiffModelHandle } from '@ifc-lite/diff';
import type { GeometryResult } from '@ifc-lite/geometry';
import { DiffModel } from '@ifc-lite/wasm/diff';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { useCompare } from './useCompare';

const createModel = DiffModel.fromPacked;
let hook: ReturnType<typeof useCompare>;
let root: Root | null;
const Probe = () => { hook = useCompare(); return null; };
let creates: ReturnType<typeof mock.method<typeof DiffModel, 'fromPacked'>>;
let disposes: ReturnType<typeof mock.method<DiffModelHandle, 'dispose'>>;
let frees: ReturnType<typeof mock.method<DiffModel, 'free'>>;

beforeEach(async () => {
  const text = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCWALL('0WallA0000000000000001',$,'Wall A',$,$,$,$,'wall',.STANDARD.);\nENDSEC;\nEND-ISO-10303-21;";
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer,
    { disableWorkerScan: true });
  const a = fixtureModel('A'), b = fixtureModel('B'), c = fixtureModel('C');
  for (const m of [a, b, c]) {
    m.ifcDataStore = store;
    m.geometryResult = { meshes: [] } as unknown as GeometryResult;
  }
  useViewerStore.setState({ ...fixtureModels(a, b, c), mutationViews: new Map(), mutationVersion: 0,
    geometryContentVersion: 0, compareBaseModelId: 'A', compareHeadModelId: 'B', compareKeyProperty: undefined,
    compareScope: 'both', compareExcludedTypes: [], compareMatchByContent: false, compareAcceptedIdentity: [],
    compareResult: null, compareRunning: false, compareError: null });
  creates = mock.method(DiffModel, 'fromPacked');
  disposes = mock.method(DiffModelHandle.prototype, 'dispose');
  frees = mock.method(DiffModel.prototype, 'free');
  root = createRoot(document.createElement('div'));
  await act(async () => { root!.render(<StrictMode><Probe /></StrictMode>); });
});

afterEach(async () => {
  try {
    await unmount();
    assert.equal(frees.mock.callCount(), creates.mock.calls.filter(call => !call.error).length,
      '#8042: every successfully created native model must be released');
    assert.equal(disposes.mock.callCount(), frees.mock.callCount(), 'each handle is disposed exactly once');
  } finally { mock.restoreAll(); }
});

async function unmount() {
  if (root) { await act(async () => { root!.unmount(); }); root = null; }
}
async function run() {
  await act(async () => { await hook.runComparison(); });
  assert.equal(useViewerStore.getState().compareError, null);
}

describe('resident compare ownership (#8042 A2)', () => {
  it('creates once and reuses across Run, scope, exclusion, matching and accepted identity changes', async () => {
    await run();
    const before = useViewerStore.getState().compareResult!;
    await act(async () => { useViewerStore.setState({ compareScope: 'data' }); });
    await act(async () => { useViewerStore.setState({ compareExcludedTypes: ['IfcWall'] }); });
    assert.equal(useViewerStore.getState().compareResult?.diff.entries.length, 0);
    await act(async () => { useViewerStore.setState({ compareMatchByContent: true, compareExcludedTypes: [] }); });
    await act(async () => { useViewerStore.setState({ compareAcceptedIdentity: [] }); });
    await run();
    assert.equal(creates.mock.callCount(), 2);
    assert.equal(disposes.mock.callCount(), 0);
    await act(async () => { hook.clearCompare(); hook.clearCompare(); });
    assert.equal(disposes.mock.callCount(), 2);
    assert.equal(before.diff.entries[0]?.base?.ref.localId, 1, 'published rows survive disposal');
    assert.equal(before.diff.byKey.get(before.diff.entries[0]!.key), before.diff.entries[0]);
  });

  for (const [name, change] of [
    ['pair', () => useViewerStore.setState({ compareHeadModelId: 'C' })],
    ['key scheme', () => useViewerStore.setState({ compareKeyProperty: 'Tag' })],
    ['geometry content', () => useViewerStore.getState().bumpGeometryContentVersion()],
    ['mutation', () => useViewerStore.setState({ mutationVersion: 1 })],
    ['raw store clear', () => useViewerStore.getState().clearCompare()],
    ['store teardown', () => useViewerStore.setState({ models: new Map() })],
  ] as const) {
    it(`disposes synchronously on ${name} invalidation without double disposal on unmount`, async () => {
      await run();
      act(() => { change(); });
      assert.equal(frees.mock.callCount(), 2);
      await unmount();
      assert.equal(disposes.mock.callCount(), 2);
    });
  }

  it('rebuilds after invalidation and releases the replacement on unmount', async () => {
    await run();
    act(() => { useViewerStore.getState().bumpGeometryContentVersion(); });
    await run();
    assert.equal(creates.mock.callCount(), 4);
    assert.equal(frees.mock.callCount(), 2);
    await unmount();
    assert.equal(frees.mock.callCount(), 4);
  });

  it('does not borrow cached handles across the frame await', async () => {
    await run();
    let pending: Promise<void>;
    act(() => { pending = hook.runComparison(); useViewerStore.getState().bumpGeometryContentVersion(); });
    assert.equal(frees.mock.callCount(), 2);
    await act(async () => { await pending; });
    assert.equal(creates.mock.callCount(), 4);
    assert.equal(useViewerStore.getState().compareError, null);
  });

  for (const [name, change] of [
    ['scope', () => useViewerStore.setState({ compareScope: 'data' })],
    ['exclusions', () => useViewerStore.setState({ compareExcludedTypes: ['IfcWall'] })],
    ['matching', () => useViewerStore.setState({ compareMatchByContent: true })],
    ['accepted identities', () => useViewerStore.setState({ compareAcceptedIdentity: [] })],
  ] as const) {
    it(`does not retain a stale result after cancelling a cached run then changing ${name} (#8271)`, async () => {
      await run();
      assert.ok(useViewerStore.getState().compareResult);
      let pending: Promise<void>;
      act(() => { pending = hook.runComparison(); hook.cancelComparison(); });
      assert.equal(frees.mock.callCount(), 2, 'cancel still releases the cached pair');
      await act(async () => { await pending; change(); });
      assert.equal(useViewerStore.getState().compareResult, null,
        'a result without reusable handles must not disagree with the controls');
      assert.equal(useViewerStore.getState().compareRunning, false);
      assert.equal(creates.mock.callCount(), 2, 'cancelled continuation must not rebuild');
      await run();
      assert.ok(useViewerStore.getState().compareResult, 'Run can rebuild after cancellation');
      assert.equal(creates.mock.callCount(), 4);
    });
  }

  for (const action of ['cancel', 'clear', 'unmount', 'supersede', 'selection', 'key', 'teardown'] as const) {
    it(`releases a locally owned build when ${action} happens after allocation, before publication`, async () => {
      const original = createModel;
      let newer: Promise<void> | undefined;
      creates.mock.mockImplementationOnce((...args) => {
        queueMicrotask(() => {
          if (action === 'cancel') hook.cancelComparison();
          if (action === 'clear') useViewerStore.getState().clearCompare();
          if (action === 'unmount') { root!.unmount(); root = null; }
          if (action === 'supersede') newer = hook.runComparison();
          if (action === 'selection') useViewerStore.setState({ compareHeadModelId: 'C' });
          if (action === 'key') useViewerStore.setState({ compareKeyProperty: 'Tag' });
          if (action === 'teardown') useViewerStore.setState({ models: new Map() });
        });
        return original(...args);
      });
      await act(async () => { await hook.runComparison(); await newer; });
      assert.equal(useViewerStore.getState().compareError, null);
      assert.equal(frees.mock.callCount(), 2);
      assert.equal(useViewerStore.getState().compareResult === null, action !== 'supersede');
      assert.equal(useViewerStore.getState().compareRunning, false);
      if (action === 'supersede') assert.equal(creates.mock.callCount(), 4);
    });
  }

  it('discards every stale retry, including the final failed attempt', async () => {
    const original = createModel;
    let count = 0;
    creates.mock.mockImplementation((...args) => {
      if (++count % 2 === 1) queueMicrotask(() => useViewerStore.getState().bumpGeometryContentVersion());
      return original(...args);
    });
    await act(async () => { await hook.runComparison(); });
    assert.match(useViewerStore.getState().compareError ?? '', /geometry kept changing/);
    assert.equal(creates.mock.callCount(), 6);
    assert.equal(frees.mock.callCount(), 6);
  });

  it('rolls back the base handle if head preparation throws', async () => {
    creates.mock.mockImplementationOnce(() => { throw new Error('head allocation failed'); }, 1);
    await act(async () => { await hook.runComparison(); });
    assert.match(useViewerStore.getState().compareError ?? '', /head allocation failed/);
    assert.equal(creates.mock.callCount(), 2);
    assert.equal(frees.mock.callCount(), 1);
  });
});
