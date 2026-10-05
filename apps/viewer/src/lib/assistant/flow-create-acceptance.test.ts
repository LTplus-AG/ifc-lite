/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6919 acceptance on the committed `building-architecture.ifc` sample: a
 * reviewed `flow.create` becomes a new saved graph beside an existing one,
 * preflight and a native run create the described columns, and a text-typed
 * proposal fails natively and is repaired by a cited debug patch.
 */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MemoCache, countItems } from '@ifc-lite/flow';
import { useViewerStore } from '@/store';
import { columnGraph, openFlowSample, runOpenFlow, sampleColumns } from '@/test/flow-sample-fixture';
import { captureEvidence } from './evidence';
import { prepareFlowCreateProposal, applyFlowCreateProposal } from './flow-create';
import { prepareFlowProposal, applyFlowProposal } from './flow-proposal';
import { preflightOpenFlow } from './flow-preflight';
import { flowRunDiagnostics } from './flow-run-evidence';

const initial = useViewerStore.getState();
afterEach(() => { useViewerStore.setState(initial, true); localStorage.clear(); });
const create = (xs: unknown[]) => JSON.stringify({ version: 1, kind: 'flow.create', ...columnGraph(xs) });

test('#6919 a created graph is saved beside the existing one, preflighted and run natively', async () => {
  const model = await openFlowSample();
  const existing = useViewerStore.getState().flowDoc!;
  assert.deepEqual(sampleColumns(model), []);
  const proposal = prepareFlowCreateProposal(create([0, 4, 8]), captureEvidence('flow'));
  assert.deepEqual(proposal.capabilities, ['model.create', 'model.read']);
  assert.deepEqual(proposal.unavailable, []);
  assert.deepEqual(proposal.tracking.map(impact => [impact.nodeId, impact.effect, impact.trackingKey]), [['add', 'added', 'Columns along X/add']]);
  const created = applyFlowCreateProposal(proposal, proposal.digest);
  const state = useViewerStore.getState();
  assert.notEqual(created.flowId, existing.id);
  assert.equal(state.activeFlowId, created.flowId);
  assert.deepEqual(state.savedFlows.map(flow => flow.doc), [existing, created.created], 'the existing graph is never replaced');
  assert.equal(state.flowLastRun, null, 'creating never runs the graph');

  useViewerStore.setState({ editEnabled: false });
  assert.deepEqual(await preflightOpenFlow().then(result => result.problems), ['add edits the model: Turn on Edit mode before changing a model']);
  useViewerStore.setState({ editEnabled: true });
  assert.deepEqual(await preflightOpenFlow().then(result => result.problems), []);
  const first = await runOpenFlow(model, new MemoCache());
  assert.equal(first.ok, true);
  assert.equal(sampleColumns(model).length, 3);
  assert.equal(countItems(first.graphOutputs[0].data!), 3);
  assert.deepEqual(first.reports.find(report => report.nodeId === 'add')?.tracking, { created: 3, updated: 0, kept: 0, removed: 0 });
});

test('#6919 a created graph with text positions fails natively and a cited debug patch repairs it', async () => {
  const model = await openFlowSample();
  const proposal = prepareFlowCreateProposal(create(['0', '4', '8']), captureEvidence('flow'));
  applyFlowCreateProposal(proposal, proposal.digest);
  const cache = new MemoCache();
  await runOpenFlow(model, cache);
  assert.deepEqual(sampleColumns(model), []);
  assert.equal(flowRunDiagnostics(useViewerStore.getState())!.verdict, 'lane-errors');
  const fix = JSON.stringify({ version: 1, kind: 'flow.patch', operations: [{ op: 'setParam', node: 'xs', param: 'items', value: [0, 4, 8] }],
    diagnosis: { nodes: ['pt'], explanation: 'The X positions are text.' } });
  const debug = prepareFlowProposal(fix, captureEvidence('flow'));
  applyFlowProposal(debug, debug.digest, { trackingAcknowledged: true });
  const passed = await runOpenFlow(model, cache);
  assert.equal(passed.ok, true);
  assert.equal(sampleColumns(model).length, 3);
});
