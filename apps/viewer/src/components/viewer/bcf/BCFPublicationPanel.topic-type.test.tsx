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
import { act, useState } from 'react';
import { render, cleanup, click, waitFor } from '@/test/render.js';
import { connectPeer, reviewedBatch } from '@/test/bcf-publication-fixture';
import { bcfDraftLibrary, saveDraftBatch, useBcfDraftLibrary } from '@/lib/bcf-drafts/draft-library';
import { initializeBcfOutbox } from '@/lib/bcf-publication/outbox-store';
import { BCFDraftsDialog } from './BCFDraftsDialog';
import { BCFPublicationPanel } from './BCFPublicationPanel';
import { stageBcfPublicationReview, useBcfPublicationReview } from '@/lib/bcf-publication/review-candidate';
import { planDraftPublication } from '@/lib/bcf-publication/outbox-plan';
import { preflightPublication } from '@/lib/bcf-publication/outbox-preflight';
import { loadBcfServerConfig, saveBcfServerConfig } from '@/services/bcf-server';
import { LOCAL_BCF_USER } from '@/test/bcf-http-server';
import { deferred } from '@/test/race';

afterEach(cleanup);

test('#10589 adopts a staged review once and clears its display on a batch switch', async t => {
  const peer = await connectPeer(t, { topicTypes: SERVER_TYPES });
  const batch = await reviewedBatch();
  const plan = await planDraftPublication(batch, undefined, peer.target);
  const report = await preflightPublication(peer.connection.client, plan.record);
  t.after(() => useBcfPublicationReview.setState({ candidate: null }));
  let notifications = 0;
  const onRecordId = () => undefined;
  function Panel() {
    const [current, setCurrent] = useState(batch);
    const [, setUsers] = useState<string[]>([]);
    return <>
      <button onClick={() => setCurrent({ ...batch, id: 'another-batch' })}>Switch batch</button>
      <BCFPublicationPanel batch={current} onRecordId={onRecordId}
        onUsers={users => { if (++notifications <= 2) setUsers(users); }} />
    </>;
  }
  const ui = render(<Panel />);
  await waitFor(() => ui.querySelector('select option') !== null, 'publication project loaded');
  act(() => {
    stageBcfPublicationReview(batch, peer.target, {}, plan, {
      ...report, extensions: { ...report.extensions, user_id_type: undefined },
    });
  });
  assert.equal(notifications, 1);
  assert.ok(ui.querySelector('output'));
  click(button(/^Switch batch$/));
  assert.ok(!ui.querySelector('output'), 'the old batch review is gone');
  assert.equal(useBcfPublicationReview.getState().candidate, null);
});

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

test('#10589 clears a native check after editing a batch in place', async t => {
  await connectPeer(t, { topicTypes: SERVER_TYPES });
  const batch = await reviewedBatch();
  const ignore = () => undefined;
  function Panel() {
    const [current, setCurrent] = useState(batch);
    return <>
      <button onClick={() => setCurrent({ ...batch, modifiedAt: new Date(Date.parse(batch.modifiedAt) + 1000).toISOString() })}>Edit batch</button>
      <BCFPublicationPanel batch={current} onRecordId={ignore} onUsers={ignore} />
    </>;
  }
  const ui = render(<Panel />);
  await waitFor(() => !button(/^Check project$/).disabled, 'project check is ready');
  click(button(/^Check project$/));
  await waitFor(() => ui.querySelector('output') !== null && ui.querySelectorAll('select').length > 1, 'topic-type review is displayed');
  click(button(/^Edit batch$/));
  assert.ok(!ui.querySelector('output'), 'the previous revision review is gone');
  assert.equal(ui.querySelectorAll('select').length, 1, 'only the project picker remains');
});

test('#10589 keeps a newly staged review when an older Check finishes for the same target', async t => {
  const peer = await connectPeer(t, { topicTypes: SERVER_TYPES });
  const batch = await reviewedBatch();
  const plan = await planDraftPublication(batch, undefined, peer.target);
  const report = await preflightPublication(peer.connection.client, plan.record);
  t.after(() => useBcfPublicationReview.setState({ candidate: null }));

  const responseReady = deferred();
  const releaseResponse = deferred();
  t.after(() => releaseResponse.resolve());
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
    const response = await realFetch(...args);
    const input = args[0];
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname.endsWith('/extensions')) {
      responseReady.resolve();
      await releaseResponse.promise;
    }
    return response;
  });

  const users: string[][] = [];
  render(<BCFPublicationPanel batch={batch} onRecordId={() => undefined} onUsers={choices => users.push(choices)} />);
  const check = () => button(/^Check project$/);
  await waitFor(() => !check().disabled, 'project check is ready');
  click(check());
  await waitFor(() => responseReady.settled(), 'the older Check has a response held in flight');
  const candidateUser = 'candidate@example.test';
  act(() => {
    stageBcfPublicationReview(batch, peer.target, {}, plan, { ...report, extensions: { ...report.extensions, user_id_type: [candidateUser] } }, Date.now() + 1);
  });
  assert.deepEqual(users, [[candidateUser]], 'the new candidate was adopted while Check was pending');
  releaseResponse.resolve();
  await waitFor(() => !check().disabled, 'the older Check completed');
  assert.deepEqual(users, [[candidateUser]], 'the older response did not overwrite the candidate');
});

test('#10589 clears published assignee choices when switching accounts on the same server', async t => {
  await connectPeer(t, { topicTypes: SERVER_TYPES });
  const batch = await reviewedBatch();
  const config = loadBcfServerConfig();
  assert.ok(config);
  const onRecordId = () => undefined;
  function Panel() {
    const [users, setUsers] = useState<string[]>([]);
    return <>
      <div data-test="assignees">{users.join(', ')}</div>
      <BCFPublicationPanel batch={batch} onRecordId={onRecordId} onUsers={setUsers} />
    </>;
  }
  const ui = render(<Panel />);
  const assignees = () => ui.querySelector('[data-test="assignees"]')?.textContent;
  await waitFor(() => !button(/^Check project$/).disabled, 'project check is ready');
  click(button(/^Check project$/));
  await waitFor(() => assignees() === LOCAL_BCF_USER, 'project check supplies server assignees');
  act(() => saveBcfServerConfig({ ...config, userId: 'other-coordinator@example.test' }));
  assert.equal(assignees(), '', 'the old account’s users are cleared before another Check');
});

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
  assert.doesNotMatch(text(), /Nothing was sent: \d+ problem/, 'no problem count for what the picker resolves (#8656 review)');
  assert.match(text(), /Nothing was sent: choose a server topic type below\./, 'the refusal stays visible beside the picker');

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

  // #9163: receiving the request is earlier than rendering its response.
  // Hold the real response so this ordering is exercised even on an idle host.
  let releaseProjects!: () => void;
  const projectsReady = new Promise<void>(resolve => { releaseProjects = resolve; });
  t.after(releaseProjects);
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
    const response = await realFetch(...args);
    const input = args[0];
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === '/bcf/2.1/projects') await projectsReady;
    return response;
  });

  // Reconnect to another server that offers the same types; the project id is the same.
  const other = await connectPeer(t, { topicTypes: SERVER_TYPES, topicStatuses: ['Draft', 'Open', 'Closed'] });
  await waitFor(() => other.state.projectListReads > 0 && findPicker() === null, 'the other server listed, the old check cleared');
  assert.equal(button(/^Publish 2 topics$/).disabled, true, 'the old readiness condition precedes the response');
  releaseProjects();
  await waitFor(() => !button(/^Publish 2 topics$/).disabled, 'the new connection is ready to publish');
  click(button(/^Publish 2 topics$/));
  await waitFor(() => findPicker() !== null, 'the picker is shown again for the new server');
  assert.equal(other.state.receivedWrites, 0, 'nothing published under a choice made for another server');
  assert.equal(findPicker()!.value, 'Model Issue', 'the closest type is preselected afresh');
});
