/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/content-fixture.js';
import { installLayout } from '@/test/dom-layout';
installLayout();
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, type, waitFor } from '@/test/render';
import { documentPreviewReady } from '@/test/document-preview';
import { useViewerStore } from '@/store';
import { namedButton } from '@/test/palette-destinations';
import { loadDocuments } from '@/lib/document/persistence';
import { seedPanelWitness, mountPanelWitness, openPanelWitness, closePanelWitness,
  element, choose, openMenu, menuItem } from '@/test/palette-document-panel-witness';

const initial = useViewerStore.getState();
let host: ReturnType<typeof mountPanelWitness> | undefined;
beforeEach(seedPanelWitness);
afterEach(async () => {
  cleanup(); await host?.dispose(); host = undefined;
  useViewerStore.setState(initial, true); localStorage.clear();
});

for (const existing of [false, true]) test(`#8947 palette Document configures ${existing ? 'existing' : 'new preset'} document and cancels rename before reopen`, async () => {
  let existingId: string | undefined;
  if (existing) {
    const { blankDocument } = await import('@/lib/document/presets');
    const saved = { ...blankDocument(), name: 'Existing coordination document' };
    assert.equal(await useViewerStore.getState().upsertDocument(saved), true);
    useViewerStore.getState().setActiveDocumentId(saved.id); existingId = saved.id;
  }
  host = mountPanelWitness();
  const body = await openPanelWitness('document', '[data-document-panel]');
  await waitFor(() => !!body.querySelector('textarea'), 'actual block editor');
  if (!existing) choose('select[aria-label="Document"]', 'preset:Blank page', body);
  else assert.equal(element<HTMLSelectElement>('select[aria-label="Document"]', body).value, existingId);
  await waitFor(() => !!body.querySelector('textarea'), 'chosen document configuration');
  choose('select[aria-label="Page size"]', 'A3', body);
  choose('select[aria-label="Orientation"]', 'landscape', body);
  type(element<HTMLTextAreaElement>('textarea', body), 'Palette configuration witness');
  await documentPreviewReady();
  assert.ok([...body.querySelectorAll('[data-block-text]')].some(node => node.textContent === 'Palette configuration witness'), 'real document preview reflects the configured block');
  const current = useViewerStore.getState();
  const configured = current.documents.find(d => d.id === current.activeDocumentId); assert.ok(configured);
  assert.deepEqual(configured.page, { size: 'A3', orientation: 'landscape' });
  assert.ok(configured.blocks.some(b => b.kind === 'text' && b.text === 'Palette configuration witness'));
  for (let attempt = 0; attempt < 2; attempt++) {
    openMenu(namedButton('Document actions', body)); click(menuItem('Rename'));
    await waitFor(() => !!document.querySelector('[role="dialog"] input'), 'real rename prompt');
    const dialog = element('[role="dialog"]');
    assert.equal(element<HTMLInputElement>('input', dialog).value, configured.name, 'cancelled draft did not leak');
    type(element<HTMLInputElement>('input', dialog), 'Discard this rename');
    click(namedButton('Cancel', dialog));
    await waitFor(() => !document.querySelector('[role="dialog"]'), 'rename cancelled');
    assert.equal(useViewerStore.getState().documents.find(d => d.id === configured.id)?.name, configured.name);
  }
  await act(async () => { await useViewerStore.getState().retryDocumentsSave(); });
  assert.deepEqual((await loadDocuments()).find(d => d.id === configured.id)?.page, configured.page);
  closePanelWitness(); assert.equal(document.querySelector('[data-document-panel]'), null);
  const reopened = await openPanelWitness('document', '[data-document-panel]');
  assert.equal(element<HTMLSelectElement>('select[aria-label="Document"]', reopened).value, configured.id);
  assert.equal(element<HTMLSelectElement>('select[aria-label="Page size"]', reopened).value, 'A3');
  assert.equal(element<HTMLSelectElement>('select[aria-label="Orientation"]', reopened).value, 'landscape');
});

for (const save of [false, true]) test(`#8947 palette Lists New builder configures a column then ${save ? 'saves, edits and launches' : 'cancels and reopens'}`, async () => {
  host = mountPanelWitness();
  await openPanelWitness('lists', '[data-list-name]');
  click(namedButton('New list'));
  const name = element<HTMLInputElement>('input[aria-label="List name"]'); type(name, 'Palette list');
  const custom = [...document.querySelectorAll('button')].find(b => b.textContent?.startsWith('Custom column'));
  assert.ok(custom); click(custom);
  type(element<HTMLInputElement>('input[aria-label="Property set"]'), 'Pset_SlabCommon');
  type(element<HTMLInputElement>('input[aria-label="Property name"]'), 'FireRating');
  const add = namedButton('Add custom column'); assert.equal(add.disabled, false); click(add);
  assert.match(document.body.textContent ?? '', /FireRating/);
  if (!save) {
    click(namedButton('Cancel'));
    assert.equal(useViewerStore.getState().listDefinitions.length, 0);
    click(namedButton('New list'));
    assert.notEqual(element<HTMLInputElement>('input[aria-label="List name"]').value, 'Palette list');
    assert.equal(document.querySelector('input[aria-label="Property name"]'), null);
    return;
  }
  click(namedButton('Save'));
  const saved = useViewerStore.getState().listDefinitions.find(d => d.name === 'Palette list'); assert.ok(saved);
  assert.ok(saved.columns.some(c => c.source === 'property' && c.psetName === 'Pset_SlabCommon' && c.propertyName === 'FireRating'));
  click(namedButton('Edit list Palette list'));
  assert.equal(element<HTMLInputElement>('input[aria-label="List name"]').value, 'Palette list');
  assert.match(document.body.textContent ?? '', /FireRating/);
  click(namedButton('Edit column'));
  type(element<HTMLInputElement>('input[aria-label="Property name"]'), 'DiscardedProperty');
  type(element<HTMLInputElement>('input[aria-label="List name"]'), 'Cancelled edit');
  click(namedButton('Cancel'));
  assert.equal(useViewerStore.getState().listDefinitions.find(d => d.id === saved.id)?.name, 'Palette list');
  assert.deepEqual(useViewerStore.getState().listDefinitions.find(d => d.id === saved.id)?.columns, saved.columns, 'cancel preserves the saved column configuration');
  click(namedButton('Run list Palette list'));
  await waitFor(() => !useViewerStore.getState().listExecuting && !!useViewerStore.getState().listResult, 'real list execution');
  assert.equal(useViewerStore.getState().listError, null);
  assert.ok(namedButton('Edit configuration'), 'actual result body reached');
  assert.equal(useViewerStore.getState().activeListId, saved.id);
});
