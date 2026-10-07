/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import '@/test/content-backup-fixture.js';
import { refuseContentWrites } from '@/test/content-fixture';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { BCFProject, BCFTopic } from '@ifc-lite/bcf';
import { cleanup, click, render, waitFor } from '@/test/render';
import { fixtureModel } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { clash, clashResult } from '@/lib/review/test-support';
import { useReviewAssistantCard } from '@/lib/review/assistant-state';
import { Toaster } from '@/components/ui/toast';
import { currentReviewWorkspace, useReviewWorkspaces } from '@/lib/review/workspace';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); useReviewAssistantCard.setState({ card: null, project: null }); });

const GW = '0wall000000000000000001';
const GP = '0pipe000000000000000001';
const topic = (): BCFTopic => ({ guid: 'T1', title: 'Pipe through wall', creationDate: '2026-01-01T00:00:00Z', creationAuthor: 'a@b.c', comments: [],
  topicStatus: 'Open', viewpoints: [{ guid: 'V1', components: { selection: [{ ifcGuid: GW }, { ifcGuid: GP }] } }] }) as unknown as BCFTopic;

function setup(truncated = false): void {
  const arch = { ...fixtureModel('A', { entities: [{ expressId: 1, type: 'IfcWall', name: 'Wall A', globalId: GW }] }), name: 'arch.ifc', maxExpressId: 1 };
  const mep = { ...fixtureModel('B', { entities: [{ expressId: 1, type: 'IfcPipeSegment', name: 'Pipe B', globalId: GP }] }), name: 'mep.ifc', maxExpressId: 1 };
  const result = clashResult([clash('c1', { guid: GW, model: 'A', tag: 'IfcWall' }, { guid: GP, model: 'B', tag: 'IfcPipeSegment' })],
    truncated ? { truncated: { reason: 'cap of 10 pairs', droppedPairs: 2 } } : {});
  useViewerStore.setState({
    models: new Map([['A', arch], ['B', mep]]), activeModelId: 'A', clashResult: result, clashRawResult: result,
    bcfProject: { version: '2.1', name: 'Project', topics: new Map([['T1', topic()]]) } as unknown as BCFProject,
  });
}
const mount = () => render(renderPanelBody('review', () => {}));
const button = (scope: ParentNode, label: string) => {
  const match = [...scope.querySelectorAll('button')].find(b => b.getAttribute('aria-label')?.startsWith(label) || b.textContent?.trim() === label);
  assert.ok(match, `Missing button: ${label}`);
  return match;
};

test('with nothing loaded the panel says why it is empty instead of showing a clean result', async () => {
  const ui = mount();
  await waitFor(() => ui.querySelector('[data-result-state]') !== null, 'empty state');
  assert.match(ui.textContent ?? '', /Load a model first/);
  assert.equal(ui.querySelectorAll('[data-review-card]').length, 0);
});

test('a clash and a BCF topic on the same two elements form one card; the totals count each thing separately', async () => {
  setup();
  const ui = mount();
  await waitFor(() => ui.querySelectorAll('[data-review-card]').length === 1, 'one card');
  const card = ui.querySelector('[data-review-card]')!;
  assert.equal(card.getAttribute('data-card-identity'), 'validated');
  assert.equal(card.getAttribute('data-card-state'), 'current');
  assert.match(ui.textContent ?? '', /2 unique validated elements · 1 current findings · 0 historical findings · 1 cards · 1 BCF topics/);
});

test('a truncated clash run is shown as an incomplete run, never as a clean one', async () => {
  setup(true);
  const ui = mount();
  await waitFor(() => ui.querySelectorAll('[data-review-card]').length > 0, 'cards');
  assert.match(ui.textContent ?? '', /results were capped \(cap of 10 pairs\)/);
});

test('a topic naming only one of the elements stays its own card, related to the clash card', async () => {
  setup();
  useViewerStore.setState({ bcfProject: { version: '2.1', name: 'P', topics: new Map([['T1', { ...topic(), viewpoints: [{ guid: 'V1', components: { selection: [{ ifcGuid: GW }] } }] } as unknown as BCFTopic]]) } as unknown as BCFProject });
  const ui = mount();
  await waitFor(() => ui.querySelectorAll('[data-review-card]').length === 2, 'two cards');
  assert.deepEqual([...ui.querySelectorAll('[data-review-card]')].map(card => card.getAttribute('data-card-state')).sort(), ['current', 'record']);
});

test('open original selects the native clash and opens the Clash panel', async () => {
  setup();
  const ui = mount();
  await waitFor(() => ui.querySelector('[data-review-card]') !== null, 'card');
  click(button(ui, 'Show findings of'));
  const open = [...ui.querySelectorAll('[data-finding-source="clash"] button')].find(b => b.textContent === 'Open original');
  assert.ok(open);
  click(open as HTMLElement);
  assert.equal(useViewerStore.getState().clashSelectedId, 'c1');
  assert.equal(useViewerStore.getState().sidebarActivePanel, 'clash');
});

test('a saved decision shows on the card and never touches the native statuses', async () => {
  setup();
  const ui = mount();
  await waitFor(() => ui.querySelector('[data-review-card]') !== null, 'card');
  click(button(ui, 'Show findings of'));
  const select = ui.querySelector<HTMLSelectElement>('select')!;
  assert.ok(select);
  select.value = 'accepted';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  click(button(ui, 'Save decision'));
  await waitFor(() => currentReviewWorkspace(useReviewWorkspaces.getState().entries).decisions.length === 1, 'decision stored');
  await waitFor(() => /Accepted/.test(ui.querySelector('[data-review-card]')?.textContent ?? ''), 'badge');
  assert.equal(useViewerStore.getState().clashResult?.clashes[0].status, 'hard');
  assert.equal(useViewerStore.getState().bcfProject?.topics.get('T1')?.topicStatus, 'Open');
});

// PR #7015: a computed batch is not a successful save when the database refuses it.
test('a refused draft save stays visibly unsaved without a success toast or Open drafts action', async () => {
  setup();
  useViewerStore.setState({ bcfProject: null });
  const ui = mount();
  const notifications = render(<Toaster />);
  await waitFor(() => ui.querySelector('[data-review-card]') !== null, 'card');
  const refusal = refuseContentWrites();
  try {
    click(button(ui, 'Draft BCF topic for 1 card'));
    await waitFor(() => /Drafted, but not saved/.test(ui.textContent ?? ''), 'unsaved draft notice');
    assert.doesNotMatch(notifications.textContent ?? '', /Drafted, but not saved|Open drafts/);
  } finally { refusal.mock.restore(); }
});
