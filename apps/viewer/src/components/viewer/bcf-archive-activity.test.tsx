/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #7140: actual mounted archive exports over real clash findings and authored
// SketchUp IFC identities. The native BCF writer/reader are never substituted.
import '@/test/setup-dom.js';
import { afterEach, beforeEach, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { readBCF } from '@ifc-lite/bcf';
import { cleanup, click, render, waitFor } from '@/test/render.js';
import { reviewedBatch } from '@/test/bcf-publication-fixture';
import { useViewerStore } from '@/store';
import { bcfDraftLibrary, saveDraftBatch, useBcfDraftLibrary } from '@/lib/bcf-drafts/draft-library';
import { draftBatchToProject, importDraftArchive } from '@/lib/bcf-drafts/draft-archive';
import { ACTIVITY_STORAGE_KEY, activityCanceller, useActivityJournal } from '@/lib/activity/activity-journal';
import { toast } from '@/components/ui/toast';
import { BCFPanel } from './BCFPanel';
import { BCFDraftsDialog } from './bcf/BCFDraftsDialog';
import { ActivityTrayList } from './activity/ActivityTrayList';

const initial = useViewerStore.getState();
const createObjectURL = URL.createObjectURL;
const revokeObjectURL = URL.revokeObjectURL;
const archives: Blob[] = [];
const jobs = () => useActivityJournal.getState().jobs;

beforeEach(() => {
  useViewerStore.setState({ ...initial, bcfLoading: false, bcfError: null, bcfProject: null });
  useActivityJournal.setState({ jobs: [] });
  archives.length = 0;
  URL.createObjectURL = blob => { assert.ok(blob instanceof Blob); archives.push(blob); return `blob:archive-${archives.length}`; };
  URL.revokeObjectURL = () => undefined;
});
afterEach(() => {
  cleanup();
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
  mock.restoreAll();
});

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find(item => (item.getAttribute('aria-label') ?? item.textContent) === label);
  assert.ok(found, `native ${label} control is mounted`);
  return found;
}
function running() {
  assert.equal(jobs().length, 1, 'actual native export registered one row');
  assert.equal(jobs()[0].outcome, 'running');
  assert.equal(activityCanceller(jobs()[0].id), null, 'the ZIP writer has no abort contract');
  assert.equal(document.querySelector('button[aria-label="Cancel Export BCF archive"]'), null);
  assert.match(document.querySelector('section[aria-label="Activity"]')?.textContent ?? '', /Export BCF archive/);
  return jobs()[0].id;
}
async function finished(count = 1) {
  await waitFor(() => jobs().length === count && jobs().every(job => job.outcome !== 'running'), 'native BCF publication finished');
  const persisted = JSON.parse(sessionStorage.getItem(ACTIVITY_STORAGE_KEY) ?? '[]') as Array<{ id: string; outcome: string }>;
  assert.deepEqual(persisted.map(job => [job.id, job.outcome]), jobs().map(job => [job.id, job.outcome]), 'terminal rows are durable in this tab');
}
async function mountDraft() {
  const batch = await reviewedBatch();
  await act(async () => {
    await bcfDraftLibrary.initialize();
    assert.equal(await saveDraftBatch(batch), true);
    useBcfDraftLibrary.setState({ activeId: batch.id });
  });
  render(<><BCFDraftsDialog open onOpenChange={() => undefined} /><ActivityTrayList /></>);
  return batch;
}

// Identical publication contract, exercised through both independently mounted callers.
test('BCF panel archive records native publication and retains authored topic identities (#7140)', async () => {
  const batch = await reviewedBatch();
  const project = draftBatchToProject(batch, 'coordinator@example.test');
  useViewerStore.setState({ bcfProject: project });
  render(<><BCFPanel onClose={() => undefined} /><ActivityTrayList /></>);
  click(button('Export BCF'));
  const id = running();
  await finished();
  assert.equal(jobs()[0].id, id);
  assert.equal(jobs()[0].outcome, 'completed');
  assert.equal(useViewerStore.getState().bcfLoading, false);
  assert.equal(archives.length, 1);
  const restored = await readBCF(await archives[0].arrayBuffer());
  assert.deepEqual([...restored.topics.keys()], batch.topics.map(topic => topic.guid));
  assert.deepEqual([...restored.topics.values()].map(topic => topic.title), batch.topics.map(topic => topic.title));
  assert.deepEqual([...restored.topics.values()].map(topic => topic.viewpoints[0]?.components?.selection?.map(component => component.ifcGuid)),
    batch.topics.map(topic => topic.viewpoint?.components?.selection?.map(component => component.ifcGuid)), 'authored IFC GlobalIds survive native archive publication');
});

test('draft archive publication preserves real finding membership on native reimport (#7140)', async () => {
  const batch = await mountDraft();
  click(button('Export .bcfzip'));
  running();
  await finished();
  assert.equal(jobs()[0].outcome, 'completed');
  assert.equal(archives.length, 1);
  const imported = await importDraftArchive(await archives[0].arrayBuffer());
  assert.equal(imported.unmapped, 0);
  assert.equal(imported.damaged, 0);
  assert.deepEqual(imported.batches[0].topics.map(topic => topic.guid), batch.topics.map(topic => topic.guid));
  assert.deepEqual(imported.batches[0].topics.map(topic => topic.members), batch.topics.map(topic => topic.members));
  assert.deepEqual(imported.batches[0].source, batch.source);
});

test('BCF panel failed browser publication is Failed and preserves native error feedback (#7140)', async () => {
  useViewerStore.setState({ bcfProject: draftBatchToProject(await reviewedBatch(), 'coordinator@example.test') });
  render(<><BCFPanel onClose={() => undefined} /><ActivityTrayList /></>);
  URL.createObjectURL = () => { throw new Error('Browser refused BCF publication'); };
  mock.method(console, 'error', () => undefined);
  click(button('Export BCF'));
  running();
  await finished();
  assert.equal(jobs()[0].outcome, 'failed');
  assert.equal(jobs()[0].detail, 'Browser refused BCF publication');
  assert.equal(useViewerStore.getState().bcfError, jobs()[0].detail);
  assert.equal(useViewerStore.getState().bcfLoading, false);
  assert.equal(archives.length, 0);
});

test('draft failed publication is Failed with native toast and no escaped rejection (#7140)', async () => {
  await mountDraft();
  URL.createObjectURL = () => { throw new Error('Browser refused draft publication'); };
  mock.method(console, 'error', () => undefined);
  const errors = mock.method(toast, 'error', () => undefined);
  click(button('Export .bcfzip'));
  running();
  await finished();
  assert.equal(jobs()[0].outcome, 'failed');
  assert.equal(jobs()[0].detail, 'Browser refused draft publication');
  assert.equal(errors.mock.callCount(), 1);
  assert.equal(errors.mock.calls[0].arguments[0], jobs()[0].detail);
  assert.equal(archives.length, 0);
});

test('closing and reopening BCF panel preserves native background exports and separate row ownership (#7140)', async () => {
  const batch = await reviewedBatch();
  const first = draftBatchToProject(batch, 'first@example.test');
  first.name = 'First archive';
  const second = draftBatchToProject(batch, 'second@example.test');
  second.name = 'Second archive';
  useViewerStore.setState({ bcfProject: first });
  render(<><BCFPanel onClose={() => undefined} /><ActivityTrayList /></>);
  click(button('Export BCF'));
  const firstId = running();
  cleanup(); // The writer yields between real topic/viewpoint writes; no substituted promise.
  useViewerStore.setState({ bcfProject: second });
  render(<><BCFPanel onClose={() => undefined} /><ActivityTrayList /></>);
  click(button('Export BCF'));
  assert.equal(jobs().length, 2);
  assert.ok(jobs().every(job => job.outcome === 'running'));
  await finished(2);
  assert.equal(jobs().find(job => job.id === firstId)?.subject, 'First archive');
  assert.ok(jobs().every(job => job.outcome === 'completed' && activityCanceller(job.id) === null));
  const restored = await Promise.all(archives.map(async blob => readBCF(await blob.arrayBuffer())));
  assert.deepEqual(restored.map(project => project.name).sort(), ['First archive', 'Second archive']);
  assert.deepEqual(restored.map(project => [...project.topics.keys()]), [batch.topics.map(topic => topic.guid), batch.topics.map(topic => topic.guid)]);
});

test('closing the drafts dialog leaves its real archive publication running to completion (#7140)', async () => {
  const batch = await mountDraft();
  click(button('Export .bcfzip'));
  const id = running();
  cleanup();
  await finished();
  assert.equal(jobs()[0].id, id);
  assert.equal(jobs()[0].outcome, 'completed');
  const imported = await importDraftArchive(await archives[0].arrayBuffer());
  assert.deepEqual(imported.batches[0].topics.map(topic => topic.members), batch.topics.map(topic => topic.members));
});

test('absent native project and draft selection do not create fictitious archive jobs (#7140)', async () => {
  render(<><BCFPanel onClose={() => undefined} /><ActivityTrayList /></>);
  assert.equal(button('Export BCF').disabled, true);
  click(button('Export BCF'));
  cleanup();
  render(<><BCFDraftsDialog open onOpenChange={() => undefined} /><ActivityTrayList /></>);
  assert.equal(button('Export .bcfzip').disabled, true);
  click(button('Export .bcfzip'));
  await act(async () => { await Promise.resolve(); });
  assert.equal(jobs().length, 0);
  assert.equal(archives.length, 0);
});
