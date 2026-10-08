/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import '@/test/content-fixture';
import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import { act } from 'react';
import type { FlowDocument } from '@ifc-lite/flow';
import { BimProvider } from '@/sdk/BimProvider';
import { useViewerStore } from '@/store';
import { render, cleanup } from '@/test/render';
import { snapshotComparison } from '@/lib/compare/savedComparisons';
import { comparisonModels, comparisonResult } from '@/test/saved-comparison-fixture';
import { flowRegistry } from '@/lib/flow/runner';
import { isNativeWorkflowBusy } from '@/lib/flow/run-session';
import { activityCanceller, useActivityJournal } from '@/lib/activity/activity-journal';
import { resetActivityRecordersForTest, startActivityRecorders } from '@/lib/activity/activity-recorders';
import { useFlowRunner } from './useFlowRunner';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
let entered = deferred(), settle = deferred();
let nodeSignal: AbortSignal | undefined;
let api: ReturnType<typeof useFlowRunner> | undefined;
let stopRecorders: () => void = () => {};
const initial = useViewerStore.getState();
const DELAY = 'report.testWorkflowDelay6612';
before(() => {
  flowRegistry().register({ type: DELAY, title: 'Delayed completion', category: 'test', params: [], capabilities: [], volatile: true,
    inputs: [{ name: 'reports', type: { kind: 'scalar', access: 'item' } }],
    outputs: [{ name: 'reports', type: { kind: 'scalar', access: 'item' } }],
    run: async (context, inputs) => {
      nodeSignal = context.signal;
      entered.resolve();
      // Deliberately non-abortable: the lease must remain owned until this
      // settles, and the old result must not activate dependent PDF work.
      await settle.promise;
      return { reports: inputs.reports };
    },
  });
});
function Probe() { api = useFlowRunner(); return null; }
function graph(): FlowDocument {
  return { flowVersion: 2, id: 'lifecycle', name: 'Historical workflow',
    capabilities: ['storage.write:savedComparisons', 'storage.write:documents', 'export.create:pdf'],
    inputs: [{ nodeId: 'import', param: 'files', label: 'Saved evidence', kind: 'files', fileSlots: [
      { id: 'reports', label: 'Completed reports', accept: '.json', multiple: true, required: true },
    ] }], nodes: [
      { id: 'import', type: 'report.importComparisons' }, { id: 'delay', type: DELAY },
      { id: 'document', type: 'report.buildDocument' }, { id: 'pdf', type: 'report.exportPdf' },
    ], edges: [
      { from: ['import', 'reports'], to: ['delay', 'reports'] },
      { from: ['delay', 'reports'], to: ['document', 'historical'] },
      { from: ['document', 'document'], to: ['pdf', 'document'] },
    ], outputs: [{ nodeId: 'pdf', port: 'artifact', label: 'PDF' }],
  };
}
function selections() {
  const report = snapshotComparison(comparisonResult('A', 'B'), comparisonModels(), 'Original evidence');
  return { 'import.files': { reports: [new File([JSON.stringify(report)], 'comparison.json')] } };
}
beforeEach(() => {
  entered = deferred(); settle = deferred(); nodeSignal = undefined; api = undefined;
  useViewerStore.setState({ ...initial, models: new Map(), activeModelId: null, flowDoc: graph(), flowRunning: false,
    flowLastRun: null, flowLastError: null, flowArtifacts: [], savedComparisons: [], documents: [], undoStacks: new Map(),
  });
  resetActivityRecordersForTest();
  stopRecorders = startActivityRecorders(useViewerStore);
  render(<BimProvider><Probe /></BimProvider>);
});
afterEach(() => {
  settle.resolve();
  cleanup();
  stopRecorders();
  useViewerStore.setState(initial);
});

describe('mounted workflow run ownership (#6612)', () => {
  it('#7122 a retained Activity callback cannot cancel the next native historical workflow', async t => {
    let pending!: Promise<void>;
    t.after(async () => { settle.resolve(); await pending; });
    await act(async () => { pending = api!.run(selections()); await entered.promise; });
    const first = useActivityJournal.getState().jobs.find(job => job.kind === 'flow');
    assert.ok(first);
    const retainedCancel = activityCanceller(first.id);
    assert.ok(retainedCancel);
    act(() => retainedCancel());
    assert.equal(nodeSignal?.aborted, true);
    await act(async () => { settle.resolve(); await pending; });
    assert.equal(activityCanceller(first.id), null, 'terminal journal releases its stored callback');
    assert.equal(isNativeWorkflowBusy(), false, 'native cancelled work finished draining');

    entered = deferred(); settle = deferred(); nodeSignal = undefined;
    await act(async () => { pending = api!.run(selections()); await entered.promise; });
    assert.ok(useViewerStore.getState().savedComparisons.length > 0, 'native history import executed');
    act(() => retainedCancel());
    assert.equal(nodeSignal?.aborted, false, 'old callback cannot abort the new scheduler signal');
    assert.equal(isNativeWorkflowBusy(), true);
    const second = useActivityJournal.getState().jobs.find(job => job.kind === 'flow' && job.id !== first.id);
    assert.ok(second);
    const cancelCurrent = activityCanceller(second.id);
    assert.ok(cancelCurrent);
    act(() => cancelCurrent());
    assert.equal(nodeSignal?.aborted, true, 'current Activity row still aborts actual native work');
    await act(async () => { settle.resolve(); await pending; });
    assert.equal(isNativeWorkflowBusy(), false);
    assert.equal(useViewerStore.getState().documents.length, 0, 'cancelled import must not activate dependent document/PDF effects');
    assert.equal(useViewerStore.getState().flowArtifacts.length, 0);
    assert.equal(activityCanceller(second.id), null);
    assert.ok(useActivityJournal.getState().jobs.filter(job => job.kind === 'flow').every(job => job.outcome === 'cancelled'));
  });

  it('can start historical evidence from an empty session and drains same-ID graph edit cancellation without publishing a PDF', async () => {
    assert.ok(api);
    assert.equal(api.canRun, true, 'historical workflows require no active IFC model');
    let pending!: Promise<void>;
    await act(async () => { pending = api!.run(selections()); await entered.promise; });
    assert.equal(useViewerStore.getState().savedComparisons.length, 1, 'native history import really executed before the delayed node');
    assert.equal(isNativeWorkflowBusy(), true);
    const current = useViewerStore.getState().flowDoc;
    assert.ok(current);
    act(() => useViewerStore.getState().setFlowDoc({ ...current, name: 'Edited same graph' }));
    assert.equal(nodeSignal?.aborted, true);
    assert.equal(isNativeWorkflowBusy(), true, 'cancellation owns the lease while non-abortable work drains');
    assert.equal(api?.canRun, false);
    await act(async () => { settle.resolve(); await pending; });
    const state = useViewerStore.getState();
    assert.equal(state.flowLastRun, null, 'the old graph generation must not publish its result');
    assert.equal(state.flowArtifacts.length, 0);
    assert.equal(state.documents.length, 0, 'dependent document creation must never start after cancellation');
    assert.equal(state.flowRunning, false);
    assert.equal(isNativeWorkflowBusy(), false);
  });

  it('graph close and component unmount still cancel and drain the session-owned run', async () => {
    let pending!: Promise<void>;
    await act(async () => { pending = api!.run(selections()); await entered.promise; });
    act(() => useViewerStore.getState().closeFlow());
    cleanup();
    assert.equal(nodeSignal?.aborted, true);
    assert.equal(isNativeWorkflowBusy(), true);
    await act(async () => { settle.resolve(); await pending; });
    assert.equal(useViewerStore.getState().flowDoc, null);
    assert.equal(useViewerStore.getState().flowArtifacts.length, 0);
    assert.equal(isNativeWorkflowBusy(), false);
  });
});
