/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * C-2 (BCF drafts dialog): Publish, Export and an asynchronous edit each run
 * once per press burst, and the editor is held while an edit lands. The
 * mounted dialog runs against the loopback BCF peer. Plain-value assertions.
 */

import '@/test/setup-dom.js';
import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, waitFor } from '@/test/render.js';
import { connectPeer, reviewedBatch } from '@/test/bcf-publication-fixture';
import { bcfDraftLibrary, saveDraftBatch, useBcfDraftLibrary } from '@/lib/bcf-drafts/draft-library';
import { initializeBcfOutbox } from '@/lib/bcf-publication/outbox-store';
import type { DraftBatch } from '@/lib/bcf-drafts/draft-types';
import { BCFDraftsDialog } from './BCFDraftsDialog';

afterEach(() => { cleanup(); mock.restoreAll(); });

const text = () => document.body.textContent ?? '';
function button(label: RegExp): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find(item => label.test(item.textContent ?? ''));
  if (!found) throw new Error(`no button ${label}`);
  return found;
}
/** A double-click: both presses land in one act(), before React re-renders the control disabled. */
const pressTogether = (...nodes: Element[]) => act(() => {
  for (const node of nodes) node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
});

async function openDialog(batch: DraftBatch): Promise<void> {
  await act(async () => {
    await bcfDraftLibrary.initialize();
    await initializeBcfOutbox();
    assert.equal(await saveDraftBatch(batch), true);
    useBcfDraftLibrary.setState({ activeId: batch.id });
  });
  render(<BCFDraftsDialog open onOpenChange={() => undefined} />);
}

test('C-2 drafts: a double-pressed Publish sends each write once', async t => {
  const peer = await connectPeer(t);
  await openDialog(await reviewedBatch());
  await waitFor(() => document.body.querySelectorAll('section[aria-label="Publish to the BCF server"] option').length === 1, 'server projects listed');
  const publish = button(/^Publish 2 topics$/);
  pressTogether(publish, publish);
  await waitFor(() => /5 of 5 writes confirmed/.test(text()), 'the batch is published');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
  assert.equal(peer.state.receivedWrites, 5, 'no write was sent twice');
  assert.equal(peer.state.topics.size, 2, 'no duplicate topic');
});

test('C-2 drafts: a double-pressed Export writes one archive', async () => {
  const filenames: string[] = [];
  mock.method(URL, 'createObjectURL', () => 'blob:drafts-single-flight');
  mock.method(URL, 'revokeObjectURL', () => {});
  mock.method(window.HTMLAnchorElement.prototype, 'click', function (this: HTMLAnchorElement) { filenames.push(this.download); });
  await openDialog(await reviewedBatch());
  const exportButton = button(/^Export \.bcf$/);
  pressTogether(exportButton, exportButton);
  await waitFor(() => filenames.length > 0, 'the archive is written');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
  assert.equal(filenames.length, 1, 'one archive per press burst');
});

test('C-2 drafts: two asynchronous edits pressed together land once, and the editor is held meanwhile', async () => {
  const batch = await reviewedBatch();
  await openDialog(batch);
  const removes = [...document.body.querySelectorAll('button')]
    .filter(node => /^Remove .* from this topic$/.test(node.getAttribute('aria-label') ?? ''));
  assert.ok(removes.length >= 2, 'the first topic offers removing each member');
  const landed = new Set<object>();
  const unsubscribe = useBcfDraftLibrary.subscribe(state => {
    const entry = state.entries.find(item => item.id === batch.id);
    if (entry && entry.topics[0].members.length !== batch.topics[0].members.length) landed.add(entry);
  });
  try {
    pressTogether(removes[0], removes[1]);
    const editors = document.body.querySelector('fieldset');
    assert.equal(editors?.disabled, true, 'the editor is held while the edit lands');
    await waitFor(() => landed.size > 0, 'the edit lands');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
  } finally { unsubscribe(); }
  assert.equal(landed.size, 1, 'the second edit, computed from the same stale batch, never lands over the first');
  assert.equal(useBcfDraftLibrary.getState().entries.find(item => item.id === batch.id)?.topics[0].members.length,
    batch.topics[0].members.length - 1);
  assert.equal(document.body.querySelector('fieldset')?.disabled, false);
});
