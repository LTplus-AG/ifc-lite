/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A server with a fixed topic type list that lacks the drafts' type (buildagil
// has no Clash): the mounted dialog refuses before sending, offers the
// server's own types with the closest preselected, and publishes the topics
// as the type the coordinator picks.

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, click, waitFor } from '@/test/render.js';
import { connectPeer, reviewedBatch } from '@/test/bcf-publication-fixture';
import { bcfDraftLibrary, saveDraftBatch, useBcfDraftLibrary } from '@/lib/bcf-drafts/draft-library';
import { initializeBcfOutbox } from '@/lib/bcf-publication/outbox-store';
import { BCFDraftsDialog } from './BCFDraftsDialog';

afterEach(cleanup);

const SERVER_TYPES = ['Task', 'Model Issue', 'Documentation Log', 'Incident Log', 'Deficiency Log', 'Topic', 'Information', 'Decision'];
const text = () => document.body.textContent ?? '';
function button(label: RegExp): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find(item => label.test(item.textContent ?? ''));
  if (!found) throw new Error(`no button ${label}`);
  return found;
}
function choose(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
  if (!setter) throw new Error('no value setter on HTMLSelectElement.prototype');
  act(() => {
    setter.call(select, value);
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

test('an unknown draft topic type is mapped to a server type the coordinator picks before anything is sent', async t => {
  const peer = await connectPeer(t, { topicTypes: SERVER_TYPES, topicStatuses: ['Draft', 'Open', 'Closed'] });
  const batch = await reviewedBatch();
  await act(async () => {
    await bcfDraftLibrary.initialize();
    await initializeBcfOutbox();
    assert.equal(await saveDraftBatch(batch), true);
    useBcfDraftLibrary.setState({ activeId: batch.id });
  });
  render(<BCFDraftsDialog open onOpenChange={() => undefined} />);
  await waitFor(() => document.body.querySelectorAll('section[aria-label="Publish to the BCF server"] option').length === 1, 'server projects listed');

  click(button(/^Publish 2 topics$/));
  const findPicker = () => [...document.body.querySelectorAll('label')]
    .find(label => /This project has no topic type “Clash”/.test(label.textContent ?? ''))?.querySelector('select') ?? null;
  await waitFor(() => findPicker() !== null, 'type picker shown');
  const picker = findPicker();
  assert.ok(picker);
  assert.equal(peer.state.receivedWrites, 0, 'refused before sending');
  assert.deepEqual([...picker.options].map(option => option.value), SERVER_TYPES, 'only the server\'s own types');
  assert.equal(picker.value, 'Model Issue', 'the closest type is preselected');
  assert.doesNotMatch(text(), /topic_type “Clash” is not in/, 'the picker replaces the bare refusal');

  choose(picker, 'Information');
  click(button(/^Publish 2 topics$/));
  await waitFor(() => /5 of 5 writes confirmed/.test(text()), 'published');
  const types = [...peer.state.topics.values()].map(item => item.topic.topic_type);
  assert.deepEqual(types, ['Information', 'Information']);
});

test('a type choice does not follow a reconnect to another server (#8656 review)', async t => {
  await connectPeer(t, { topicTypes: SERVER_TYPES, topicStatuses: ['Draft', 'Open', 'Closed'] });
  const batch = await reviewedBatch();
  await act(async () => {
    await bcfDraftLibrary.initialize();
    await initializeBcfOutbox();
    assert.equal(await saveDraftBatch(batch), true);
    useBcfDraftLibrary.setState({ activeId: batch.id });
  });
  render(<BCFDraftsDialog open onOpenChange={() => undefined} />);
  await waitFor(() => document.body.querySelectorAll('section[aria-label="Publish to the BCF server"] option').length === 1, 'server projects listed');
  click(button(/^Publish 2 topics$/));
  const findPicker = () => [...document.body.querySelectorAll('label')]
    .find(label => /This project has no topic type “Clash”/.test(label.textContent ?? ''))?.querySelector('select') ?? null;
  await waitFor(() => findPicker() !== null, 'type picker shown');
  choose(findPicker()!, 'Information');

  // Reconnect to another server that offers the same types; the project id is the same.
  const other = await connectPeer(t, { topicTypes: SERVER_TYPES, topicStatuses: ['Draft', 'Open', 'Closed'] });
  await waitFor(() => other.state.projectListReads > 0 && findPicker() === null, 'the other server listed, the old check cleared');
  click(button(/^Publish 2 topics$/));
  await waitFor(() => findPicker() !== null, 'the picker is shown again for the new server');
  assert.equal(other.state.receivedWrites, 0, 'nothing published under a choice made for another server');
  assert.equal(findPicker()!.value, 'Model Issue', 'the closest type is preselected afresh');
});
