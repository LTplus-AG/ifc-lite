/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6919 acceptance on the committed `building-architecture.ifc` sample: a run
 * with lane errors is diagnosed from the captured native run, a debug patch
 * citing the failing node fixes it and the rerun passes; reviewed patches then
 * edit the tracked branch and delete the tracked node, and each rerun's native
 * tracking reports and IFC columns are asserted.
 */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MemoCache } from '@ifc-lite/flow';
import { useViewerStore } from '@/store';
import { columnGraph, openFlowSample, runOpenFlow, sampleColumns } from '@/test/flow-sample-fixture';
import { newFlowDocument } from '../flow/persistence';
import { flowRegistry } from '../flow/runner';
import { requiredCapabilities } from '../flow/editor-ops';
import { captureEvidence } from './evidence';
import { prepareFlowProposal, applyFlowProposal } from './flow-proposal';
import { preflightOpenFlow } from './flow-preflight';
import { flowRunDiagnostics } from './flow-run-evidence';

const initial = useViewerStore.getState();
afterEach(() => { useViewerStore.setState(initial, true); localStorage.clear(); });
const patch = (operations: unknown[], diagnosis?: unknown) => JSON.stringify({ version: 1, kind: 'flow.patch', operations, ...diagnosis ? { diagnosis } : {} });

/** Saves and opens the column graph as a coordinator would from Flow's own library. */
function openColumnGraph(xs: unknown[]): void {
  const graph = { ...newFlowDocument('Columns along X'), ...columnGraph(xs) };
  const doc = { ...graph, capabilities: requiredCapabilities(graph, flowRegistry()) };
  if (!useViewerStore.getState().importFlow(doc)) throw new Error('Native Flow library refused the graph');
}

test('#6919 lane errors are diagnosed from the native run and a cited debug patch makes the rerun pass', async () => {
  const model = await openFlowSample();
  openColumnGraph(['0', '4', '8']);
  const cache = new MemoCache();
  const failed = await runOpenFlow(model, cache);
  assert.deepEqual(sampleColumns(model), []);
  const diagnostics = flowRunDiagnostics(useViewerStore.getState())!;
  assert.equal(failed.ok, true, 'the scheduler reports lane errors without failing the run');
  assert.equal(diagnostics.verdict, 'lane-errors');
  const pt = diagnostics.nodes.find(node => node.nodeId === 'pt')!;
  assert.equal(pt.laneErrors, 3);
  assert.match(pt.errorMessages[0], /"x" must be a finite number/);

  // The run is discussed through the `flowRun` adapter; graph-structure evidence cannot support a diagnosis.
  const fix = [{ op: 'setParam', node: 'xs', param: 'items', value: [0, 4, 8] }];
  assert.throws(() => prepareFlowProposal(patch(fix, { nodes: ['pt'], explanation: 'strings' }), captureEvidence('flow')), /need a captured Flow run/);
  const evidence = captureEvidence('flowRun');
  const payload = JSON.parse(evidence.payload).evidence as { summary: { verdict: string; failingNodeIds: string[] };
    rows: Array<{ data: { kind: string; nodeId?: string; params?: unknown; inputs?: unknown } }> };
  assert.equal(payload.summary.verdict, 'lane-errors');
  assert.deepEqual(payload.summary.failingNodeIds, ['pt']);
  const nodeRow = (id: string) => payload.rows.find(row => row.data.kind === 'nodeResult' && row.data.nodeId === id)!.data;
  assert.deepEqual(nodeRow('xs').params, { items: ['0', '4', '8'] }, 'inputs of the failing node are visible');
  assert.deepEqual(nodeRow('pt').inputs, [{ port: 'x', from: ['xs', 'items'] }, { port: 'y', from: ['y', 'value'] }], 'the failing node names what feeds it');
  assert.equal(nodeRow('column').params, undefined, 'unrelated parameters stay out of the prompt');

  assert.throws(() => prepareFlowProposal(patch(fix, { nodes: ['y'], explanation: 'y is wrong' }), evidence), /did not fail/);
  assert.throws(() => prepareFlowProposal(patch([{ op: 'setParam', node: 'column', param: 'width', value: 0.4 }],
    { nodes: ['pt'], explanation: 'wider columns' }), evidence), /does not change the failing nodes/);
  const debug = prepareFlowProposal(patch(fix, { nodes: ['pt'], explanation: 'The X positions are strings; geometry.point needs numbers.' }), evidence);
  assert.deepEqual(debug.diagnosis?.nodes.map(node => [node.nodeId, node.laneErrors]), [['pt', 3]]);
  assert.match(debug.diagnosis!.nodes[0].messages[0], /must be a finite number/);
  assert.deepEqual(debug.tracking.map(impact => [impact.nodeId, impact.effect]), [['add', 'branch']]);
  applyFlowProposal(debug, debug.digest, { trackingAcknowledged: true });

  useViewerStore.setState({ editEnabled: false });
  assert.deepEqual(await preflightOpenFlow().then(result => result.problems), ['add edits the model: Turn on Edit mode before changing a model']);
  useViewerStore.setState({ editEnabled: true });
  assert.deepEqual(await preflightOpenFlow().then(result => result.problems), []);
  const passed = await runOpenFlow(model, cache);
  assert.equal(passed.ok, true);
  assert.equal(passed.reports.reduce((sum, report) => sum + report.laneErrors, 0), 0);
  assert.equal(sampleColumns(model).length, 3);
  assert.ok(!['failed', 'lane-errors'].includes(flowRunDiagnostics(useViewerStore.getState())!.verdict));
  // Run evidence is stale once another run of the same, unchanged graph replaces it.
  const ofPassedRun = captureEvidence('flowRun');
  await runOpenFlow(model, cache);
  assert.throws(() => prepareFlowProposal(patch([{ op: 'rename', name: 'Columns' }]), ofPassedRun), /stale/);
});

test('#6919 reviewed edits of a tracked branch and deletion of the tracked node, rerun each time', async () => {
  const model = await openFlowSample();
  const existing = useViewerStore.getState().flowDoc!;
  openColumnGraph([0, 4, 8]);
  const cache = new MemoCache();
  const first = await runOpenFlow(model, cache);
  assert.equal(first.ok, true);
  const owned = sampleColumns(model);
  assert.equal(owned.length, 3);
  assert.deepEqual(first.reports.find(report => report.nodeId === 'add')?.tracking, { created: 3, updated: 0, kept: 0, removed: 0 });

  // Editing an input of the tracked node: three owned elements, and acknowledgement is mandatory.
  const shorten = prepareFlowProposal(patch([{ op: 'setParam', node: 'xs', param: 'items', value: [0, 4] }]), captureEvidence('flow'));
  assert.deepEqual(shorten.tracking, [{ nodeId: 'add', trackingKey: 'Columns along X/add', ownedElements: 3, effect: 'branch' }]);
  assert.throws(() => applyFlowProposal(shorten, shorten.digest), /must be acknowledged/);
  applyFlowProposal(shorten, shorten.digest, { trackingAcknowledged: true });
  const second = await runOpenFlow(model, cache);
  assert.equal(second.ok, true);
  assert.deepEqual(second.reports.find(report => report.nodeId === 'add')?.tracking, { created: 0, updated: 0, kept: 2, removed: 1 });
  assert.deepEqual(sampleColumns(model), owned.slice(0, 2), 'kept elements keep their GlobalIds');

  // Deleting the tracked node: the native orphan sweep removes what it owned.
  const remove = prepareFlowProposal(patch([{ op: 'removeNode', node: 'add' }]), captureEvidence('flow'));
  assert.deepEqual(remove.tracking, [{ nodeId: 'add', trackingKey: 'Columns along X/add', ownedElements: 2, effect: 'removed' }]);
  applyFlowProposal(remove, remove.digest, { trackingAcknowledged: true });
  const third = await runOpenFlow(model, cache);
  assert.equal(third.ok, true);
  assert.deepEqual(sampleColumns(model), []);
  assert.ok(third.log.some(entry => /removed 2 element\(s\) of deleted node "Columns along X\/add"/.test(entry.message)));
  assert.equal(useViewerStore.getState().savedFlows[0].doc, existing, 'the other saved graph was never touched');
});
