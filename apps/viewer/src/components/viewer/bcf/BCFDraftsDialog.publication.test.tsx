/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #6896: the mounted drafts dialog publishes to the loopback BCF peer, shows
// per-topic receipts, explains an unknown outcome, and resolves it with an
// explicit server check — without a duplicate topic.

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, click, waitFor } from '@/test/render.js';
import { connectPeer, reviewedBatch } from '@/test/bcf-publication-fixture';
import { LOCAL_BCF_USER } from '@/test/bcf-http-server';
import { bcfDraftLibrary, saveDraftBatch, useBcfDraftLibrary } from '@/lib/bcf-drafts/draft-library';
import { initializeBcfOutbox } from '@/lib/bcf-publication/outbox-store';
import { BCFDraftsDialog } from './BCFDraftsDialog';

afterEach(cleanup);

const text = () => document.body.textContent ?? '';
function button(label: RegExp): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find(item => label.test(item.textContent ?? ''));
  if (!found) throw new Error(`no button ${label}`);
  return found;
}
function topicRegion(title: string): HTMLElement {
  const region = document.body.querySelector(`section[aria-label="Draft topic ${title}"]`);
  if (!(region instanceof HTMLElement)) throw new Error(`no topic ${title}`);
  return region;
}

test('publish shows per-topic receipts, explains an unknown outcome and resolves it by checking the server', async t => {
  const peer = await connectPeer(t);
  const batch = await reviewedBatch();
  await act(async () => {
    await bcfDraftLibrary.initialize();
    await initializeBcfOutbox();
    assert.equal(await saveDraftBatch(batch), true);
    useBcfDraftLibrary.setState({ activeId: batch.id });
  });
  render(<BCFDraftsDialog open onOpenChange={() => undefined} />);
  await waitFor(() => document.body.querySelectorAll('section[aria-label="Publish to the BCF server"] option').length === 1, 'server projects listed');

  click(button(/^Check project$/));
  await waitFor(() => /The project accepts this batch/.test(text()), 'preflight result shown');
  const assignee = topicRegion('Riser through core walls').querySelector('select');
  assert.ok(assignee);
  assert.deepEqual([...assignee.options].map(option => option.value), ['', LOCAL_BCF_USER], 'assignees come only from the server user list');

  peer.state.loseNextWriteResponse = true;
  click(button(/^Publish 2 topics$/));
  await waitFor(() => /Sent 3: 2 confirmed, 0 refused, 1 unknown, 2 waiting/.test(text()), 'dispatch report');
  assert.match(topicRegion('Riser through core walls').textContent ?? '', /Publication outcome unknown/);
  assert.match(topicRegion('East wall penetration').textContent ?? '', /Published as server topic [0-9a-f-]{36}/);
  const guidance = [...document.body.querySelectorAll('[role="alert"]')].map(node => node.textContent).join(' ');
  assert.match(guidance, /never sent again automatically/);
  assert.equal(peer.state.topics.size, 2, 'the lost create was committed by the server');

  click(button(/^Publish 2 topics$/));
  await waitFor(() => /Sent 0:/.test(text()), 'republish sends nothing while the outcome is unknown');
  assert.equal(peer.state.receivedWrites, 3);

  click(button(/^Check server$/));
  await waitFor(() => /Published as server topic/.test(topicRegion('Riser through core walls').textContent ?? ''), 'check recorded the receipt');
  click(button(/^Publish 2 topics$/));
  await waitFor(() => /Sent 2:/.test(text()) && /5 of 5 writes confirmed/.test(text()), 'dependents resumed');
  assert.equal(peer.state.topics.size, 2, 'no duplicate topic');
  assert.match(text(), /5 of 5 writes confirmed/);
});

test('reviewers split and merge topics in the dialog and every edit is saved durably', async () => {
  const batch = await reviewedBatch();
  await act(async () => {
    await bcfDraftLibrary.initialize();
    assert.equal(await saveDraftBatch(batch), true);
    useBcfDraftLibrary.setState({ activeId: batch.id });
  });
  render(<BCFDraftsDialog open onOpenChange={() => undefined} />);
  const riser = topicRegion('Riser through core walls');
  const splitBoxes = [...riser.querySelectorAll('input[type="checkbox"]')].filter(box => /for splitting/.test(box.getAttribute('aria-label') ?? ''));
  assert.equal(splitBoxes.length, 3);
  click(splitBoxes[2]);
  click(button(/^Split 1 finding into a new topic$/));
  await waitFor(() => useBcfDraftLibrary.getState().entries[0]?.topics.length === 3
    && useBcfDraftLibrary.getState().status.items[batch.id] === 'saved', 'split committed');
  assert.deepEqual(useBcfDraftLibrary.getState().entries[0].topics.map(topic => topic.members.length), [2, 1, 1]);

  click(document.body.querySelector('input[aria-label="Select Riser through core walls for merging"]') as Element);
  click(document.body.querySelector('input[aria-label="Select Riser through core walls (split) for merging"]') as Element);
  click(button(/^Merge selected \(2\)$/));
  await waitFor(() => useBcfDraftLibrary.getState().entries[0]?.topics.length === 2
    && useBcfDraftLibrary.getState().status.items[batch.id] === 'saved', 'merge committed');
  const merged = useBcfDraftLibrary.getState().entries[0].topics[0];
  assert.equal(merged.guid, batch.topics[0].guid, 'the merged topic keeps the original GUID');
  assert.equal(merged.members.length, 3);
});
