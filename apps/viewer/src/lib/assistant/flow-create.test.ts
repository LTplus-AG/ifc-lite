/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runFlow, TRACKING_SIDECAR_VERSION, type FlowDocument } from '@ifc-lite/flow';
import { createBimContext } from '@ifc-lite/sdk';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { newFlowDocument } from '../flow/persistence';
import { flowRegistry } from '../flow/runner';
import { captureEvidence } from './evidence';
import { parseFlowCreate } from './flow-create-envelope';
import { prepareFlowCreateProposal, applyFlowCreateProposal, canRemoveCreatedFlow, removeCreatedFlow } from './flow-create';
import { prepareFlowProposal, applyFlowProposal } from './flow-proposal';
import { preflightOpenFlow } from './flow-preflight';
import { trackingImpacts } from './flow-tracking';

const initial = useViewerStore.getState();
afterEach(() => { useViewerStore.setState(initial, true); localStorage.clear(); });
const envelope = (nodes: unknown[], edges: unknown[] = [], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, kind: 'flow.create', name: 'Sum', nodes, edges, ...extra });
const sum = envelope([
  { id: 'a', type: 'core.number', params: { value: 7 } }, { id: 'b', type: 'core.number', params: { value: 5 } },
  { id: 'sum', type: 'core.math', params: { op: 'add' } },
], [{ from: ['a', 'value'], to: ['sum', 'a'] }, { from: ['b', 'value'], to: ['sum', 'b'] }], { outputs: [{ nodeId: 'sum', port: 'result', label: 'Total' }] });

test('#6919 created graphs are checked against the native registry, wiring and cycles', () => {
  const evidence = captureEvidence('flow');
  for (const [text, message] of [
    [envelope([{ id: 'x', type: 'invented.magic' }]), /Unknown node type/],
    [envelope([{ id: 'x', type: 'core.number', params: { made: 1 } }]), /Unknown native parameter/],
    [envelope([{ id: 'x', type: 'core.number', params: { value: 'seven' } }]), /Invalid number parameter/],
    [envelope([{ id: 'x', type: 'core.number' }, { id: 'm', type: 'core.math', params: { op: 'explode' } }]), /Invalid enum parameter/],
    [envelope([{ id: 'x', type: 'core.number' }, { id: 'x', type: 'core.number' }]), /Duplicate node id/],
    [envelope([{ id: 'm', type: 'core.math' }]), /required input "a"/],
    [envelope([{ id: 'w', type: 'model.byType' }, { id: 'm', type: 'core.math' }], [{ from: ['w', 'entities'], to: ['m', 'a'] }]), /cannot feed|required input/],
    [envelope([{ id: 'n', type: 'core.number' }, { id: 'p', type: 'core.math' }, { id: 'q', type: 'core.math' }],
      [{ from: ['n', 'value'], to: ['p', 'a'] }, { from: ['q', 'result'], to: ['p', 'b'] }, { from: ['p', 'result'], to: ['q', 'a'] }, { from: ['n', 'value'], to: ['q', 'b'] }]), /cycle/],
  ] as const) assert.throws(() => prepareFlowCreateProposal(text, evidence), message);
  assert.throws(() => parseFlowCreate(envelope([{ id: 'x', type: 'core.number', run: 'globalThis.pwned=1' }])), /Invalid Flow create node/);
  assert.throws(() => parseFlowCreate(envelope([{ id: '__proto__', type: 'core.number' }])), /Invalid Flow create node/);
  assert.throws(() => parseFlowCreate(envelope([{ id: 'x', type: 'core.number' }], [], { execute: true })), /envelope/);
  assert.equal(useViewerStore.getState().savedFlows.length, 0);
});

test('#6919 a reviewed create saves a new graph, never overwrites or discards edits, and runs natively', async () => {
  const open = { ...newFlowDocument('Open graph'), nodes: [{ id: 'n', type: 'core.number' }] };
  useViewerStore.setState({ savedFlows: [{ doc: open, updatedAt: 1 }], activeFlowId: open.id, flowDoc: open, flowDirty: true });
  const proposal = prepareFlowCreateProposal(sum, captureEvidence('flow'));
  assert.throws(() => applyFlowCreateProposal({ ...proposal, capabilities: ['network.fetch:any'] }, proposal.digest), /proposal has changed/);
  assert.throws(() => applyFlowCreateProposal(proposal, proposal.digest), /Save or discard the open graph/);
  useViewerStore.setState({ flowDirty: false });
  const receipt = applyFlowCreateProposal(proposal, proposal.digest);
  const state = useViewerStore.getState();
  assert.equal(state.savedFlows.length, 2);
  assert.equal(state.savedFlows[0].doc, open);
  assert.equal(state.flowDoc, receipt.created);
  assert.notEqual(receipt.flowId, JSON.parse(proposal.docJson).id, 'apply assigns a fresh identity');
  assert.deepEqual(receipt.created.capabilities, []);
  assert.ok(receipt.created.nodes.every(node => node.pos), 'native positions are laid out');
  const bim = createBimContext({ transport: { send: async () => { throw new Error('Pure graph must not reach the SDK'); },
    subscribe: () => () => undefined, close: () => undefined } });
  const run = await runFlow(receipt.created, { host: { bim }, registry: flowRegistry() });
  assert.deepEqual(run.graphOutputs.map(output => output.data), [{ kind: 'item', value: 12 }]);

  assert.equal(canRemoveCreatedFlow(receipt), true);
  localStorage.setItem(`ifc-lite-flow-tracking:${receipt.flowId}`, JSON.stringify({ version: TRACKING_SIDECAR_VERSION, pinnedTo: 'p', sets: {} }));
  assert.throws(() => removeCreatedFlow(receipt), /edited or run/);
  localStorage.clear();
  removeCreatedFlow(receipt);
  assert.deepEqual(useViewerStore.getState().savedFlows.map(flow => flow.doc), [open]);
});

test('#6919 renaming the graph or switching tracking mode is a tracked-element effect', () => {
  const base: FlowDocument = { ...newFlowDocument('Columns'), nodes: [{ id: 'add', type: 'model.addElement' }, { id: 'keyed', type: 'model.addElement', trackingKey: 'fixed/key' }] };
  assert.deepEqual(trackingImpacts(base, { ...base, name: 'Renamed' }).map(i => [i.nodeId, i.effect, i.nextTrackingKey]),
    [['add', 'rekeyed', 'Renamed/add']], 'an explicit tracking key keeps its owned elements');
  assert.deepEqual(trackingImpacts(base, { ...base, nodes: [{ ...base.nodes[0], tracking: 'replace' }, base.nodes[1]] }).map(i => [i.nodeId, i.effect, i.mode]),
    [['add', 'mode', 'replace']]);
  assert.deepEqual(trackingImpacts(base, { ...base, nodes: base.nodes.map(node => ({ ...node, pos: [5, 5] as const })) }), [], 'moving nodes changes nothing owned');
});

test('#6919 preflight reports native refusals without running', async () => {
  const doc = { ...newFlowDocument('Needs a model'), capabilities: ['model.read'], nodes: [{ id: 'w', type: 'model.byType', params: { type: 'IfcWall' } }] };
  useViewerStore.setState({ flowDoc: doc, activeFlowId: doc.id });
  assert.deepEqual((await preflightOpenFlow()).problems, ['Load a model before running this graph']);
  useViewerStore.setState({ ...fixtureModels(fixtureModel('m')), flowDoc: { ...doc, capabilities: [] } });
  const denied = await preflightOpenFlow();
  assert.equal(denied.ok, false);
  assert.match(denied.problems.join(' '), /capability denied: model\.read/);
  useViewerStore.setState({ flowDoc: { ...doc, nodes: [{ id: 'r', type: 'http.request', params: { url: 'https://x/?t={{secret:TOKEN}}' } }] } });
  assert.match((await preflightOpenFlow()).problems.join(' '), /Secrets are never available in the viewer: TOKEN/);
  // A graph that edits the model would fail every write lane while Edit mode is off.
  const writer = { ...doc, capabilities: ['model.create'], nodes: [{ id: 'add', type: 'model.addElement' }] };
  useViewerStore.setState({ flowDoc: writer, editEnabled: false });
  assert.match((await preflightOpenFlow()).problems.join(' '), /add edits the model: Turn on Edit mode before changing a model/);
  useViewerStore.setState({ editEnabled: true });
  assert.doesNotMatch((await preflightOpenFlow()).problems.join(' '), /Edit mode/);
  assert.equal(useViewerStore.getState().flowLastRun, null);
});

test('#6919 a debug diagnosis needs a captured run', () => {
  const doc = { ...newFlowDocument('Unrun'), nodes: [{ id: 'n', type: 'core.number' }] };
  useViewerStore.setState({ flowDoc: doc, activeFlowId: doc.id });
  assert.throws(() => prepareFlowProposal(JSON.stringify({ version: 1, kind: 'flow.patch', operations: [{ op: 'setParam', node: 'n', param: 'value', value: 1 }],
    diagnosis: { nodes: ['n'], explanation: 'guess' } }), captureEvidence('flow')), /need a captured Flow run/);
});

test('#6919 owned elements recorded after review (another tab ran the graph) refuse apply', () => {
  const doc: FlowDocument = { ...newFlowDocument('Columns'), nodes: [{ id: 'add', type: 'model.addElement' }] };
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m'), sourceContentHash: 'h' }), flowDoc: doc, activeFlowId: doc.id });
  const sidecar = (count: number) => localStorage.setItem(`ifc-lite-flow-tracking:${doc.id}`, JSON.stringify({ version: TRACKING_SIDECAR_VERSION, pinnedTo: 'content:h',
    sets: { 'Columns/add': { trackingKey: 'Columns/add', generation: 0, entries: Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, { globalId: `g${i}`, digest: 'd' }])) } } }));
  sidecar(1);
  const proposal = prepareFlowProposal(JSON.stringify({ version: 1, kind: 'flow.patch', operations: [{ op: 'removeNode', node: 'add' }] }), captureEvidence('flow'));
  assert.equal(proposal.tracking[0].ownedElements, 1);
  sidecar(4);
  assert.throws(() => applyFlowProposal(proposal, proposal.digest, { trackingAcknowledged: true }), /Tracked elements changed after review/);
  assert.equal(useViewerStore.getState().flowDoc, doc);
});
