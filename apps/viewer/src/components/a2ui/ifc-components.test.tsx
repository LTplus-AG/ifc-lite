/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The IFC catalog components rendered through the real A2UI surface over the
 * real backend and the committed sample (4 IfcWall, 3 external, wall
 * NetVolume #272 + #297 + #321 + #363, 3 IfcSlab, 2 IfcSpace, 1 IfcRoof).
 * Assertions are on what the user sees and on what reaches the 3D view.
 */

import '@/test/setup-dom.js';
import { clearDownloads, downloadedNames } from '@/test/download-capture.js';
import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, waitFor } from '@/test/render.js';
import { MODEL_A, MODEL_B, seedA2uiModels, selectedRefs } from '@/test/a2ui-fixture';
import { block, mountReply, recordingHost } from '@/test/a2ui-render';
import { A2UI_DEMO_REPLY } from '@/lib/a2ui/demo-reply';
import { resetChatSessions } from '@/lib/a2ui/chat-sessions';
import { legendEntriesFromData } from './ColorLegend';
import { foldGroups } from './GroupChart';

const LEFT_WALL = 315;
const PLUMBING_WALL = 353;

const rows = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-a2ui-row]')];
/** Visible text with a space between separate text nodes, as a reader would hear it. */
function text(el: Element | null | undefined): string {
  if (!el) return '';
  const walker = document.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) parts.push(node.textContent ?? '');
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
const button = (el: HTMLElement, label: string) => [...el.querySelectorAll('button')].find((b) => text(b).includes(label) || b.getAttribute('aria-label')?.includes(label));

describe('IFC catalog components', () => {
  beforeEach(() => { resetChatSessions(); clearDownloads(); });
  afterEach(() => cleanup());

  it('EntityTable: live rows, initial sort, click to select and fly, header re-sort', async () => {
    const { host: real } = await seedA2uiModels();
    const { host, calls } = recordingHost(real);
    const { container } = await mountReply(host, A2UI_DEMO_REPLY);
    await waitFor(() => rows(container).length === 4, 'four wall rows');
    const table = rows(container);
    assert.equal(table[0].getAttribute('data-a2ui-row'), `${MODEL_A}:${LEFT_WALL}`, 'largest NetVolume first');
    assert.match(text(table[0]), /house - outer wall - house left.*true.*4\.231/);
    click(table[0]);
    assert.deepEqual(selectedRefs(real), [`${MODEL_A}:${LEFT_WALL}`]);
    assert.deepEqual(calls.flyTo.at(-1), [{ modelId: MODEL_A, expressId: LEFT_WALL }]);
    click(button(container, 'Sort by Net volume')!);
    assert.equal(rows(container)[0].getAttribute('data-a2ui-row'), `${MODEL_A}:${PLUMBING_WALL}`, 'same column flips to ascending');
  });

  it('EntityTable keyboard: Enter on a focused row selects it', async () => {
    const { host } = await seedA2uiModels();
    const { container } = await mountReply(host, A2UI_DEMO_REPLY);
    await waitFor(() => rows(container).length === 4, 'rows');
    const row = rows(container)[1];
    act(() => { row.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    assert.deepEqual(selectedRefs(host), [row.getAttribute('data-a2ui-row')]);
  });

  it('StatGroup: counts and a quantity sum computed from the model', async () => {
    const { host } = await seedA2uiModels();
    const { container } = await mountReply(host, A2UI_DEMO_REPLY);
    await waitFor(() => container.querySelectorAll('[data-a2ui-stat]').length === 4, 'four tiles');
    const tiles = [...container.querySelectorAll('[data-a2ui-stat]')].map(text);
    assert.match(tiles[0], /^Walls 4$/);
    assert.match(tiles[1], /^External walls 3$/);
    assert.match(tiles[2], /^Wall volume 7\.45 m³$/);
    assert.match(tiles[3], /^Slabs 3$/);
  });

  it('GroupChart: groups from the query, chart option, and a group click selects it', async () => {
    const { host } = await seedA2uiModels();
    const { container, charts } = await mountReply(host, A2UI_DEMO_REPLY);
    await waitFor(() => container.querySelectorAll('[data-a2ui-group]').length === 4, 'four groups');
    const groups = [...container.querySelectorAll('[data-a2ui-group]')].map(text);
    assert.deepEqual(groups, ['IfcWall 4', 'IfcSlab 3', 'IfcSpace 2', 'IfcRoof 1']);
    await waitFor(() => charts.some((c) => c.options.length > 0), 'chart drawn');
    const option = charts.find((c) => c.options.length > 0)!.options.at(-1) as { xAxis: { data: string[] } };
    assert.deepEqual(option.xAxis.data, ['IfcWall', 'IfcSlab', 'IfcSpace', 'IfcRoof']);
    click(container.querySelector('[data-a2ui-group="IfcSlab"]')!);
    assert.equal(selectedRefs(host).length, 3);
    act(() => charts[0].events.onSelect({ items: [{ seriesIndex: 0, dataIndex: 0 }] }));
    assert.equal(selectedRefs(host).length, 4, 'a bar pick selects the walls');
  });

  it('GroupChart: folding keeps the largest groups, not the first ones (#11344)', () => {
    const g = (label: string, value: number) => ({ label, value, refs: [`m:${value}`] });
    const folded = foldGroups([g('a', 1), g('b', 2), g('big', 50), g('c', 3)], 3, 'Other');
    assert.deepEqual(folded.map((x) => [x.label, x.value]), [['big', 50], ['c', 3], ['Other', 3]]);
    assert.deepEqual(folded[2].refs, ['m:1', 'm:2']);
  });

  it('ColorLegend: one colour per value, applied only on Apply; entries toggle visibility', async () => {
    const { host: real } = await seedA2uiModels();
    const { host, calls } = recordingHost(real);
    const { container } = await mountReply(host, A2UI_DEMO_REPLY);
    await waitFor(() => container.querySelectorAll('[data-a2ui-legend]').length === 2, 'two entries');
    assert.deepEqual([...container.querySelectorAll('[data-a2ui-legend]')].map(text), ['true 3', 'false 1']);
    assert.equal(calls.colorize.length, 0, 'manual by default');
    click(button(container, 'Apply colours')!);
    assert.deepEqual(calls.colorize[0].map((b) => b.refs.length), [3, 1]);
    assert.notEqual(calls.colorize[0][0].color, calls.colorize[0][1].color);
    const toggle = container.querySelector<HTMLInputElement>('[data-a2ui-legend="false"] input')!;
    click(toggle);
    assert.deepEqual(calls.hide.at(-1), [{ modelId: MODEL_A, expressId: PLUMBING_WALL }]);
  });

  it('ColorLegend: script entries sharing a label merge, so one toggle covers all of them', () => {
    const entries = legendEntriesFromData([
      { label: 'High', color: '#e5484d', refs: ['m:1'] },
      { label: 'High', color: '#00ff00', refs: ['m:2'] },
      { label: 'Low', color: 'red', refs: ['m:3'] },
    ]);
    assert.deepEqual(entries?.map((e) => [e.label, e.refs.map((r) => r.expressId)]), [['High', [1, 2]], ['Low', [3]]]);
    assert.equal(entries?.[0].color, '#e5484d', 'the first colour wins');
    assert.notEqual(entries?.[1].color, 'red', 'a non-hex colour falls back to the palette');
  });

  it('ActionBar: actions act on the query result, export runs from the click, follow-ups post a turn', async () => {
    const { host: real } = await seedA2uiModels();
    const { host, calls } = recordingHost(real);
    const { container, followUps } = await mountReply(host, A2UI_DEMO_REPLY);
    await waitFor(() => !!container.querySelector('[data-a2ui-action="isolate"]'), 'action bar');
    assert.ok(text(container).includes('4 elements'));
    click(container.querySelector('[data-a2ui-action="isolate"]')!);
    assert.equal(calls.isolate.at(-1)?.length, 4);
    click(container.querySelector('[data-a2ui-action="exportCsv"]')!);
    assert.deepEqual(downloadedNames(), ['ifc-entities.csv']);
    click(button(container, 'Which walls are load-bearing?')!);
    assert.deepEqual(followUps.at(-1)?.text, 'Which walls are load-bearing?');
  });

  it('EntityCard follows the selection and EntityList marks refs to unloaded models inert', async () => {
    const { host: real } = await seedA2uiModels({ federated: true });
    const { host, calls } = recordingHost(real);
    const reply = block(`root = Column([card, list])
card = EntityCard("selection", ["attributes", "quantities"])
list = EntityList(_, $/refs)
$/refs = ["${MODEL_B}:${LEFT_WALL}", "gone:${LEFT_WALL}"]`);
    const { container } = await mountReply(host, reply);
    await waitFor(() => text(container).includes('Select an element in the 3D view'), 'empty selection note');
    assert.ok(text(container).includes('Model gone is not loaded'));
    const items = [...container.querySelectorAll<HTMLButtonElement>('[data-a2ui-row]')];
    assert.deepEqual(items.map((b) => b.disabled), [false, true]);
    click(items[0]);
    assert.deepEqual(selectedRefs(host), [`${MODEL_B}:${LEFT_WALL}`]);
    await waitFor(() => text(container).includes('house - outer wall - house left'), 'card shows the selected wall');
    assert.ok(text(container).includes('NetVolume'), 'quantities section');
    // Both models hold the same wall; the card's own ref tells them apart.
    click(button(container, 'Fly to')!);
    assert.deepEqual(calls.flyTo.at(-1), [{ modelId: MODEL_B, expressId: LEFT_WALL }], 'card reads model B');
  });
});
