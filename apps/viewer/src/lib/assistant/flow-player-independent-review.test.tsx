/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createBimContext } from '@ifc-lite/sdk';
import { loadIfcModel } from '@ifc-lite/mcp';
import { countItems, type RunResult } from '@ifc-lite/flow';
import { useViewerStore } from '@/store';
import { LocalBackend } from '@/sdk/local-backend';
import { BimReactContext } from '@/sdk/BimProvider';
import { FlowPlayer } from '@/components/viewer/flow/FlowPlayer';
import { openFlowSample } from '@/test/flow-sample-fixture';
import { fixtureModel } from '@/test/store-fixture';
import { render, click, type, advance, cleanup } from '@/test/render';
import { flowRegistry } from '@/lib/flow/runner';
import { captureEvidence } from './evidence';
import { applyFlowCreateProposal, prepareFlowCreateProposal } from './flow-create';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); localStorage.clear(); });
const revB = fileURLToPath(new URL('../../../public/samples/building-architecture-rev-b.ifc', import.meta.url));

function create(nodes: unknown[], inputs: unknown[], edges: unknown[] = []) {
  const proposal = prepareFlowCreateProposal(JSON.stringify({ version: 1, kind: 'flow.create', name: 'Native Player review',
    nodes, inputs, edges, outputs: [{ nodeId: 'query', port: 'entities', label: 'Chosen source' }] }), captureEvidence('flow'));
  return applyFlowCreateProposal(proposal, proposal.digest).created;
}

function mount() {
  const bim = createBimContext({ backend: new LocalBackend(useViewerStore) });
  const doc = useViewerStore.getState().flowDoc;
  assert.ok(doc);
  const ui = render(<BimReactContext.Provider value={bim}><FlowPlayer doc={doc} registry={flowRegistry()}
    lastRun={null} lastError={null} /></BimReactContext.Provider>);
  const run = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Run');
  assert.ok(run && !run.disabled);
  return { bim, ui, run };
}

async function drained(): Promise<void> {
  for (let i = 0; i < 80 && useViewerStore.getState().flowRunning; i++) await act(async () => advance(10));
  assert.equal(useViewerStore.getState().flowRunning, false, 'native Run must settle');
}
async function completed(run: HTMLButtonElement): Promise<RunResult> {
  click(run); await drained();
  const result = useViewerStore.getState().flowLastRun;
  assert.ok(result?.ok, useViewerStore.getState().flowLastError ?? 'native Run did not complete');
  return result;
}
function choose(select: HTMLSelectElement, value: string): void {
  act(() => { select.value = value; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
}

test('#7241 independent legacy graph without declared inputs remains inert until native Run', async () => {
  await openFlowSample();
  const proposal = prepareFlowCreateProposal(JSON.stringify({ version: 1, kind: 'flow.create', name: 'Legacy Player control',
    nodes: [{ id: 'query', type: 'model.byType', params: { type: 'IfcWall', model: 'arch' } }], edges: [],
    outputs: [{ nodeId: 'query', port: 'entities', label: 'Walls' }] }), captureEvidence('flow'));
  applyFlowCreateProposal(proposal, proposal.digest);
  const { ui, run } = mount();
  assert.equal(ui.querySelectorAll('input, select, textarea').length, 0);
  assert.equal(useViewerStore.getState().flowLastRun, null);
  assert.equal(countItems((await completed(run)).graphOutputs[0].data!), 4);
});

test('#7241 independent native Player scalar/enum defaults and overrides retain exact 1/N model ownership', async () => {
  await openFlowSample();
  create([{ id: 'query', type: 'model.byType', params: { type: 'IfcWall', model: 'arch' } }], [
    { nodeId: 'query', param: 'type', label: 'Type', kind: 'scalar' },
    { nodeId: 'query', param: 'model', label: 'Model', kind: 'enum', options: ['arch', 'other'] },
  ]);
  const { ui, run } = mount();
  assert.equal(useViewerStore.getState().flowLastRun, null, 'creation and form mount are inert');
  assert.equal(countItems((await completed(run)).graphOutputs[0].data!), 4);
  const input = ui.querySelector('input'); assert.ok(input instanceof HTMLInputElement);
  type(input, 'IfcSlab');
  assert.equal(countItems((await completed(run)).graphOutputs[0].data!), 3);
  const other = await loadIfcModel(revB, { modelId: 'other' });
  await act(async () => { useViewerStore.setState(state => ({ models: new Map([...state.models, ['other', {
    ...fixtureModel('other', { idOffset: 1_000_000 }), ifcDataStore: other.store,
    sourceFingerprint: other.sourceFingerprint,
  }]]) })); });
  assert.equal(useViewerStore.getState().models.size, 2);
  const select = ui.querySelector('select'); assert.ok(select instanceof HTMLSelectElement);
  choose(select, 'other');
  const result = await completed(run);
  const refs = result.outputs.get('query')?.get('entities');
  assert.equal(refs?.kind, 'list');
  if (refs?.kind !== 'list') throw new Error('Expected native entity list');
  assert.equal(refs.items.length, other.bim.query().byType('IfcSlab').toArray().length);
  assert.ok(refs.items.length > 0);
  assert.ok(refs.items.every(ref => typeof ref === 'object' && ref !== null && 'modelId' in ref && ref.modelId === 'other'));
  assert.equal(useViewerStore.getState().undoStacks.size, 0, 'read-only configured runs never add model history');
});

test('#7241 independent native Player explicit writer values form one real viewer Undo batch and refused overrides leave source unchanged', async () => {
  await openFlowSample();
  const created = create([{ id: 'query', type: 'model.byType', params: { type: 'IfcWall', model: 'arch' } },
    { id: 'value', type: 'core.string', params: { value: 'Player default' } },
    { id: 'write', type: 'model.setAttribute', params: { attribute: 'Name' } }], [
    { nodeId: 'value', param: 'value', label: 'New name', kind: 'scalar' },
    { nodeId: 'write', param: 'attribute', label: 'Attribute', kind: 'enum', options: ['Name', 'Description'] },
  ], [{ from: ['query', 'entities'], to: ['write', 'entity'] }, { from: ['value', 'value'], to: ['write', 'value'] }]);
  // Native creation declares the node's wildcard mutation capability. The
  // coordinator explicitly narrows it through the native graph setter.
  assert.ok(created.capabilities.includes('model.mutate:*'));
  useViewerStore.getState().setFlowDoc({ ...created, capabilities: ['model.read', 'model.mutate:attr.Name'] });
  useViewerStore.getState().saveFlow();
  const { bim, ui, run } = mount();
  const walls = () => bim.query().model('arch').byType('IfcWall').toArray();
  const original = walls().map(wall => wall.name); assert.equal(original.length, 4);
  assert.equal(useViewerStore.getState().undoStacks.size, 0);
  await completed(run);
  assert.deepEqual(walls().map(wall => wall.name), Array(4).fill('Player default'));
  assert.equal(bim.mutate.undo('arch'), true);
  assert.deepEqual(walls().map(wall => wall.name), original, 'one native Undo restores every wall');
  const input = ui.querySelector('input'); assert.ok(input instanceof HTMLInputElement);
  type(input, 'Player explicit override');
  await completed(run);
  assert.deepEqual(walls().map(wall => wall.name), Array(4).fill('Player explicit override'));
  assert.equal(bim.mutate.undo('arch'), true);
  assert.deepEqual(walls().map(wall => wall.name), original);
  const select = ui.querySelector('select'); assert.ok(select instanceof HTMLSelectElement);
  const history = useViewerStore.getState().undoStacks.get('arch')?.length ?? 0;
  choose(select, 'Description');
  assert.equal(select.value, 'Description');
  assert.equal(run.disabled, false, 'native Player must admit this valid field value before scoped preflight');
  click(run); await drained();
  assert.match(useViewerStore.getState().flowLastError ?? '', /Workflow capability denied: model.mutate:attr.Description/);
  assert.deepEqual(walls().map(wall => wall.name), original);
  assert.equal(useViewerStore.getState().undoStacks.get('arch')?.length ?? 0, history);
});

test('#7241 independent native Player cancellation and source replacement settle before executing a stale graph', async () => {
  await openFlowSample();
  create([{ id: 'query', type: 'model.byType', params: { type: 'IfcWall', model: 'arch' } }], [
    { nodeId: 'query', param: 'type', label: 'Type', kind: 'scalar' },
  ]);
  const { ui, run } = mount();
  click(run);
  const cancel = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Cancel workflow'); assert.ok(cancel);
  click(cancel); await drained();
  assert.equal(useViewerStore.getState().flowLastRun, null);
  assert.match(useViewerStore.getState().flowLastError ?? '', /cancelled|abort/i);
  const replacement = await loadIfcModel(revB, { modelId: 'arch' });
  click(run);
  await act(async () => { useViewerStore.setState(state => ({ models: new Map([...state.models].map(([id, model]) =>
    [id, id === 'arch' ? { ...model, ifcDataStore: replacement.store, sourceFingerprint: replacement.sourceFingerprint } : model])) })); });
  await drained();
  assert.equal(useViewerStore.getState().flowLastRun, null, 'native source-change subscription cancels stale work');
  assert.equal(useViewerStore.getState().undoStacks.size, 0);
});
