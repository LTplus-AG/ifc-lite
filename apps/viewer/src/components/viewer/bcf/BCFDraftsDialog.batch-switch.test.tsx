/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Switching batch in the drafts dialog through its <select>: the edit lane and
 * the reconcile section belong to the batch on screen. An edit still computing
 * for the previous batch does not hold the new batch's editor, and the previous
 * batch's reconcile notice does not describe the new one. Plain-value
 * assertions only.
 */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup } from '@/test/render.js';
import { reviewedBatch } from '@/test/bcf-publication-fixture';
import { bcfDraftLibrary, saveDraftBatch, useBcfDraftLibrary } from '@/lib/bcf-drafts/draft-library';
import { initializeBcfOutbox } from '@/lib/bcf-publication/outbox-store';
import { useViewerStore } from '@/store';
import type { DraftBatch } from '@/lib/bcf-drafts/draft-types';
import { BCFDraftsDialog } from './BCFDraftsDialog';

afterEach(() => { cleanup(); useViewerStore.setState({ clashResult: null }); });

async function openDialogWith(first: DraftBatch, second: DraftBatch): Promise<void> {
  await act(async () => {
    await bcfDraftLibrary.initialize();
    await initializeBcfOutbox();
    assert.equal(await saveDraftBatch(first), true);
    assert.equal(await saveDraftBatch(second), true);
    useBcfDraftLibrary.setState({ activeId: first.id });
  });
  render(<BCFDraftsDialog open onOpenChange={() => undefined} />);
}

function batchSelect(id: string): HTMLSelectElement {
  const found = [...document.body.querySelectorAll('select')].find(node => [...node.options].some(option => option.value === id));
  assert.ok(found, 'the batch picker');
  return found;
}
/** What choosing a batch in the picker dispatches. */
const choose = (select: HTMLSelectElement, id: string) => {
  select.value = id;
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
};
const removeButtons = () => [...document.body.querySelectorAll('button')]
  .filter(node => /^Remove .* from this topic$/.test(node.getAttribute('aria-label') ?? ''));
const editorHeld = () => document.body.querySelector('fieldset')?.disabled ?? null;
const text = () => document.body.textContent ?? '';

test('an edit still computing for the previous batch does not hold the new batch\'s editor', async () => {
  const first = await reviewedBatch();
  const second = await reviewedBatch();
  await openDialogWith(first, second);
  const picker = batchSelect(second.id);
  const remove = removeButtons()[0];
  assert.ok(remove, 'the first batch offers removing a member');
  // The press starts an edit that cannot settle before the microtask queue runs,
  // so the switch below lands while it is still computing.
  act(() => {
    remove.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    choose(picker, second.id);
  });
  assert.equal(useBcfDraftLibrary.getState().activeId, second.id);
  assert.equal(editorHeld(), false, 'the new batch is editable at once');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
  const firstNow = useBcfDraftLibrary.getState().entries.find(entry => entry.id === first.id);
  assert.equal(firstNow?.topics[0].members.length, first.topics[0].members.length - 1, 'the switched-away edit still lands in its own batch');
  const secondNow = useBcfDraftLibrary.getState().entries.find(entry => entry.id === second.id);
  assert.equal(secondNow?.topics[0].members.length, second.topics[0].members.length, 'and never in the new one');
});

test('the previous batch\'s reconcile notice does not carry over to the new batch', async () => {
  const first = await reviewedBatch();
  const second = await reviewedBatch();
  await openDialogWith(first, second);
  useViewerStore.setState({ clashResult: null });
  const compare = [...document.body.querySelectorAll('button')].find(node => node.textContent?.trim() === 'Compare');
  assert.ok(compare, 'the reconcile section offers Compare');
  act(() => { compare.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  assert.equal(text().includes('No clash run is loaded to compare with.'), true, 'Compare reports on the first batch');
  act(() => choose(batchSelect(second.id), second.id));
  assert.equal(text().includes('No clash run is loaded to compare with.'), false, 'the new batch starts without the old notice');
});
