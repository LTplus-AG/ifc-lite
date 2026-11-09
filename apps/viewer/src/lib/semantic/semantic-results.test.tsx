/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { act, useState } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { DEFAULT_MAPPING } from '@ifc-lite/semantic';
import { SemanticResults } from '@/components/viewer/SemanticResults';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { render, click, activate, cleanup } from '@/test/render';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { createSelectionAdapter } from '@/sdk/adapters/selection-adapter';
import { useSemanticSession } from './session';
import { pilotModel } from './demo';
const original = useViewerStore.getState(); const session = useSemanticSession.getState();
afterEach(() => { cleanup(); useViewerStore.setState(original, true); useSemanticSession.setState(session, true); });
test('charter #6643 arbitrary analytical rows expose ambiguity and choose current model explicitly', async () => {
  const model = pilotModel(0);
  const data = await new IfcParser().parseColumnar(new TextEncoder().encode(model.content).buffer, { disableWorkerScan: true });
  const models = ['a', 'b'].map((id, index) => ({ ...fixtureModel(id, { idOffset: index * 1000000 }), ifcDataStore: data, maxExpressId: Math.max(...data.entities.expressId) }));
  useViewerStore.setState({ ...fixtureModels(...models), ifcDataStore: data, mutationViews: new Map(), selectedEntityId: null, selectedEntityIds: new Set() });
  const ui = render(<SemanticResults results={{ columns: ['GlobalId', 'count', 'missing'], rows: [{ GlobalId: { type: 'literal', value: model.GlobalIds[0] }, count: { type: 'literal', value: '01', datatype: 'http://www.w3.org/2001/XMLSchema#integer' } }] }} mapping={DEFAULT_MAPPING} revisions={new Map()} onError={error => { throw error; }} />);
  assert.ok(ui.textContent?.includes('01'));
  assert.ok(ui.textContent?.includes('Unbound'));
  click(ui.querySelector('button[aria-label="Select mapped row"]')!);
  assert.equal(createSelectionAdapter(useViewerStore).get().length, 0);
  const candidate = [...ui.querySelectorAll('fieldset button')][1];
  assert.ok(candidate); click(candidate);
  assert.equal(createSelectionAdapter(useViewerStore).get()[0].modelId, 'b');
});

test('charter #6643 replacing raw results resets pagination to the new first row', () => {
  function Harness() {
    const [results, setResults] = useState({ columns: ['value'], rows: Array.from({ length: 120 }, (_, index) => ({ value: { type: 'literal' as const, value: `old-row-${index}` } })) });
    return <><button onClick={() => { setResults({ columns: ['value'], rows: Array.from({ length: 20 }, (_, index) => ({ value: { type: 'literal', value: `new-row-${index}` } })) }); }}>Replace results</button>
      <SemanticResults results={results} mapping={DEFAULT_MAPPING} revisions={new Map()} onError={error => { throw error; }} /></>;
  }
  const ui = render(<Harness />);
  const next = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Next rows'); assert.ok(next);
  click(next); click(next); assert.ok(ui.textContent?.includes('old-row-100'));
  const replace = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Replace results'); assert.ok(replace); click(replace);
  assert.ok(ui.textContent?.includes('new-row-0'));
  const previous = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Previous rows'); assert.ok(previous?.disabled);
  assert.equal(ui.querySelectorAll('tbody tr').length, 20);
});


async function selectionFixture(count = 1) {
  const model = pilotModel(0);
  const data = await new IfcParser().parseColumnar(new TextEncoder().encode(model.content).buffer, { disableWorkerScan: true });
  const models = Array.from({ length: count }, (_, index) => ({ ...fixtureModel(`model-${index}`, { idOffset: index * 1000000 }), ifcDataStore: data, maxExpressId: Math.max(...data.entities.expressId) }));
  useViewerStore.setState({ ...fixtureModels(...models), ifcDataStore: data, mutationViews: new Map(), selectedEntityId: null, selectedEntityIds: new Set() });
  useSemanticSession.setState({ strategy: 'ifc-global-id' });
  return model;
}
function namedButton(ui: HTMLElement, name: string) {
  const button = [...ui.querySelectorAll('button')].find(item => item.textContent === name); assert.ok(button, name); return button;
}
function checkbox(ui: HTMLElement, row: number) {
  const box = ui.querySelector<HTMLInputElement>(`input[aria-label="Toggle result row ${row}"]`); assert.ok(box); return box;
}
const guidRow = (value: string) => ({ GlobalId: { type: 'literal' as const, value } });
test('#8556 checkbox selection updates renderer channels, deduplicates rows and follows external selection', async () => {
  const model = await selectionFixture();
  const ui = render(<SemanticResults results={{ columns: ['GlobalId'], rows: [guidRow(model.GlobalIds[0]), guidRow(model.GlobalIds[1]), guidRow(model.GlobalIds[0])] }} mapping={DEFAULT_MAPPING} revisions={new Map()} onError={error => { throw error; }} />);
  click(checkbox(ui, 1)); click(checkbox(ui, 2));
  assert.equal(createSelectionAdapter(useViewerStore).get().length, 2);
  assert.equal(useViewerStore.getState().selectedEntityIds.size, 2, 'both entities are highlighted');
  assert.equal(checkbox(ui, 3).checked, true, 'duplicate row reflects the same entity');
  click(checkbox(ui, 3));
  assert.equal(checkbox(ui, 1).checked, false);
  assert.equal(createSelectionAdapter(useViewerStore).get().length, 1);
  act(() => createSelectionAdapter(useViewerStore).set([]));
  assert.equal(checkbox(ui, 2).checked, false, 'selection changes elsewhere are reflected');
});
test('#8556 select all spans pages and clears selection while skipping unmapped rows', async () => {
  const model = await selectionFixture();
  act(() => createSelectionAdapter(useViewerStore).set([{ modelId: 'model-0', expressId: model.doors[2] }]));
  const rows = [...Array.from({ length: 50 }, () => guidRow(model.GlobalIds[0])), guidRow(model.GlobalIds[1]), guidRow('invalid')];
  const ui = render(<SemanticResults results={{ columns: ['GlobalId'], rows }} mapping={DEFAULT_MAPPING} revisions={new Map()} onError={error => { throw error; }} />);
  click(namedButton(ui, 'Select all mapped results'));
  assert.equal(useViewerStore.getState().selectedEntityIds.size, 2);
  assert.deepEqual(createSelectionAdapter(useViewerStore).get(), [
    { modelId: 'model-0', expressId: model.doors[0] },
    { modelId: 'model-0', expressId: model.doors[1] },
  ], 'bulk selection replaces a valid entity absent from the results');
  click(namedButton(ui, 'Next rows'));
  assert.equal(checkbox(ui, 51).checked, true); assert.equal(checkbox(ui, 52).disabled, true);
  click(namedButton(ui, 'Clear selection'));
  assert.equal(useViewerStore.getState().selectedEntityIds.size, 0);
  assert.equal(useViewerStore.getState().selectedEntityId, null);
  assert.equal(checkbox(ui, 51).checked, false);
});
test('#8556 bulk selection never guesses a model and candidate choices can be additive', async () => {
  const model = await selectionFixture(2);
  const results = { columns: ['GlobalId'], rows: [guidRow(model.GlobalIds[0])] };
  const ui = render(<SemanticResults results={results} mapping={DEFAULT_MAPPING} revisions={new Map()} onError={error => { throw error; }} />);
  assert.equal(checkbox(ui, 1).disabled, false);
  click(namedButton(ui, 'Select all mapped results')); assert.equal(createSelectionAdapter(useViewerStore).get().length, 0);
  const row = ui.querySelector('button[aria-label="Select mapped row"]'); assert.ok(row);
  click(row, { ctrlKey: true }); click(ui.querySelectorAll('fieldset button')[0]);
  click(row, { metaKey: true }); click(ui.querySelectorAll('fieldset button')[1]);
  assert.deepEqual(createSelectionAdapter(useViewerStore).get().map(ref => ref.modelId).sort(), ['model-0', 'model-1']);
  assert.equal(useViewerStore.getState().selectedEntityIds.size, 2);
  // Removing a model must re-resolve against the remaining live model before a bulk action.
  act(() => useViewerStore.setState({ models: new Map([['model-0', useViewerStore.getState().models.get('model-0')!]]) }));
  assert.equal(checkbox(ui, 1).disabled, false);
  click(namedButton(ui, 'Select all mapped results'));
  assert.deepEqual(createSelectionAdapter(useViewerStore).get().map(ref => ref.modelId), ['model-0']);
});


test('#8556 real ArchiCAD doors support checkbox and bulk selection', async context => {
  const fixture = new URL('../../../../../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url);
  if (!existsSync(fixture)) { context.skip('Run pnpm fixtures for the real ArchiCAD fixture'); return; }
  const bytes = new Uint8Array(await readFile(fixture));
  const data = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
  const doors = [...data.entities.expressId].filter(id => data.entities.getTypeName(id) === 'IfcDoor').slice(0, 3);
  assert.equal(doors.length, 3);
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('archicad'), ifcDataStore: data, maxExpressId: Math.max(...data.entities.expressId) }), ifcDataStore: data, mutationViews: new Map(), selectedEntityId: null, selectedEntityIds: new Set() });
  useSemanticSession.setState({ strategy: 'ifc-global-id' });
  const ui = render(<SemanticResults results={{ columns: ['GlobalId'], rows: doors.map(id => guidRow(data.entities.getGlobalId(id))) }} mapping={DEFAULT_MAPPING} revisions={new Map()} onError={error => { throw error; }} />);
  click(checkbox(ui, 1)); click(checkbox(ui, 2));
  assert.deepEqual(createSelectionAdapter(useViewerStore).get().map(ref => ref.expressId).sort((a, b) => a - b), doors.slice(0, 2).sort((a, b) => a - b));
  assert.equal(useViewerStore.getState().selectedEntityIds.size, 2);
  click(namedButton(ui, 'Select all mapped results'));
  assert.deepEqual(createSelectionAdapter(useViewerStore).get().map(ref => ref.expressId).sort((a, b) => a - b), doors.sort((a, b) => a - b));
  assert.equal(useViewerStore.getState().selectedEntityIds.size, 3);
});


for (const count of [1, 2]) test(`#8556 additive checkboxes preserve unrelated selection with ${count} model(s)`, async () => {
  const model = await selectionFixture(count);
  const external = { modelId: `model-${count - 1}`, expressId: model.doors[2] };
  act(() => createSelectionAdapter(useViewerStore).set([external]));
  const ui = render(<SemanticResults results={{ columns: ['GlobalId'], rows: [guidRow(model.GlobalIds[0])] }} mapping={DEFAULT_MAPPING} revisions={new Map()} scope="model-0" onError={error => { throw error; }} />);
  click(checkbox(ui, 1));
  assert.deepEqual(createSelectionAdapter(useViewerStore).get(), [external, { modelId: 'model-0', expressId: model.doors[0] }]);
  assert.equal(useViewerStore.getState().selectedEntityIds.size, 2);
  click(checkbox(ui, 1));
  assert.deepEqual(createSelectionAdapter(useViewerStore).get(), [external]);
});

test('#8556 a stale ambiguous candidate cannot overwrite an unrelated current selection', async () => {
  const model = await selectionFixture(2); const errors: unknown[] = [];
  const external = { modelId: 'model-1', expressId: model.doors[2] };
  act(() => createSelectionAdapter(useViewerStore).set([external]));
  const ui = render(<SemanticResults results={{ columns: ['GlobalId'], rows: [guidRow(model.GlobalIds[0])] }} mapping={DEFAULT_MAPPING} revisions={new Map()} onError={error => errors.push(error)} />);
  click(ui.querySelector('button[aria-label="Select mapped row"]')!, { ctrlKey: true });
  const stale = ui.querySelectorAll('fieldset button')[0]; assert.ok(stale);
  act(() => useViewerStore.setState({ models: new Map([['model-1', useViewerStore.getState().models.get('model-1')!]]) }));
  click(stale);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /no longer available/);
  assert.deepEqual(createSelectionAdapter(useViewerStore).get(), [external]);
});

test('#8556 bulk selection reads tombstones at the click boundary', async () => {
  const model = await selectionFixture();
  act(() => { getOrCreateMutationView(useViewerStore, 'model-0'); });
  const ui = render(<SemanticResults results={{ columns: ['GlobalId'], rows: model.GlobalIds.map(guidRow) }} mapping={DEFAULT_MAPPING} revisions={new Map()} onError={error => { throw error; }} />);
  // No mutationVersion notification: simulate the interval before React renders the deletion.
  const currentView = useViewerStore.getState().mutationViews.get('model-0'); assert.ok(currentView);
  currentView.deleteEntity(model.doors[0]);
  click(namedButton(ui, 'Select all mapped results'));
  assert.deepEqual(createSelectionAdapter(useViewerStore).get().map(ref => ref.expressId).sort((a, b) => a - b), model.doors.slice(1).sort((a, b) => a - b));
  assert.equal(useViewerStore.getState().selectedEntityIds.size, 2);
});

test('#8556 bulk selection skips unassociated revisions and ambiguity and follows scope changes', async () => {
  const model = await selectionFixture(2);
  const rows = [
    { ...guidRow(model.GlobalIds[0]), modelRevision: { type: 'uri' as const, value: 'urn:revision:known' } },
    guidRow(model.GlobalIds[1]),
    { ...guidRow(model.GlobalIds[2]), modelRevision: { type: 'uri' as const, value: 'urn:revision:missing' } },
  ];
  function Harness() {
    const [scope, setScope] = useState<string>();
    return <><button onClick={() => setScope('model-1')}>Scope second model</button><SemanticResults results={{ columns: ['GlobalId', 'modelRevision'], rows }} mapping={DEFAULT_MAPPING} revisions={new Map([['urn:revision:known', 'model-0']])} scope={scope} onError={error => { throw error; }} /></>;
  }
  const ui = render(<Harness />);
  click(namedButton(ui, 'Select all mapped results'));
  assert.deepEqual(createSelectionAdapter(useViewerStore).get(), [{ modelId: 'model-0', expressId: model.doors[0] }]);
  click(namedButton(ui, 'Scope second model')); click(namedButton(ui, 'Select all mapped results'));
  assert.deepEqual(createSelectionAdapter(useViewerStore).get(), [{ modelId: 'model-1', expressId: model.doors[1] }]);
  assert.equal(checkbox(ui, 1).disabled, true);
  assert.equal(checkbox(ui, 3).disabled, true);
});


test('#8556 select all with no resolved rows preserves a nonempty selection', async () => {
  const model = await selectionFixture(2);
  const external = { modelId: 'model-1', expressId: model.doors[2] };
  act(() => createSelectionAdapter(useViewerStore).set([external]));
  const ui = render(<SemanticResults results={{ columns: ['GlobalId'], rows: [guidRow(model.GlobalIds[0]), guidRow('bad-guid')] }} mapping={DEFAULT_MAPPING} revisions={new Map()} onError={error => { throw error; }} />);
  click(namedButton(ui, 'Select all mapped results'));
  assert.deepEqual(createSelectionAdapter(useViewerStore).get(), [external]);
  click(namedButton(ui, 'Clear selection'));
  assert.equal(createSelectionAdapter(useViewerStore).get().length, 0);
});

test('#8556 ambiguous row checkboxes expose keyboard candidate toggles and selected state', async () => {
  const model = await selectionFixture(2);
  const external = { modelId: 'model-1', expressId: model.doors[2] };
  act(() => createSelectionAdapter(useViewerStore).set([external]));
  const ui = render(<SemanticResults results={{ columns: ['GlobalId'], rows: [guidRow(model.GlobalIds[0])] }} mapping={DEFAULT_MAPPING} revisions={new Map()} onError={error => { throw error; }} />);
  const box = checkbox(ui, 1); assert.equal(box.disabled, false);
  // A checkbox's Space default dispatches click; candidates use actual Enter activation.
  click(box);
  let candidate = ui.querySelector<HTMLButtonElement>('fieldset button'); assert.ok(candidate);
  assert.equal(candidate.getAttribute('aria-pressed'), 'false'); activate(candidate, 'Enter');
  assert.equal(checkbox(ui, 1).checked, true);
  assert.equal(createSelectionAdapter(useViewerStore).get().length, 2);
  click(checkbox(ui, 1)); candidate = ui.querySelector<HTMLButtonElement>('fieldset button'); assert.ok(candidate);
  assert.equal(candidate.getAttribute('aria-pressed'), 'true'); activate(candidate, 'Enter');
  assert.equal(checkbox(ui, 1).checked, false);
  assert.deepEqual(createSelectionAdapter(useViewerStore).get(), [external]);
});

test('#8556 external selection changes do not rescan the model GlobalIds', async () => {
  const model = await selectionFixture();
  const data = useViewerStore.getState().models.get('model-0')?.ifcDataStore; assert.ok(data);
  const originalGlobalId = data.entities.getGlobalId;
  let reads = 0;
  data.entities.getGlobalId = function(id: number) { reads++; return originalGlobalId.call(this, id); };
  try {
    const ui = render(<SemanticResults results={{ columns: ['GlobalId'], rows: [guidRow(model.GlobalIds[0])] }} mapping={DEFAULT_MAPPING} revisions={new Map()} onError={error => { throw error; }} />);
    const before = reads; assert.ok(before > 0);
    act(() => createSelectionAdapter(useViewerStore).set([{ modelId: 'model-0', expressId: model.doors[0] }]));
    assert.equal(checkbox(ui, 1).checked, true); assert.equal(reads, before);
  } finally { data.entities.getGlobalId = originalGlobalId; }
});
