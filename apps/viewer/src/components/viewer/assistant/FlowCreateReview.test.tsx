/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { TRACKING_SIDECAR_VERSION, type FlowDocument, type RunResult } from '@ifc-lite/flow';
import { render, click, cleanup } from '@/test/render';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { captureEvidence } from '@/lib/assistant/evidence';
import { replaceEvidence, useAssistant, cancelAssistant } from '@/lib/assistant/conversation';
import { newFlowDocument } from '@/lib/flow/persistence';
import { FlowProposalReview, useFlowReview } from './FlowProposalReview';
import { useFlowCreateReview } from './FlowCreateReview';
import { FlowPreflight } from './FlowPreflight';

const initial = useViewerStore.getState();
afterEach(() => {
  cleanup(); cancelAssistant(); useViewerStore.setState(initial, true); localStorage.clear();
  useFlowReview.setState({ proposal: null, receipts: [], approved: false, trackingAcknowledged: false, error: null });
  useFlowCreateReview.setState({ proposal: null, receipt: null, approved: false, error: null });
});
function reply(content: unknown) {
  useAssistant.setState({ messages: [{ role: 'user', content: 'Help with Flow' }, { role: 'assistant', model: 'test-provider', content: JSON.stringify(content) }] });
}
const button = (ui: HTMLElement, text: string) => [...ui.querySelectorAll('button')].find(b => b.textContent === text)!;
const checkbox = (ui: HTMLElement, label: RegExp) => [...ui.querySelectorAll('label')].find(l => label.test(l.textContent ?? ''))!.querySelector('input')!;
async function settle(ui: HTMLElement, pattern: RegExp) {
  for (let i = 0; i < 50 && !pattern.test(ui.textContent ?? ''); i++) await act(() => new Promise(resolve => setTimeout(resolve, 10)));
  assert.match(ui.textContent ?? '', pattern);
}

// #6919: a described graph becomes a NEW saved graph after review, is preflighted and never run here.
test('mounted create review saves and opens a new graph, preflights it and can remove it', async () => {
  useViewerStore.setState(fixtureModels(fixtureModel('m')));
  replaceEvidence(captureEvidence('flow'));
  reply({ version: 1, kind: 'flow.create', name: 'Sum', nodes: [
    { id: 'a', type: 'core.number', params: { value: 7 } }, { id: 'b', type: 'core.number', params: { value: 5 } },
    { id: 'sum', type: 'core.math', params: { op: 'add' } },
  ], edges: [{ from: ['a', 'value'], to: ['sum', 'a'] }, { from: ['b', 'value'], to: ['sum', 'b'] }] });
  const ui = render(<FlowProposalReview />);
  assert.equal(ui.querySelector('section[aria-label="Review Flow changes"]'), null, 'the patch review stays hidden');
  click(button(ui, 'Review new graph'));
  assert.match(ui.textContent ?? '', /New graph: Sum/);
  assert.match(ui.textContent ?? '', /3 nodes · 2 edges/);
  assert.match(ui.textContent ?? '', /sum · core\.math ← a\.value→a ← b\.value→b/);
  assert.equal(useViewerStore.getState().savedFlows.length, 0, 'review is inert');
  const create = button(ui, 'Create and open graph');
  assert.equal(create.disabled, true);
  act(() => checkbox(ui, /I reviewed the new graph/).click());
  click(button(ui, 'Create and open graph'));
  const state = useViewerStore.getState();
  assert.deepEqual(state.savedFlows.map(flow => flow.doc.name), ['Sum']);
  assert.equal(state.flowDoc?.name, 'Sum');
  assert.match(ui.textContent ?? '', /Created “Sum” as a new saved graph and opened it in Flow\. Nothing was run\./);
  await act(async () => button(ui, 'Preflight').click());
  await settle(ui, /Preflight passed for “Sum”/);
  assert.equal(useViewerStore.getState().flowLastRun, null);
  // Once the created graph is edited, its card neither preflights a different graph nor removes it.
  const created = useViewerStore.getState().flowDoc!;
  act(() => useViewerStore.getState().setFlowDoc({ ...created, name: 'Edited' }));
  assert.equal(button(ui, 'Preflight'), undefined);
  assert.equal(button(ui, 'Remove created graph').disabled, true);
  act(() => useViewerStore.setState({ flowDoc: created, flowDirty: false }));
  click(button(ui, 'Remove created graph'));
  assert.equal(useViewerStore.getState().savedFlows.length, 0);
});

// #6919: a debug patch shows the native run's own error and tracked-element effects; both gate apply.
test('mounted debug review cites native errors and requires acknowledging owned elements', () => {
  const doc: FlowDocument = { ...newFlowDocument('Columns'), nodes: [{ id: 'add', type: 'model.addElement' }] };
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m'), sourceContentHash: 'h' }), flowDoc: doc, activeFlowId: doc.id, flowRunning: false });
  localStorage.setItem(`ifc-lite-flow-tracking:${doc.id}`, JSON.stringify({ version: TRACKING_SIDECAR_VERSION, pinnedTo: 'content:h', sets: {
    'Columns/add': { trackingKey: 'Columns/add', generation: 0, nodeType: 'model.addElement',
      entries: { a: { globalId: 'g1', digest: 'd1' }, b: { globalId: 'g2', digest: 'd2' } } } } }));
  const run: RunResult = { ok: false, writes: 0, outputs: new Map(), graphOutputs: [], log: [], review: [], reports: [
    { nodeId: 'add', status: 'error', durationMs: 1, lanes: 0, laneErrors: 0, missing: { spec: ['spec'] }, warnings: [], error: 'missing required input "spec"' }] };
  useViewerStore.getState().setFlowLastRun(run, null, null);
  // The run bar's source (`flowRun`) pins the run a diagnosis cites.
  replaceEvidence(captureEvidence('flowRun'));
  reply({ version: 1, kind: 'flow.patch', operations: [{ op: 'removeNode', node: 'add' }],
    diagnosis: { nodes: ['add'], explanation: 'The column node has no spec; remove it.' } });
  const ui = render(<FlowProposalReview />);
  click(button(ui, 'Review changes'));
  assert.match(ui.textContent ?? '', /Diagnosis of the last run/);
  assert.match(ui.textContent ?? '', /add: error · lane errors: 0/);
  assert.match(ui.textContent ?? '', /missing required input "spec"/);
  assert.match(ui.textContent ?? '', /add is removed: 2 owned elements under “Columns\/add” are deleted from the model on the next Run\./);
  act(() => checkbox(ui, /I reviewed the graph changes/).click());
  assert.equal(button(ui, 'Apply graph changes').disabled, true, 'owned-element effects need their own acknowledgement');
  act(() => checkbox(ui, /I understand which tracked elements/).click());
  click(button(ui, 'Apply graph changes'));
  assert.deepEqual(useViewerStore.getState().flowDoc?.nodes, []);
  assert.equal(localStorage.getItem(`ifc-lite-flow-tracking:${doc.id}`) !== null, true, 'applying never runs the orphan sweep');
  assert.equal(button(ui, 'Undo graph changes').disabled, false, 'applying cleared the run; the graph alone guards undo');
  click(button(ui, 'Undo graph changes'));
  assert.equal(useViewerStore.getState().flowDoc, doc);
});

// #6919: a graph that edits the model is refused before Run while Edit mode is off, and can be fixed in place.
test('mounted preflight offers Edit mode for a graph that writes the model', async () => {
  const doc: FlowDocument = { ...newFlowDocument('Writer'), capabilities: ['model.create'], nodes: [{ id: 'add', type: 'model.addElement' }] };
  useViewerStore.setState({ ...fixtureModels(fixtureModel('m')), flowDoc: doc, activeFlowId: doc.id, editEnabled: false });
  const ui = render(<FlowPreflight />);
  await act(async () => button(ui, 'Preflight').click());
  await settle(ui, /add edits the model: Turn on Edit mode before changing a model/);
  await act(async () => button(ui, 'Turn on Edit mode').click());
  assert.equal(useViewerStore.getState().editEnabled, true);
  for (let i = 0; i < 50 && /Edit mode/.test(ui.textContent ?? ''); i++) await act(() => new Promise(resolve => setTimeout(resolve, 10)));
  assert.doesNotMatch(ui.textContent ?? '', /Edit mode/);
  assert.equal(useViewerStore.getState().flowLastRun, null);
});

// #6919: script source in a described graph is shown verbatim and pinned by the digest.
test('mounted create review lists the script code of the new graph', () => {
  useViewerStore.setState(fixtureModels(fixtureModel('m')));
  replaceEvidence(captureEvidence('flow'));
  const code = 'const factor = 2;\ninputs.a * factor';
  reply({ version: 1, kind: 'flow.create', name: 'Scripted', nodes: [
    { id: 'a', type: 'core.number', params: { value: 7 } }, { id: 'calc', type: 'script.run', params: { code } },
  ], edges: [{ from: ['a', 'value'], to: ['calc', 'a'] }] });
  const ui = render(<FlowProposalReview />);
  click(button(ui, 'Review new graph'));
  const proposal = useFlowCreateReview.getState().proposal!;
  assert.deepEqual(proposal.code.map(entry => [entry.nodeId, entry.param, entry.code]), [['calc', 'code', code]]);
  const listed = ui.querySelector('[aria-label="Script code this change sets"]');
  assert.ok(listed && !listed.closest('details'), 'code is listed outside the collapsed JSON');
  assert.equal(listed.querySelector('pre')?.textContent, code);
});
