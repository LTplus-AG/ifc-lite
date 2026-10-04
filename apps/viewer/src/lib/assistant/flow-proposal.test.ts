/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runFlow, type FlowDocument } from '@ifc-lite/flow';
import { createBimContext } from '@ifc-lite/sdk';
import { useViewerStore } from '@/store';
import { newFlowDocument } from '../flow/persistence';
import { flowRegistry } from '../flow/runner';
import { captureEvidence } from './evidence';
import { parseFlowPatch } from './flow-patch';
import { prepareFlowProposal, applyFlowProposal, undoFlowProposal } from './flow-proposal';

const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));
const patch = (operations: unknown[]) => JSON.stringify({ version: 1, kind: 'flow.patch', operations });
function open() {
  const doc = newFlowDocument('Coordinator workflow');
  useViewerStore.setState({ flowDoc: doc, activeFlowId: doc.id, flowRunning: false });
  return captureEvidence('flow');
}
const addition = [
  { op: 'addNode', alias: 'input-a', type: 'core.number', pos: [0, 0] },
  { op: 'setParam', node: 'input-a', param: 'value', value: 7 },
  { op: 'addNode', alias: 'input-b', type: 'core.number', pos: [0, 100] },
  { op: 'setParam', node: 'input-b', param: 'value', value: 5 },
  { op: 'addNode', alias: 'sum', type: 'core.math', pos: [200, 50] },
  { op: 'connect', from: ['input-a', 'value'], to: ['sum', 'a'] },
  { op: 'connect', from: ['input-b', 'value'], to: ['sum', 'b'] },
];

// #6822: real standard registry and native operations, no mocked graph execution.
test('native math graph preview is inert, reviewed apply changes only the graph and undo restores the original', async () => {
  const evidence = open(), before = useViewerStore.getState().flowDoc;
  const mutation = useViewerStore.getState().mutationVersion;
  const proposal = prepareFlowProposal(patch(addition), evidence);
  assert.equal(useViewerStore.getState().flowDoc, before);
  const candidate: FlowDocument = JSON.parse(proposal.afterJson);
  assert.equal(candidate.nodes.length, 3);
  assert.equal(candidate.edges.length, 2);
  assert.equal(candidate.nodes[0].params?.value, 7);
  assert.equal(flowRegistry().get(candidate.nodes[2].type)?.type, 'core.math');
  const bim = createBimContext({ transport: {
    send: async () => { throw new Error('Pure graph must not perform SDK requests'); },
    subscribe: () => () => undefined, close: () => undefined,
  } });
  const nativeRun = await runFlow(candidate, { host: { bim }, registry: flowRegistry() });
  assert.equal(nativeRun.ok, true);
  assert.deepEqual(nativeRun.outputs.get('math-1')?.get('result'), { kind: 'item', value: 12 });
  const receipt = applyFlowProposal(proposal, proposal.digest);
  assert.equal(useViewerStore.getState().flowDoc, receipt.applied);
  assert.equal(useViewerStore.getState().flowLastRun, null);
  assert.equal(useViewerStore.getState().mutationVersion, mutation);
  assert.equal(useViewerStore.getState().flowDirty, true);
  assert.throws(() => applyFlowProposal(proposal, proposal.digest), /changed after review/);
  undoFlowProposal(receipt);
  assert.equal(useViewerStore.getState().flowDoc, before);
});

test('native validation rejects unknown contracts, incompatible edges, missing required inputs and malformed parameters', () => {
  const evidence = open();
  for (const operations of [
    [{ op: 'addNode', alias: 'made-up', type: 'invented.magic', pos: [0, 0] }],
    [{ op: 'addNode', alias: 'math', type: 'core.math', pos: [0, 0] }],
    [...addition, { op: 'setParam', node: 'sum', param: 'madeUp', value: 1 }],
    [...addition, { op: 'setParam', node: 'sum', param: 'op', value: 'explode' }],
    [...addition, { op: 'setParam', node: 'input-a', param: 'value', value: 'not a number' }],
    [...addition, { op: 'connect', from: ['sum', 'result'], to: ['sum', 'a'] }],
    [...addition, { op: 'connect', from: ['input-a', 'Name'], to: ['sum', 'a'] }],
  ]) assert.throws(() => prepareFlowProposal(patch(operations), evidence));
  assert.equal(useViewerStore.getState().flowDoc?.nodes.length, 0);
});

test('changed model, changed graph, tampered manifest and later native edits refuse apply or undo', () => {
  const evidence = open(), proposal = prepareFlowProposal(patch(addition), evidence);
  assert.throws(() => applyFlowProposal({ ...proposal, addedCapabilities: ['network.fetch:any'] }, proposal.digest), /proposal has changed/);
  useViewerStore.setState({ mutationVersion: initial.mutationVersion + 1 });
  assert.throws(() => applyFlowProposal(proposal, proposal.digest), /changed after review/);
  useViewerStore.setState({ mutationVersion: initial.mutationVersion });
  const receipt = applyFlowProposal(proposal, proposal.digest);
  useViewerStore.getState().setFlowDoc({ ...receipt.applied, name: 'Later manual edit' });
  assert.throws(() => undoFlowProposal(receipt), /undo was refused/);
  assert.equal(useViewerStore.getState().flowDoc?.name, 'Later manual edit');
});

test('untrusted envelope bounds and prototype keys cannot become native patch operations', () => {
  assert.throws(() => parseFlowPatch('```javascript\nglobalThis.executed=true\n```'));
  assert.throws(() => parseFlowPatch(patch(Array.from({ length: 51 }, () => ({ op: 'rename', name: 'Too many' })))));
  assert.throws(() => parseFlowPatch('{"version":1,"kind":"flow.patch","operations":[{"op":"setParam","node":"n","param":"__proto__","value":{"__proto__":{"pwned":true}}}]}'));
  assert.throws(() => parseFlowPatch(patch([{ op: 'rename', name: 'okay', execute: true }])));
  assert.throws(() => parseFlowPatch('{"version":1,"kind":"flow.patch","operations":[{"op":"setParam","node":"n","param":"value","value":1e9999}]}'));
  assert.equal('pwned' in {}, false);
});

test('additional native capabilities are visible and extension-owned or running graphs stay read-only', () => {
  const evidence = open();
  const proposal = prepareFlowProposal(patch([{ op: 'addNode', alias: 'walls', type: 'model.byType', pos: [0, 0] },
    { op: 'setParam', node: 'walls', param: 'type', value: 'IfcWall' }]), evidence);
  assert.deepEqual(proposal.addedCapabilities, ['model.read']);
  assert.deepEqual(JSON.parse(proposal.afterJson).capabilities, ['model.read']);
  useViewerStore.setState({ flowRunning: true });
  assert.throws(() => applyFlowProposal(proposal, proposal.digest), /changed after review/);
  const extension = { ...newFlowDocument('Extension workflow'), id: 'ext:review-test:graph' };
  useViewerStore.setState({ flowRunning: false, flowDoc: extension, activeFlowId: null });
  assert.throws(() => prepareFlowProposal(patch([{ op: 'rename', name: 'Forbidden edit' }]), captureEvidence('flow')), /read-only/);
});
