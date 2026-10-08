/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createBCFProject, createBCFTopic, readBCF, writeBCF } from '@ifc-lite/bcf';
import { render, cleanup, click, press, waitFor } from '@/test/render.js';
import { seedArtifactModels } from '@/test/artifact-models-fixture';
import { useViewerStore } from '@/store';
import { setLocale } from '@/i18n';
import { BCFPanel } from './BCFPanel.js';

beforeEach(() => {
  setLocale('en');
  useViewerStore.setState({ bcfProject: null, activeTopicId: null, activeViewpointId: null,
    bcfError: null, bcfLoading: false, models: new Map(), activeModelId: null,
    selectedEntityId: null, selectedEntityIds: new Set(), hiddenEntities: new Set(), isolatedEntities: null });
});
afterEach(cleanup);

async function workspace(empty = false) {
  const original = createBCFProject({ name: 'Coordination review' });
  const open = createBCFTopic({ title: 'Check opening', author: 'review@example.com', topicStatus: 'Open' });
  const closed = createBCFTopic({ title: 'Recorded decision', author: 'review@example.com', topicStatus: 'Closed' });
  if (!empty) { original.topics.set(open.guid, open); original.topics.set(closed.guid, closed); }
  const project = await readBCF(await writeBCF(original));
  assert.equal(project.topics.size, empty ? 0 : 2, 'native archive population survives readback');
  assert.equal(project.name, original.name, 'native project identity survives readback');
  if (!empty) assert.equal(project.topics.get(open.guid)?.topicStatus, 'Open');
  useViewerStore.getState().setBcfProject(project);
  return { ui: render(<BCFPanel onClose={() => {}} />), open, closed };
}
function region(ui: HTMLElement) {
  const found = ui.querySelector('section[aria-label="BCF topic workspace results"]');
  assert.ok(found, 'native topic list adopts the shared result region');
  return found;
}
async function filter(ui: HTMLElement, status: string) {
  const trigger = ui.querySelector('[role="combobox"]'); assert.ok(trigger);
  press(trigger, 'ArrowDown');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const option = [...document.querySelectorAll('[role="option"]')].find(item => item.textContent?.trim() === status);
  assert.ok(option, `native status option ${status}`); click(option);
}

it('#7198 actual archive workspace shows native topic counts without model-check completeness', async () => {
  const { ui } = await workspace();
  const result = region(ui);
  assert.match(result.textContent ?? '', /Coordination review/);
  assert.match(result.textContent ?? '', /2 topics in this workspace/);
  assert.match(result.textContent ?? '', /2 shown/);
  assert.ok(result.querySelector('[data-status="uncertain"]'), 'topic records do not prove completeness of model checks or upstream import');
  assert.equal(result.querySelector('[data-status="complete"]'), null);
});
it('#7198 filtering actual archive topics reports shown count and keeps topic identity', async () => {
  const { ui, open } = await workspace(); await filter(ui, 'Open');
  assert.match(region(ui).textContent ?? '', /1 shown/);
  assert.equal(ui.textContent?.includes('Recorded decision'), false);
  const row = [...ui.querySelectorAll('button')].find(item => item.textContent?.includes('Check opening')); assert.ok(row);
  click(row);
  assert.equal(useViewerStore.getState().activeTopicId, open.guid, 'native selection selects the archive GUID');
  assert.equal(useViewerStore.getState().bcfProject?.topics.size, 2, 'filtering does not change native export population');
});
it('#7198 native status filter that hides all topics is filtered, not an empty workspace', async () => {
  const { ui } = await workspace(); await filter(ui, 'Resolved');
  assert.ok(ui.querySelector('[data-result-state="filtered"]'));
  assert.equal(ui.querySelector('[data-result-state="no-population"]'), null);
  assert.equal(ui.textContent?.includes('Create first topic'), false, 'the workspace already has topics');
});
it('#7198 empty native archive is no topic population and never clean model findings', async () => {
  const { ui } = await workspace(true);
  assert.ok(ui.querySelector('[data-result-state="no-population"]'));
  assert.equal(ui.querySelector('[data-result-state="no-findings"]'), null);
  assert.match(region(ui).textContent ?? '', /0 topics in this workspace/);
});
it('#7198 live native edits retain archive GUID and export all topics independently of filtering', async () => {
  const { ui, open } = await workspace(); await filter(ui, 'Closed');
  await act(async () => { useViewerStore.getState().updateTopic(open.guid, { title: 'Reviewed opening', topicStatus: 'Closed' }); });
  assert.match(region(ui).textContent ?? '', /2 shown/);
  assert.match(ui.textContent ?? '', /Reviewed opening/);
  const project = useViewerStore.getState().bcfProject; assert.ok(project);
  const saved = await readBCF(await writeBCF(project));
  assert.equal(saved.topics.size, 2);
  assert.equal(saved.topics.get(open.guid)?.title, 'Reviewed opening');
  assert.equal(saved.topics.get(open.guid)?.topicStatus, 'Closed');
});
it('#7198 native topic selection remains unchanged by the composition', async () => {
  const { ui, closed } = await workspace();
  const row = [...ui.querySelectorAll('button')].find(item => item.textContent?.includes('Recorded decision')); assert.ok(row);
  click(row); assert.equal(useViewerStore.getState().activeTopicId, closed.guid);
  assert.match(ui.textContent ?? '', /Recorded decision/);
});
it('#7198 unrelated one and federated IFC models are not invented as topic source scope', async () => {
  await seedArtifactModels({ federated: true });
  assert.equal(useViewerStore.getState().models.size, 2, 'actual committed IFC samples parsed');
  const { ui } = await workspace();
  const names = [...useViewerStore.getState().models.values()].map(model => model.name);
  for (const name of names) assert.equal(region(ui).textContent?.includes(name), false);
  await act(async () => {
    const first = [...useViewerStore.getState().models.entries()][0]; assert.ok(first);
    useViewerStore.setState({ models: new Map([first]), activeModelId: first[0] });
  });
  assert.equal(useViewerStore.getState().models.size, 1);
  for (const name of names) assert.equal(region(ui).textContent?.includes(name), false);
  assert.match(region(ui).textContent ?? '', /Coordination review/);
});
it('#7198 native archive publication retains unfiltered workspace topic GUIDs', async () => {
  const { ui, open, closed } = await workspace(); await filter(ui, 'Closed');
  const archives: Blob[] = [];
  const createUrl = URL.createObjectURL, revokeUrl = URL.revokeObjectURL;
  try {
    URL.createObjectURL = blob => { assert.ok(blob instanceof Blob); archives.push(blob); return 'blob:native-topic-workspace'; };
    URL.revokeObjectURL = () => undefined;
    const exportButton = ui.querySelector('button[aria-label="Export BCF"]'); assert.ok(exportButton);
    click(exportButton);
    await waitFor(() => archives.length === 1 && !useViewerStore.getState().bcfLoading, 'actual native filtered-view archive publication');
    const saved = await readBCF(await archives[0].arrayBuffer());
    assert.deepEqual([...saved.topics.keys()].sort(), [open.guid, closed.guid].sort());
    assert.equal(saved.name, 'Coordination review');
    assert.match(region(ui).textContent ?? '', /1 shown/);
  } finally {
    URL.createObjectURL = createUrl; URL.revokeObjectURL = revokeUrl;
  }
});
it('#7198 empty-workspace native author editing remains keyboard reachable', async () => {
  useViewerStore.setState({ bcfAuthor: 'review@example.com' });
  const { ui } = await workspace(true);
  const edit = ui.querySelector('button[aria-label="Edit author email"]'); assert.ok(edit);
  click(edit);
  const input = ui.querySelector('input[placeholder="your@email.com"]'); assert.ok(input);
  assert.equal(document.activeElement, input, 'native email editing receives focus when opened');
});
