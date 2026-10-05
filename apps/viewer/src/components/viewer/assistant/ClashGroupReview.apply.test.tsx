/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import '@/test/content-fixture';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { clashReviewKey, summarizeClashes, type Clash } from '@ifc-lite/clash';
import { render, click, cleanup, type, waitFor } from '@/test/render';
import { clashFindings, serveClassifier } from '@/test/clash-classifier-stub';
import { useViewerStore } from '@/store';
import { captureEvidence } from '@/lib/assistant/evidence';
import { replaceEvidence, useAssistant, cancelAssistant } from '@/lib/assistant/conversation';
import { readContentRows } from '@/lib/storage/content-database';
import { clashGroupLibrary, DEFAULT_GROUP_WORKSPACE, type ClashGroupWorkspace } from '@/lib/clash/group-workspace';
import { manualClashMember } from '@/lib/clash/manual-groups';
import { ClashGroupReview } from './ClashGroupReview';

const initial = useViewerStore.getState();
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); cancelAssistant(); globalThis.fetch = originalFetch; useViewerStore.setState(initial, true); });

function install(clashes: Clash[]) {
  const result = { clashes, summary: summarizeClashes(clashes), rulesRun: [], settings: { tolerance: 0.002, excludeVoidsAndHosts: true } };
  useViewerStore.setState({ clashResult: result, clashRawResult: result, chatActiveModel: 'test/free-model',
    clashReviews: new Map([[clashReviewKey(clashes[0]), { status: 'accepted' as const, updatedAt: 1 }]]) });
  replaceEvidence(captureEvidence('clash'));
}
function propose(groups: Array<{ name: string; citations: string[] }>) {
  useAssistant.setState({ messages: [{ role: 'user', content: 'Group findings' }, { role: 'assistant', model: 'test-provider',
    content: JSON.stringify({ version: 1, kind: 'clash.groups', groups: groups.map(group => ({ ...group, explanation: `Why ${group.name}` })) }) }] });
}
const buttons = (ui: HTMLElement) => [...ui.querySelectorAll('button')];
const button = (ui: HTMLElement, text: string | RegExp) => {
  const found = buttons(ui).find(candidate => typeof text === 'string'
    ? candidate.textContent === text || candidate.getAttribute('aria-label') === text : text.test(candidate.textContent ?? ''));
  assert.ok(found, `button ${String(text)}`);
  return found;
};
const labelled = <T extends Element>(ui: HTMLElement, label: string) => {
  const found = ui.querySelector<T & Element>(`[aria-label="${label}"]`);
  assert.ok(found, label);
  return found as T;
};
function choose(select: HTMLSelectElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}
const stats = (ui: HTMLElement) => [...ui.querySelectorAll('dl dd')].map(value => value.textContent);
async function workspaceRow(id: string) { return (await readContentRows('clashGroups')).find(row => row.id === id); }

// #6906: review edits, apply to a new workspace with a receipt, and undo, all through the mounted review.
test('edit the proposal, apply it into a new workspace and undo from the receipt', async () => {
  install(clashFindings(3));
  const reviews = useViewerStore.getState().clashReviews;
  propose([{ name: 'Routing', citations: ['E1', 'E2'] }, { name: 'Riser', citations: ['E3'] }]);
  const ui = render(<ClashGroupReview />);
  click(button(ui, 'Preview groups'));
  assert.deepEqual(stats(ui), ['3', '3', '0', '0']);

  click(button(ui, 'Rename Routing'));
  type(labelled<HTMLInputElement>(ui, 'Group name'), 'Pipe routing');
  click(button(ui, 'Save name'));
  assert.ok(ui.querySelector('section[aria-label="Pipe routing"]'));

  click(labelled<HTMLInputElement>(ui, 'Select E2 to move'));
  choose(labelled<HTMLSelectElement>(ui, 'Move selected to'), 'unclassified');
  click(button(ui, 'Move'));
  assert.deepEqual(stats(ui), ['3', '2', '1', '0'], 'accounting updates live');
  assert.ok(ui.querySelector('section[aria-label="1 proposed finding unclassified during review"]'));
  assert.equal((await readContentRows('clashGroups')).length, 0, 'edits are local until applied');

  click(button(ui, /^Apply groups$/));
  await waitFor(() => /Applied 2 groups with 2 findings to AI proposal/.test(ui.textContent ?? ''), 'apply receipt');
  const rows = await readContentRows('clashGroups');
  assert.equal(rows.length, 1);
  const stored = rows[0].payload as ClashGroupWorkspace;
  assert.match(stored.name, /^AI proposal \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.deepEqual(stored.groups.map(group => [group.name, group.members.length]), [['Pipe routing', 1], ['Riser', 1]]);
  assert.equal((await readContentRows('clashGroupApplications')).length, 1);
  assert.equal(useViewerStore.getState().clashReviews, reviews, 'applying never touches review decisions');

  click(button(ui, 'Undo apply'));
  await waitFor(() => /Undone: the workspace AI proposal .* was removed/.test(ui.textContent ?? ''), 'undo receipt');
  assert.equal((await workspaceRow(rows[0].id))?.deleted, true);
  assert.equal(useViewerStore.getState().clashReviews, reviews);
});

test('applying into the active human workspace shows the moves and needs explicit confirmation', async () => {
  const clashes = clashFindings(3);
  install(clashes);
  const human: ClashGroupWorkspace = { version: 1, id: DEFAULT_GROUP_WORKSPACE, name: 'Coordination',
    groups: [{ id: 'human', name: 'Level 1', members: [manualClashMember(clashes[0]), manualClashMember(clashes[2])] }] };
  assert.equal(await clashGroupLibrary.put(DEFAULT_GROUP_WORKSPACE, human), true);
  propose([{ name: 'Routing', citations: ['E1', 'E2'] }]);
  const ui = render(<ClashGroupReview />);
  click(button(ui, 'Preview groups'));
  click([...ui.querySelectorAll<HTMLInputElement>('input[type="radio"]')][1]);
  await waitFor(() => /1 finding leaves an existing group/.test(ui.textContent ?? ''), 'move disclosure');
  assert.match(ui.textContent ?? '', /1 from Level 1 to Routing/);
  const apply = button(ui, /^Apply groups$/);
  assert.equal(apply.disabled, true, 'moving a finding out of a human group needs confirmation');
  const confirm = [...ui.querySelectorAll('label')].find(label => label.textContent === 'Move 1 finding out of existing groups');
  assert.ok(confirm);
  click(confirm.querySelector('input')!);
  assert.equal(apply.disabled, false);
  click(apply);
  await waitFor(() => /1 finding was moved out of an existing group/.test(ui.textContent ?? ''), 'receipt discloses the move');
  const stored = (await workspaceRow(DEFAULT_GROUP_WORKSPACE))!.payload as ClashGroupWorkspace;
  assert.deepEqual(stored.groups.map(group => [group.name, group.members.length]), [['Level 1', 1], ['Routing', 2]]);
  click(button(ui, 'Undo apply'));
  await waitFor(() => /Undone: Coordination has its previous groups again/.test(ui.textContent ?? ''), 'undo');
  assert.deepEqual((await workspaceRow(DEFAULT_GROUP_WORKSPACE))?.payload, human);
});

test('classify all findings reviews every native finding, beyond the 100-row sample', async () => {
  install(clashFindings(250));
  const requests = serveClassifier();
  const ui = render(<ClashGroupReview />);
  assert.match(ui.textContent ?? '', /Findings: 250\. Requests: 3\./, 'the estimate is shown before starting');
  click(buttons(ui).find(candidate => candidate.textContent === 'Classify all findings')!);
  await waitFor(() => stats(ui).length === 5, 'full-run review');
  assert.equal(requests.length, 3);
  assert.match(ui.textContent ?? '', /3 of 3 chunks done/);
  assert.deepEqual(stats(ui), ['250', '225', '25', '0', '0']);
  assert.ok(ui.querySelector('section[aria-label="Major walls/pipes"]'));
  assert.match(ui.textContent ?? '', /2 groups were merged across chunks by name/);
});
