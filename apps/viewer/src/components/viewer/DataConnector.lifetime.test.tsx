/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { advance, cleanup, click, render } from '@/test/render';
import { setLocale } from '@/i18n';
import { replayWorkspaceHistory } from '@/lib/model-placement/history';
import { DataConnector } from './DataConnector';

const original = useViewerStore.getState();
const guid = (n: number) => `0${String(n).padStart(21, '0')}`;
async function parsedModel(id: string, count = 2) {
  const content = `ISO-10303-21; HEADER; FILE_DESCRIPTION((''),'2;1'); FILE_NAME('draft.ifc','',(''),(''),'','',''); FILE_SCHEMA(('IFC4')); ENDSEC; DATA;
${Array.from({ length: count }, (_, i) => `#${i + 1}=IFCWALL('${guid(i + 1)}',$,'${id} wall ${i + 1}',$,$,$,$,$,.STANDARD.);`).join('\n')}
ENDSEC; END-ISO-10303-21;`;
  const model = fixtureModel(id);
  model.ifcDataStore = await new IfcParser().parseColumnar(new TextEncoder().encode(content).buffer, { disableWorkerScan: true });
  return model;
}
beforeEach(async () => {
  setLocale('en');
  useViewerStore.setState({ ...fixtureModels(await parsedModel('a'), await parsedModel('b')),
    mutationViews: new Map(), undoStacks: new Map(), redoStacks: new Map(), mutationBatchTags: new Map(),
    referenceUndo: [], referenceRedo: [], modelPlacement: original.modelPlacement,
    collabRole: null, editEnabled: true, loading: false });
});
afterEach(() => { cleanup(); useViewerStore.setState(original); });
function button(label: string | RegExp) {
  const found = [...document.querySelectorAll('button')].find(b => typeof label === 'string'
    ? b.textContent?.trim() === label : label.test(b.textContent?.trim() ?? ''));
  assert.ok(found, String(label)); return found;
}
const importButton = () => button(/^Import(?: \d+ rows?)?$/);
function Harness() {
  const [open, setOpen] = useState(true);
  return <><button onClick={() => setOpen(true)}>Reopen</button><DataConnector open={open} onOpenChange={setOpen} /></>;
}
function chooseCsv(name: string, text: string) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(input);
  Object.defineProperty(input, 'files', { configurable: true, value: [new File([text], name, { type: 'text/csv' })] });
  act(() => input.dispatchEvent(new window.Event('change', { bubbles: true })));
}
async function upload(count = 2) {
  chooseCsv('draft.csv',
    ['GlobalId,FireRating', ...Array.from({ length: count }, (_, i) => `${guid(i + 1)},REI${i + 1}`)].join('\n'),
  );
  await advance(50); assert.equal(importButton().disabled, false);
}
function selectModel(id: string) {
  const picker = [...document.querySelectorAll<HTMLButtonElement>('button[role="combobox"]')]
    .find(b => b.textContent === 'a' || b.textContent === 'b'); assert.ok(picker);
  click(picker);
  const option = [...document.querySelectorAll('[role="option"]')].find(o => o.textContent === id); assert.ok(option);
  click(option);
}
async function ticks(t: TestContext, count = 12) {
  for (let i = 0; i < count; i++) await act(async () => { t.mock.timers.tick(1); await Promise.resolve(); });
}

function holdFileReads(t: TestContext) {
  const reads: Array<() => void> = [];
  const read = FileReader.prototype.readAsText;
  t.mock.method(FileReader.prototype, 'readAsText', function (this: FileReader, ...args: Parameters<FileReader['readAsText']>) {
    reads.push(() => read.apply(this, args));
  });
  return reads;
}
function mappingTarget() {
  const pset = document.querySelector<HTMLInputElement>('input[aria-label="Target Pset"]');
  const property = document.querySelector<HTMLInputElement>('input[aria-label="Target Property"]');
  assert.ok(pset && property);
  return { pset: pset.value, property: property.value };
}

test('#8947 retiring a pending CSV read keeps the displayed filename and actual import payload together', async t => {
  render(<Harness />); await advance(0); await upload();
  const target = mappingTarget();
  const reads = holdFileReads(t);
  chooseCsv('replacement.csv', `GlobalId,FireRating\n${guid(1)},REPLACEMENT\n`);
  assert.equal(reads.length, 1);
  selectModel('b');
  act(() => reads[0]()); await advance(50);
  assert.match(document.body.textContent ?? '', /draft\.csv/);
  assert.doesNotMatch(document.body.textContent ?? '', /replacement\.csv/);
  assert.equal(importButton().disabled, false);
  click(importButton()); await advance(100);
  const state = useViewerStore.getState();
  assert.equal(state.getMutationView('a')?.getModifiedEntityCount(), 0);
  assert.equal(state.getMutationView('b')?.getPropertyValue(1, target.pset, target.property), 'REI1');
});

test('#8947 an older CSV read finishing last cannot replace a newer accepted draft', async t => {
  render(<Harness />); await advance(0); await upload();
  const target = mappingTarget();
  const reads = holdFileReads(t);
  chooseCsv('older.csv', `GlobalId,FireRating\n${guid(1)},OLDER\n`);
  chooseCsv('newer.csv', `GlobalId,FireRating\n${guid(1)},NEWER\n`);
  assert.equal(reads.length, 2);
  act(() => reads[1]()); await advance(50);
  act(() => reads[0]()); await advance(50);
  assert.match(document.body.textContent ?? '', /newer\.csv/);
  assert.doesNotMatch(document.body.textContent ?? '', /older\.csv/);
  click(importButton()); await advance(100);
  assert.equal(useViewerStore.getState().getMutationView('a')?.getPropertyValue(1, target.pset, target.property), 'NEWER');
});

// Fake only scheduling after the real file parse: importAsync pauses at its own
// matching/apply setTimeout boundaries; parsing, matching and writes stay real.
test('#8947 closing at a matching yield keeps the draft retryable without retired UI writes', async t => {
  render(<Harness />); await advance(0); await upload();
  const view = useViewerStore.getState().getMutationView('a'); assert.ok(view);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  click(importButton()); assert.equal(view.getModifiedEntityCount(), 0);
  click(button('Close')); click(button('Reopen')); await ticks(t);
  assert.equal(view.getModifiedEntityCount(), 0);
  assert.equal(importButton().disabled, false, 'retired completion must not clear importDirty');
  assert.doesNotMatch(document.body.textContent ?? '', /Import failed/);
  click(importButton()); await ticks(t);
  assert.equal(view.getModifiedEntityCount(), 2);
  act(() => replayWorkspaceHistory(useViewerStore.getState(), 'undo'));
  assert.equal(view.getModifiedEntityCount(), 0, 'retry uses the canonical undo log');
});

test('#8947 closing after an applied batch preserves undo and prevents later batches', async t => {
  useViewerStore.setState({ ...fixtureModels(await parsedModel('a', 201)) });
  render(<Harness />); await advance(0); await upload(201);
  const view = useViewerStore.getState().getMutationView('a'); assert.ok(view);
  t.mock.timers.enable({ apis: ['setTimeout'] }); click(importButton());
  for (let i = 0; i < 10 && view.getModifiedEntityCount() === 0; i++) await ticks(t, 1);
  assert.equal(view.getModifiedEntityCount(), 200, 'paused between two real apply batches');
  click(button('Close')); await ticks(t);
  assert.equal(view.getModifiedEntityCount(), 200);
  act(() => replayWorkspaceHistory(useViewerStore.getState(), 'undo'));
  assert.equal(view.getModifiedEntityCount(), 0, 'the already-applied batch remains undoable');
  click(button('Reopen')); assert.equal(importButton().disabled, false);
});

test('#8947 changing the target at a yield retires the import before it writes the old model', async t => {
  render(<Harness />); await advance(0); await upload();
  const a = useViewerStore.getState().getMutationView('a'); assert.ok(a);
  t.mock.timers.enable({ apis: ['setTimeout'] }); click(importButton()); selectModel('b'); await ticks(t);
  const b = useViewerStore.getState().getMutationView('b'); assert.ok(b);
  assert.equal(a.getModifiedEntityCount(), 0); assert.equal(b.getModifiedEntityCount(), 0);
  assert.equal(importButton().disabled, false);
  click(importButton()); await ticks(t);
  assert.equal(a.getModifiedEntityCount(), 0); assert.equal(b.getModifiedEntityCount(), 2);
});

for (const replacement of ['data', 'view'] as const) test(`#8947 replacing the same-id target ${replacement} retires a pending import`, async t => {
  const model = await parsedModel('a');
  render(<Harness />); await advance(0); await upload();
  const oldView = useViewerStore.getState().getMutationView('a'); assert.ok(oldView);
  t.mock.timers.enable({ apis: ['setTimeout'] }); click(importButton());
  act(() => {
    if (replacement === 'data') useViewerStore.setState({ models: new Map([['a', model]]) });
    else useViewerStore.getState().registerMutationView('a', new MutablePropertyView(null, 'a'));
  });
  await ticks(t);
  assert.equal(oldView.getModifiedEntityCount(), 0);
  assert.equal(useViewerStore.getState().getMutationView('a')?.getModifiedEntityCount(), 0);
  assert.equal(importButton().disabled, false);
});

test('#8947 a persistent connector reconciles a removed target and imports into its replacement', async () => {
  render(<Harness />); await advance(0); await upload();
  const a = useViewerStore.getState().getMutationView('a'); assert.ok(a);
  click(button('Close'));
  const b = useViewerStore.getState().models.get('b'); assert.ok(b);
  act(() => useViewerStore.setState({ ...fixtureModels(b), selectedEntityId: null, selectedEntityIds: new Set() }));
  click(button('Reopen')); await advance(0);
  assert.ok([...document.querySelectorAll('[role="combobox"]')].some(p => p.textContent === 'b'));
  click(importButton()); await advance(100);
  assert.equal(a.getModifiedEntityCount(), 0);
  assert.equal(useViewerStore.getState().getMutationView('b')?.getModifiedEntityCount(), 2);
});

test('#8947 first open initializes the target from the current active model, not a closed host snapshot', async () => {
  function Closed() {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>Open</button><DataConnector open={open} onOpenChange={setOpen} /></>;
  }
  render(<Closed />); act(() => useViewerStore.setState({ activeModelId: 'b' }));
  click(button('Open')); await advance(0);
  assert.ok([...document.querySelectorAll('[role="combobox"]')].some(p => p.textContent === 'b'));
});

test('#8947 a suggestion for an old target cannot populate the current target draft', async t => {
  useViewerStore.setState({ chatActiveModel: 'openai/gpt-free' });
  const replies: Array<(response: Response) => void> = [];
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => { replies.push(resolve); }));
  render(<Harness />); await advance(0); await upload();
  const mapping = { version: 1, kind: 'table.mapping', title: 'Fire ratings', identity: { column: 'GlobalId', key: 'GlobalId' },
    columns: [{ column: 'FireRating', target: 'property', pset: 'Pset_Custom', name: 'FireRating', valueType: 'text' }] };
  const response = () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(mapping) }, finish_reason: 'stop' }] })}\n\n`);
  click(button('Suggest mapping'));
  for (let i = 0; i < 20 && replies.length === 0; i++) await advance(10);
  assert.equal(replies.length, 1);
  selectModel('b'); await advance(0);
  replies[0](response()); await advance(100);
  assert.equal(document.querySelector('section[aria-label="Suggested table mapping"]'), null);
  assert.equal(button('Suggest mapping').disabled, false);
  click(button('Suggest mapping'));
  for (let i = 0; i < 20 && replies.length < 2; i++) await advance(10);
  assert.equal(replies.length, 2);
  replies[1](response()); await advance(100);
  assert.ok(document.querySelector('section[aria-label="Suggested table mapping"]'), 'a fresh request still works');
});

for (const partial of [false, true]) test(`#8962 replacing CSV during ${partial ? 'apply' : 'matching'} retires A and keeps B importable`, async t => {
  if (partial) useViewerStore.setState({ ...fixtureModels(await parsedModel('a', 201)) });
  render(<Harness />); await advance(0); await upload(partial ? 201 : 2);
  const view = useViewerStore.getState().getMutationView('a'); assert.ok(view);
  const target = mappingTarget();
  t.mock.timers.enable({ apis: ['setTimeout'] }); click(importButton());
  if (partial) {
    for (let i = 0; i < 10 && view.getModifiedEntityCount() === 0; i++) await ticks(t, 1);
    assert.equal(view.getModifiedEntityCount(), 200);
  }
  chooseCsv('b.csv', `GlobalId,FireRating\n${guid(1)},CSV-B\n`);
  await ticks(t, 80);
  assert.match(document.body.textContent ?? '', /b\.csv/);
  assert.equal(view.getModifiedEntityCount(), partial ? 200 : 0, 'A cannot apply its remaining batch');
  assert.equal(importButton().disabled, false, 'A cannot mark B clean');
  if (partial) {
    act(() => replayWorkspaceHistory(useViewerStore.getState(), 'undo'));
    assert.equal(view.getModifiedEntityCount(), 0, 'already applied A batch retains history');
  }
  click(importButton()); await ticks(t);
  assert.equal(view.getPropertyValue(1, target.pset, target.property), 'CSV-B');
  assert.equal(view.getModifiedEntityCount(), 1);
});

test('#8962 replacing CSV retires an AI mapping for the same model', async t => {
  useViewerStore.setState({ chatActiveModel: 'openai/gpt-free' });
  const replies: Array<(response: Response) => void> = [];
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => replies.push(resolve)));
  render(<Harness />); await advance(0); await upload();
  const response = () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({
    version: 1, kind: 'table.mapping', title: 'Fire ratings', identity: { column: 'GlobalId', key: 'GlobalId' },
    columns: [{ column: 'FireRating', target: 'property', pset: 'Pset_Custom', name: 'FireRating', valueType: 'text' }],
  }) }, finish_reason: 'stop' }] })}\n\n`);
  click(button('Suggest mapping'));
  for (let i = 0; i < 20 && replies.length === 0; i++) await advance(10);
  assert.equal(replies.length, 1);
  chooseCsv('b.csv', `GlobalId,FireRating\n${guid(1)},CSV-B\n`); await advance(50);
  replies[0](response()); await advance(100);
  assert.equal(document.querySelector('section[aria-label="Suggested table mapping"]'), null);
  assert.equal(button('Suggest mapping').disabled, false);
  click(button('Suggest mapping'));
  for (let i = 0; i < 20 && replies.length < 2; i++) await advance(10);
  assert.equal(replies.length, 2); replies[1](response()); await advance(100);
  assert.ok(document.querySelector('section[aria-label="Suggested table mapping"]'));
});
