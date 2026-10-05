/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Human-facing evaluation tooling (#6928) that needs the viewer's DOM and
 * panel registry: the static labelling page, and the U01 study protocol's
 * named entry points, which must be real workspace panels in the real group.
 */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WORKSPACE_PANELS } from '@/lib/panels/registry';

const repo = (path: string) => new URL(`../../../../../${path}`, import.meta.url);
interface Route { group: string; panels: string[] }
interface Protocol { tasks: Array<{ id: string; entry: { current: Route; assisted: Route } }> }

test('every study task enters through registered workspace panels in the group the registry assigns', () => {
  const protocol = JSON.parse(readFileSync(repo('tests/ai-eval/study/protocol.json'), 'utf8')) as Protocol;
  const byId = new Map(WORKSPACE_PANELS.map(panel => [panel.id as string, panel]));
  for (const task of protocol.tasks) for (const [variant, route] of Object.entries(task.entry)) {
    for (const id of route.panels) assert.ok(byId.has(id), `${task.id} ${variant}: ${id} is not a workspace panel`);
    // The group names where the participant starts: at least one named panel must live in it.
    assert.ok(route.panels.some(id => byId.get(id)?.group === route.group), `${task.id} ${variant}: no panel belongs to group ${route.group}`);
  }
  assert.ok(protocol.tasks.some(task => task.entry.assisted.panels.includes('assistant')), 'the assisted variant reaches the Assistant panel');
});

interface Page { load(sheet: unknown): void; problems(): string[]; current(): { reviewer: { status: string }; findings?: Array<{ group: string | null }> } }
const html = readFileSync(repo('scripts/ai-eval/label-tool.html'), 'utf8');

/** The page's own script, run against the happy-dom document, exposing its state without changing it. */
function openPage(): Page {
  const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
  assert.ok(script);
  document.body.innerHTML = /<body>([\s\S]*?)<script>/.exec(html)?.[1] ?? '';
  return new Function(`${script}\nreturn { load(next) { sheet = next; render(); }, problems, current: () => sheet };`)() as Page;
}

const groupingSheet = () => ({ version: 1, id: 'r.grouping.p1', recording: 'r', task: 't', kind: 'grouping', answerSha256: '0'.repeat(64), reviewer: { id: 'p1', status: 'blank' },
  findings: [{ citation: 'E1', summary: 'wall vs slab', group: null }, { citation: 'E2', summary: 'wall vs duct', group: null }],
  proposal: { groups: [{ name: 'Walls', citations: ['E1', 'E2'], verdict: null, note: '' }], corrections: null } });

afterEach(() => { document.body.innerHTML = ''; });

test('the labelling page hides the model proposal until every finding has the reviewer\'s own group', () => {
  const page = openPage();
  page.load(groupingSheet());
  assert.equal(document.body.textContent?.includes('Walls'), false, 'the proposed group name is not shown yet');
  assert.ok(document.body.textContent?.includes('Step 2 (rating the proposal) unlocks'));
  const inputs = [...document.querySelectorAll<HTMLInputElement>('input[aria-label="group label"]')];
  assert.equal(inputs.length, 2);
  inputs[0].value = 'mine';
  inputs[0].dispatchEvent(new Event('input'));
  inputs[0].dispatchEvent(new Event('change'));
  assert.equal(document.body.textContent?.includes('Walls'), false, 'one grouped finding is not enough');
  const refreshed = [...document.querySelectorAll<HTMLInputElement>('input[aria-label="group label"]')];
  refreshed[1].value = '__unclassified__';
  refreshed[1].dispatchEvent(new Event('input'));
  refreshed[1].dispatchEvent(new Event('change'));
  assert.ok(document.body.textContent?.includes('Walls'), 'the proposal appears once the independent grouping is complete');
  assert.deepEqual(page.current().findings?.map(finding => finding.group), ['mine', '__unclassified__']);
});

test('the labelling page refuses to save an incomplete sheet and names what is missing', () => {
  const page = openPage();
  page.load(groupingSheet());
  const found = page.problems().join(' ');
  assert.match(found, /E1 has no group/);
  assert.match(found, /Group Walls is not rated/);
  assert.match(found, /Corrections needed is empty/);
  assert.equal(page.current().reviewer.status, 'blank', 'nothing is marked complete by a failed save');
  page.load({ ...groupingSheet(), reviewer: { id: 'Jane Doe', status: 'blank' } });
  assert.match(page.problems().join(' '), /pseudonym/);
});
