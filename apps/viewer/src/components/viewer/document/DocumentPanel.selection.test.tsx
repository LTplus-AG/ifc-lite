/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import '@/test/content-fixture.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, click, activate, waitFor, cleanup } from '@/test/render';
import { useViewerStore } from '@/store';
import { blankDocument } from '@/lib/document/presets';
import { loadDocuments } from '@/lib/document/persistence';
import { refuseContentWrites } from '@/test/content-fixture';
import { DocumentPanel } from './DocumentPanel';

afterEach(cleanup);
const spec = (id = 'selection-document') => ({ ...blankDocument(), id, name: id,
  blocks: ['a', 'b', 'c', 'd', 'e'].map(id => ({ kind: 'text' as const, id, text: id.toUpperCase(), style: 'body' as const })) });
async function mount() {
  await act(async () => {
    await useViewerStore.getState().upsertDocument(spec());
    useViewerStore.getState().setActiveDocumentId('selection-document');
  });
  const ui = render(<DocumentPanel />);
  await waitFor(() => !!ui.querySelector('[data-preview-block="e"]'), 'preview ready');
  return ui;
}
function element<T extends HTMLElement = HTMLElement>(ui: HTMLElement, selector: string): T {
  const result = ui.querySelector<T>(selector); assert.ok(result, selector); return result;
}
const checkbox = (ui: HTMLElement, id: string) => element<HTMLInputElement>(ui, `[data-block-list-item="${id}"] input[type="checkbox"]`);
const preview = (ui: HTMLElement, id: string) => element(ui, `[data-preview-block="${id}"]`);
const order = () => useViewerStore.getState().documents.find(document => document.id === useViewerStore.getState().activeDocumentId)!.blocks.map(block => block.id).join('');
function bottom(ui: HTMLElement) {
  const button = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Move to bottom');
  assert.ok(button); click(button);
}
function dragEvent(target: HTMLElement, type: string, transfer = new window.DataTransfer()) {
  act(() => { target.dispatchEvent(new window.DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer })); });
  return transfer;
}

it('#8066 shares explicit selection between list and preview without field focus collapsing the group', async () => {
  const ui = await mount();
  click(checkbox(ui, 'd')); activate(preview(ui, 'b'));
  assert.equal(checkbox(ui, 'b').checked, true);
  assert.equal(preview(ui, 'd').getAttribute('aria-pressed'), 'true');
  act(() => element(ui, '[data-block-editor="a"] textarea').focus());
  assert.equal(checkbox(ui, 'd').checked, true);
  assert.equal(checkbox(ui, 'b').checked, true);
  activate(preview(ui, 'b'), ' ');
  assert.equal(checkbox(ui, 'b').checked, false);
  click(checkbox(ui, 'b'));
  bottom(ui);
  assert.equal(order(), 'acebd', 'selection click order does not reverse authored order');
  await waitFor(() => useViewerStore.getState().documentsStorage.items['selection-document'] === 'saved', 'reorder persisted');
  assert.equal((await loadDocuments()).find(document => document.id === 'selection-document')?.blocks.map(block => block.id).join(''), 'acebd');
  const select = element<HTMLSelectElement>(ui, 'select[aria-label="Move selected before…"]');
  act(() => { select.value = 'a'; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
  assert.equal(order(), 'bdace', 'keyboard destination uses the same stable group move');
});

it('#8066 drags selected groups, moves an unselected handle alone, and ignores foreign or cancelled drags', async () => {
  const ui = await mount();
  click(checkbox(ui, 'd')); click(checkbox(ui, 'b'));
  const handle = element(ui, '[data-block-list-item="b"] button[draggable]');
  const transfer = dragEvent(handle, 'dragstart');
  const end = element(ui, '[data-block-drop-end]');
  dragEvent(end, 'dragover', transfer); dragEvent(end, 'drop', transfer); dragEvent(handle, 'dragend', transfer);
  assert.equal(order(), 'acebd');
  const c = element(ui, '[data-block-list-item="c"] button[draggable]');
  const single = dragEvent(c, 'dragstart');
  dragEvent(element(ui, '[data-block-list-item="a"]'), 'drop', single); dragEvent(c, 'dragend', single);
  assert.equal(order(), 'caebd');
  assert.equal(checkbox(ui, 'b').checked, false);
  assert.equal(checkbox(ui, 'c').checked, true);
  dragEvent(end, 'drop'); assert.equal(order(), 'caebd', 'external drops do not reorder');
  dragEvent(c, 'dragstart'); dragEvent(c, 'dragend'); dragEvent(end, 'drop');
  assert.equal(order(), 'caebd', 'cancelled drag cannot be resurrected by a drop');
});

it('#8066 resets selection and drag between documents sharing IDs and prunes a removed block', async () => {
  const ui = await mount();
  click(checkbox(ui, 'b')); click(checkbox(ui, 'd'));
  const stalePreview = preview(ui, 'b');
  click(element(ui, '[data-block-editor="b"] button[aria-label="Remove block"]'));
  click(stalePreview);
  bottom(ui); assert.equal(order(), 'aced', 'deleted selection cannot affect the remaining group');
  const transfer = dragEvent(element(ui, '[data-block-list-item="d"] button[draggable]'), 'dragstart');
  await act(async () => {
    await useViewerStore.getState().upsertDocument(spec('other-document'));
    useViewerStore.getState().setActiveDocumentId('other-document');
  });
  assert.equal(checkbox(ui, 'd').checked, false);
  dragEvent(element(ui, '[data-block-drop-end]'), 'drop', transfer);
  assert.equal(order(), 'abcde');
  act(() => useViewerStore.getState().setActiveDocumentId('selection-document'));
  assert.equal(checkbox(ui, 'd').checked, false, 'returning does not resurrect selection');
});

it('#8066 a move reads current content and keeps unsaved ordering visible when storage refuses it', async () => {
  const ui = await mount();
  click(checkbox(ui, 'b'));
  const transfer = dragEvent(element(ui, '[data-block-list-item="b"] button[draggable]'), 'dragstart');
  await act(async () => {
    const current = useViewerStore.getState().documents.find(document => document.id === 'selection-document')!;
    await useViewerStore.getState().upsertDocument({ ...current, blocks: current.blocks.map(block => block.id === 'b' && block.kind === 'text' ? { ...block, text: 'Edited during drag' } : block) });
  });
  const refusal = refuseContentWrites();
  try {
  dragEvent(element(ui, '[data-block-drop-end]'), 'drop', transfer);
  assert.equal(order(), 'acdeb');
  const block = useViewerStore.getState().documents.find(document => document.id === 'selection-document')!.blocks.at(-1);
  assert.ok(block?.kind === 'text'); assert.equal(block.text, 'Edited during drag');
  await waitFor(() => useViewerStore.getState().documentsStorage.items['selection-document'] === 'quota', 'refused write reported');
  assert.equal(order(), 'acdeb');
  assert.match(ui.querySelector('[data-content-storage] [role="alert"]')?.textContent ?? '', /Browser storage is full/);
  } finally { refusal.mock.restore(); }
});
