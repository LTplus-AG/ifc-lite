/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { countItems, migrateFlowDocument, validateFlowDocument, type FlowDocument } from '@ifc-lite/flow';
import { useViewerStore } from '@/store';
import { openFlowSample } from '@/test/flow-sample-fixture';
import { render, click, type, cleanup, advance } from '@/test/render';
import { BimReactContext } from '@/sdk/BimProvider';
import { FlowPlayer } from '@/components/viewer/flow/FlowPlayer';
import { flowRegistry, viewerFlowFeatures } from '@/lib/flow/runner';
import { flowToJson, loadSavedFlows, newFlowDocument } from '@/lib/flow/persistence';
import { toggleInput } from '@/lib/flow/editor-ops';
import { playerFields } from '@/lib/flow/player-fields';
import { captureEvidence } from './evidence';
import { prepareFlowCreateProposal, applyFlowCreateProposal } from './flow-create';
import { preflightOpenFlow } from './flow-preflight';
import { replaceEvidence, useAssistant, cancelAssistant } from './conversation';
import { FlowCreateReview, useFlowCreateReview } from '@/components/viewer/assistant/FlowCreateReview';
import { preflightWorkflow } from '@/lib/flow/preflight';
import { startWorkflowRun } from '@/lib/flow/run-session';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); cancelAssistant(); useViewerStore.setState(initial, true); localStorage.clear();
  useFlowCreateReview.setState({ proposal: null, receipt: null, approved: false, error: null }); });
const graph = {
  name: 'Count chosen IFC type', nodes: [{ id: 'query', type: 'model.byType', params: { type: 'IfcWall' } }], edges: [],
  outputs: [{ nodeId: 'query', port: 'entities', label: 'Matching elements' }],
};
const exposed = { nodeId: 'query', param: 'type', label: 'IFC type', kind: 'scalar' };
const envelope = (inputs: unknown) => JSON.stringify({ version: 1, kind: 'flow.create', ...graph, inputs });

test('#7241 reviewed creation retains native Player inputs through Save, export and reload; configured Player queries real IFC', async () => {
  const model = await openFlowSample();
  assert.equal(model.bim.query().byType('IfcWall').toArray().length, 4);
  assert.equal(model.bim.query().byType('IfcSlab').toArray().length, 3);
  // Native editor exposure is valid before the Assistant protocol is exercised.
  const native = toggleInput({ ...newFlowDocument(graph.name), ...graph }, 'query', 'type', exposed.label);
  assert.deepEqual(native.inputs, [exposed]);
  assert.deepEqual(validateFlowDocument(native), []);
  assert.equal(playerFields(native, flowRegistry())[0].default, 'IfcWall');
  replaceEvidence(captureEvidence('flow'));
  useAssistant.setState({ messages: [{ role: 'user', content: 'Expose IFC type in Player' },
    { role: 'assistant', model: 'controlled-provider', content: envelope(native.inputs) }] });
  const review = render(<FlowCreateReview />);
  const button = (name: string) => [...review.querySelectorAll('button')].find(item => item.textContent === name)!;
  click(button('Review new graph'));
  assert.match(review.textContent ?? '', /Player inputs[\s\S]*IFC type · query\.type · scalar/);
  assert.equal(button('Create and open graph').disabled, true, 'explicit approval still gates creation');
  const approval = review.querySelector('input[type="checkbox"]')!;
  click(approval);
  click(button('Create and open graph'));
  const created = useFlowCreateReview.getState().receipt!;
  assert.ok(created, useFlowCreateReview.getState().error ?? 'review did not create graph');
  cleanup();
  assert.deepEqual(created.created.inputs, native.inputs);
  assert.equal(useViewerStore.getState().flowLastRun, null, 'review and creation never execute');
  useViewerStore.getState().saveFlow();
  const saved = loadSavedFlows().find(item => item.doc.id === created.flowId)!;
  assert.deepEqual(saved.doc.inputs, native.inputs);
  const exported = migrateFlowDocument(JSON.parse(flowToJson(saved.doc)));
  assert.deepEqual(validateFlowDocument(exported), []);
  const imported = useViewerStore.getState().importFlow(exported as FlowDocument)!;
  useViewerStore.getState().openFlow(imported);
  assert.deepEqual(await preflightOpenFlow().then(result => result.problems), []);
  const ui = render(<BimReactContext.Provider value={model.bim}><FlowPlayer doc={useViewerStore.getState().flowDoc!}
    registry={flowRegistry()} lastRun={null} lastError={null} /></BimReactContext.Provider>);
  const field = ui.querySelector('input');
  assert.ok(field instanceof HTMLInputElement);
  assert.equal(field.value, 'IfcWall');
  const run = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Run');
  assert.ok(run && !run.disabled);
  const finish = async () => {
    await act(async () => { click(run); await advance(100); });
    for (let tries = 0; tries < 40 && useViewerStore.getState().flowRunning; tries++) await act(async () => advance(25));
    const result = useViewerStore.getState().flowLastRun;
    assert.ok(result?.ok, useViewerStore.getState().flowLastError ?? 'native Player did not finish');
    return result;
  };
  assert.equal(countItems((await finish()).graphOutputs[0].data!), 4, 'unchanged native Player default queries four walls');
  type(field, 'IfcSlab');
  const result = await finish();
  assert.equal(countItems(result.graphOutputs[0].data!), 3, 'the submitted native Player override queries slabs, not four default walls');
  assert.equal(model.bim.query().byType('IfcWall').toArray().length, 4, 'read-only graph does not mutate the model');
});

test('#7241 exposing a writer parameter keeps native override preflight and scoped grants authoritative before any mutation', async () => {
  const model = await openFlowSample();
  const proposal = prepareFlowCreateProposal(JSON.stringify({ version: 1, kind: 'flow.create', name: 'Reviewed attribute writer',
    nodes: [...graph.nodes, { id: 'value', type: 'core.string', params: { value: 'Reviewed' } },
      { id: 'write', type: 'model.setAttribute', params: { attribute: 'Name' } }],
    edges: [{ from: ['query', 'entities'], to: ['write', 'entity'] }, { from: ['value', 'value'], to: ['write', 'value'] }],
    inputs: [{ nodeId: 'write', param: 'attribute', label: 'Attribute', kind: 'enum', options: ['Name', 'Description'] }],
  }), captureEvidence('flow'));
  const created = applyFlowCreateProposal(proposal, proposal.digest);
  const doc = { ...created.created, capabilities: ['model.read', 'model.mutate:attr.Name'] };
  const names = model.bim.query().byType('IfcWall').toArray().map(wall => wall.name);
  const run = startWorkflowRun();
  try {
    assert.deepEqual(await preflightWorkflow(run, doc, { 'write.attribute': 'Name' }, viewerFlowFeatures(true)), { 'write.attribute': 'Name' });
    await assert.rejects(preflightWorkflow(run, doc, { 'write.attribute': 'Description' }, viewerFlowFeatures(true)), /Workflow capability denied: model.mutate:attr.Description/);
    assert.deepEqual(model.bim.query().byType('IfcWall').toArray().map(wall => wall.name), names);
    assert.equal(useViewerStore.getState().flowLastRun, null, 'preflight never runs the writer');
  } finally { run.release(); }
});

test('#7241 explicit input metadata uses native kind/parameter validation and refuses unknown, duplicate or oversized declarations', () => {
  const evidence = captureEvidence('flow');
  const rejected = [
    [{ ...exposed, kind: 'invented' }], [{ ...exposed, param: 'missing' }], [{ ...exposed, nodeId: 'absent' }],
    [exposed, exposed], [{ ...exposed, execute: true }], [{ ...exposed, label: '' }],
    Array.from({ length: 101 }, () => exposed), [{ ...exposed, options: Array.from({ length: 101 }, () => 'choice') }],
    [{ ...exposed, kind: 'files', fileSlots: [] }], [{ ...exposed, fileSlots: [] }],
    [{ ...exposed, kind: 'files', fileSlots: [{ id: 'file', label: 'File', accept: '.ifc', multiple: false, required: true, run: true }] }],
  ];
  for (const inputs of rejected) assert.throws(() => prepareFlowCreateProposal(envelope(inputs), evidence));
  assert.equal(useViewerStore.getState().savedFlows.length, initial.savedFlows.length, 'refusals never create a library entry');
});

test('#7241 all native Player kinds retain their exact explicit metadata and digest protects reviewed declarations', () => {
  const evidence = captureEvidence('flow');
  for (const kind of ['scalar', 'enum', 'entitySet', 'storey', 'file', 'files', 'table']) {
    const input = { ...exposed, kind, ...(kind === 'enum' ? { options: ['IfcWall', 'IfcSlab'] } : {}),
      ...(kind === 'files' ? { fileSlots: [{ id: 'model', label: 'Choose model', accept: '.ifc', multiple: false, required: true }] } : {}) };
    const proposal = prepareFlowCreateProposal(envelope([input]), evidence);
    const doc: FlowDocument = JSON.parse(proposal.docJson);
    assert.deepEqual(validateFlowDocument(doc), []);
    assert.deepEqual(doc.inputs, [input]);
    const changed = { ...doc, inputs: [{ ...input, label: 'Unreviewed label' }] };
    assert.throws(() => applyFlowCreateProposal({ ...proposal, docJson: JSON.stringify(changed) }, proposal.digest), /Reviewed proposal has changed/);
  }
});
