/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';
import { cleanup, click, render, type as typeInput, waitFor } from '@/test/render';
import { fixtureModel } from '@/test/store-fixture';
import { loadDialogs } from '@/test/dialog-host';
import { useViewerStore } from '@/store';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial); });

function setup(): void {
  const models = new Map([['A', {
    ...fixtureModel('A', { entities: [
      { expressId: 101, type: 'IfcWall', name: 'North wall' },
      { expressId: 102, type: 'IfcSlab', name: 'Ground slab' },
    ] }), maxExpressId: 102,
  }] as const]);
  useViewerStore.setState({
    models, activeModelId: 'A', mutationViews: new Map([['A', new MutablePropertyView(null, 'A')]]),
    undoStacks: new Map(), redoStacks: new Map(), mutationBatchTags: new Map(), dirtyModels: new Set(),
    mutationVersion: 0, editEnabled: true, collabRoomId: null, changeSets: new Map(), activeChangeSetId: null,
    cameraCallbacks: {},
  });
}

async function mount(): Promise<HTMLElement> {
  const { ConfirmDialogHost } = await loadDialogs();
  // Through the panel registry, as the sidebar renders it.
  return render(<>{renderPanelBody('changeSets', () => {})}<ConfirmDialogHost /></>);
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const match = [...scope.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label || b.textContent?.trim() === label);
  assert.ok(match, `Missing button: ${label}`);
  return match;
}

function rows(ui: HTMLElement): HTMLElement[] {
  return [...ui.querySelectorAll<HTMLElement>('[data-change-set-row]')];
}

function names(ui: HTMLElement): string[] {
  return rows(ui).map((row) => row.querySelector('[data-change-set-name]')?.textContent ?? '');
}

/** Answer the open prompt with `value`. */
async function answerPrompt(value: string): Promise<void> {
  await waitFor(() => document.querySelector('#viewer-prompt-value') !== null, 'the prompt opens');
  const input = document.querySelector<HTMLInputElement>('#viewer-prompt-value')!;
  typeInput(input, value);
  await act(async () => { click(document.querySelector<HTMLButtonElement>('[role="alertdialog"] button[type="submit"]')!); });
}

async function newSet(ui: HTMLElement, name: string): Promise<string> {
  click(button(ui, 'New'));
  await answerPrompt(name);
  const id = useViewerStore.getState().activeChangeSetId;
  assert.ok(id, `${name} is created active`);
  return id;
}

async function openedDialog(): Promise<HTMLElement> {
  await waitFor(() => document.querySelector('[role="alertdialog"]') !== null, 'the confirmation opens');
  return document.querySelector<HTMLElement>('[role="alertdialog"]')!;
}

async function withCapturedDownloads(run: (downloads: { blob: Blob; name: string }[]) => Promise<void>): Promise<void> {
  const downloads: { blob: Blob; name: string }[] = [];
  const createObjectURL = URL.createObjectURL;
  const revokeObjectURL = URL.revokeObjectURL;
  const anchorClick = HTMLAnchorElement.prototype.click;
  let pending: Blob | null = null;
  URL.createObjectURL = ((blob: Blob) => { pending = blob; return 'blob:change-sets-test'; }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { if (pending) downloads.push({ blob: pending, name: this.download }); pending = null; };
  try { await run(downloads); } finally {
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    HTMLAnchorElement.prototype.click = anchorClick;
  }
}

async function upload(ui: HTMLElement, file: File): Promise<void> {
  const input = ui.querySelector<HTMLInputElement>('[data-change-set-import]');
  assert.ok(input);
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); await file.text(); });
}

test('#6232 D4 New creates a named change set and makes it active', async () => {
  setup();
  const ui = await mount();
  assert.match(ui.textContent ?? '', /No change sets yet/);
  const first = await newSet(ui, 'Facade options');
  const second = await newSet(ui, 'Structure');
  assert.deepEqual(names(ui), ['Facade options', 'Structure']);
  assert.equal(useViewerStore.getState().activeChangeSetId, second);
  assert.notEqual(first, second);
  assert.equal(rows(ui)[1].dataset.active, 'true');
  assert.equal(rows(ui)[0].dataset.active, undefined);
  assert.match(rows(ui)[0].textContent ?? '', /0 edits/);
});

test('#6232 D4 Rename changes the name; cancelling keeps it', async () => {
  setup();
  const ui = await mount();
  const id = await newSet(ui, 'Draft');
  click(button(ui, 'Rename Draft'));
  await answerPrompt('Option B');
  assert.deepEqual(names(ui), ['Option B']);
  assert.equal(useViewerStore.getState().changeSets.get(id)?.name, 'Option B');
  assert.equal(useViewerStore.getState().activeChangeSetId, id, 'renaming keeps the set active');
  click(button(ui, 'Rename Option B'));
  const dialog = await openedDialog();
  await act(async () => { click(button(dialog, 'Cancel')); });
  assert.deepEqual(names(ui), ['Option B']);
});

test('#6232 D4 Active switches the set new edits land in, and can be turned off', async () => {
  setup();
  const ui = await mount();
  const a = await newSet(ui, 'A set');
  const b = await newSet(ui, 'B set');
  click(button(ui, 'Set active: A set'));
  assert.equal(useViewerStore.getState().activeChangeSetId, a);
  click(button(ui, 'Active: A set. Press to stop collecting edits into it'));
  assert.equal(useViewerStore.getState().activeChangeSetId, null);
  assert.match(ui.textContent ?? '', /No active change set/);
  click(button(ui, 'Set active: B set'));
  assert.equal(useViewerStore.getState().activeChangeSetId, b);
});

test('#6232 D4 edits land in the active set, grouped by element; undo takes them out, redo puts them back', async () => {
  setup();
  const ui = await mount();
  const facade = await newSet(ui, 'Facade');
  const store = () => useViewerStore.getState();
  act(() => {
    store().setProperty('A', 101, 'Pset_WallCommon', 'FireRating', 'EI60', PropertyValueType.Label);
    store().setProperty('A', 101, 'Pset_WallCommon', 'IsExternal', true, PropertyValueType.Boolean);
  });
  const slab = await newSet(ui, 'Slab');
  act(() => { store().setProperty('A', 102, 'Pset_SlabCommon', 'LoadBearing', true, PropertyValueType.Boolean); });

  assert.equal(store().changeSets.get(facade)?.mutations.length, 2);
  assert.equal(store().changeSets.get(slab)?.mutations.length, 1);
  assert.match(rows(ui)[0].textContent ?? '', /2 edits/);

  click(button(ui, 'Show the edits in Facade'));
  const elements = [...rows(ui)[0].querySelectorAll<HTMLElement>('[data-change-set-element]')];
  assert.deepEqual(elements.map((el) => el.dataset.changeSetElement), ['A:101'], 'both edits group under one element');
  assert.match(elements[0].textContent ?? '', /IfcWall #101 — North wall/);
  assert.match(elements[0].textContent ?? '', /Pset_WallCommon\.FireRating, Pset_WallCommon\.IsExternal/);
  click(elements[0]);
  assert.deepEqual(store().selectedEntity, { modelId: 'A', expressId: 101 }, 'a click selects the element');

  act(() => store().undo('A'));
  assert.equal(store().changeSets.get(slab)?.mutations.length, 0, 'undo takes the edit out of its set');
  act(() => store().redo('A'));
  assert.equal(store().changeSets.get(slab)?.mutations.length, 1, 'redo puts it back');
  assert.equal(store().changeSets.get(facade)?.mutations.length, 2, 'the other set is untouched');
});

test('#6232 D4 the first edit with no active set starts "Unsaved changes"', async () => {
  setup();
  const ui = await mount();
  act(() => { useViewerStore.getState().setProperty('A', 101, 'Pset_WallCommon', 'FireRating', 'EI30', PropertyValueType.Label); });
  assert.deepEqual(names(ui), ['Unsaved changes']);
  assert.match(rows(ui)[0].textContent ?? '', /1 edit/);
  assert.equal(rows(ui)[0].dataset.active, 'true');
});

test('#6232 D4 Export downloads the set and Import brings it back as a new set with the same edits', async () => {
  setup();
  const ui = await mount();
  const id = await newSet(ui, 'Share me');
  act(() => {
    useViewerStore.getState().setProperty('A', 101, 'Pset_WallCommon', 'FireRating', 'EI90', PropertyValueType.Label);
    useViewerStore.getState().setProperty('A', 102, 'Pset_SlabCommon', 'LoadBearing', false, PropertyValueType.Boolean);
  });
  await withCapturedDownloads(async (downloads) => {
    click(button(ui, 'Export Share me'));
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0].name, 'Share-me.changeset.json');
    const text = await downloads[0].blob.text();
    const parsed = JSON.parse(text) as { version: number; changeSet: { name: string; mutations: unknown[] } };
    assert.equal(parsed.version, 1);
    assert.equal(parsed.changeSet.name, 'Share me');
    assert.equal(parsed.changeSet.mutations.length, 2);

    await upload(ui, new File([text], 'Share-me.changeset.json', { type: 'application/json' }));
  });
  const sets = [...useViewerStore.getState().changeSets.values()];
  assert.equal(sets.length, 2);
  const imported = sets.find((set) => set.id !== id);
  assert.ok(imported);
  assert.equal(imported.name, 'Share me');
  assert.deepEqual(imported.mutations, useViewerStore.getState().changeSets.get(id)?.mutations);
  assert.equal(useViewerStore.getState().activeChangeSetId, id, 'importing does not steal the active set');
  const importedRow = rows(ui).find((row) => row.dataset.changeSetRow === imported.id);
  assert.ok(importedRow?.querySelector('[data-change-set-contents]'), 'the imported set opens to show its edits');
});

test('#6232 D4 Import refuses a file that is not a change set', async () => {
  setup();
  const ui = await mount();
  await upload(ui, new File(['{"hello":1}'], 'notes.json', { type: 'application/json' }));
  assert.equal(useViewerStore.getState().changeSets.size, 0);
  await upload(ui, new File(['not json'], 'broken.json', { type: 'application/json' }));
  assert.equal(useViewerStore.getState().changeSets.size, 0);
});

test('#6232 D4 Discard asks first; confirming removes the set and clears it as active', async () => {
  setup();
  const ui = await mount();
  const id = await newSet(ui, 'Throwaway');
  click(button(ui, 'Discard Throwaway'));
  const dialog = await openedDialog();
  assert.match(dialog.textContent ?? '', /The edits stay in the model/);
  await act(async () => { click(button(dialog, 'Cancel')); });
  assert.ok(useViewerStore.getState().changeSets.has(id), 'cancel keeps the set');

  click(button(ui, 'Discard Throwaway'));
  const again = await openedDialog();
  await act(async () => { click(button(again, 'Discard')); });
  assert.equal(useViewerStore.getState().changeSets.has(id), false);
  assert.equal(useViewerStore.getState().activeChangeSetId, null);
  assert.deepEqual(names(ui), []);
});
