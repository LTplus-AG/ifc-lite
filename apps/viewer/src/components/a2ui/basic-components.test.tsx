/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Basic catalog components on the viewer's primitives: text stays inert data
 * (no raw HTML, no links, no images), inputs write the surface data model,
 * `Event` actions become follow-up turns carrying that data, and a function
 * call on a button runs from the click (so exportCsv is allowed there; the
 * passive-binding refusal is covered in lib/a2ui/functions.test.ts).
 */

import '@/test/setup-dom.js';
import { clearDownloads, downloadedNames } from '@/test/download-capture.js';
import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, click, type, waitFor } from '@/test/render.js';
import { seedA2uiModels } from '@/test/a2ui-fixture';
import { block, mountReply } from '@/test/a2ui-render';
import { resetChatSessions } from '@/lib/a2ui/chat-sessions';
import { composeFollowUpPrompt } from '@/lib/a2ui/actions';

describe('basic catalog components', () => {
  beforeEach(() => { resetChatSessions(); clearDownloads(); });
  afterEach(() => cleanup());

  it('renders markdown without raw HTML, links or images', async () => {
    const { host } = await seedA2uiModels();
    const { container } = await mountReply(host, block(
      'root = Text("**Bold** <img src=x onerror=alert(1)> <script>alert(2)</script> [site](https://example.com) ![p](https://example.com/p.png)")',
    ));
    await waitFor(() => !!container.querySelector('strong'), 'markdown rendered');
    assert.equal(container.querySelector('strong')?.textContent, 'Bold');
    assert.equal(container.querySelector('img'), null);
    assert.equal(container.querySelector('script'), null);
    assert.equal(container.querySelector('a'), null);
    assert.ok(container.textContent?.includes('site'), 'link text kept, link dropped');
  });

  it('two-way binds inputs and sends their values with an Event as a follow-up', async () => {
    const { host } = await seedA2uiModels();
    const { container, followUps } = await mountReply(host, block(`root = Column([name, pick, go])
name = TextField("Storey", $/storey)
pick = ChoicePicker("Types", "multipleSelection", [{label: "Walls", value: "IfcWall"}, {label: "Slabs", value: "IfcSlab"}], $/pick)
go = Button(Text("Check"), "primary", Event("ask", {prompt: "Check these types", types: $/pick, storey: $/storey}))
$/pick = ["IfcWall"]
$/storey = ""`));
    await waitFor(() => !!container.querySelector('input[type="text"]'), 'inputs');
    type(container.querySelector<HTMLInputElement>('input[type="text"]')!, '00 groundfloor');
    const slabs = [...container.querySelectorAll('label')].find((l) => l.textContent?.includes('Slabs'))?.querySelector('input');
    assert.ok(slabs);
    click(slabs);
    click([...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Check'))!);
    await waitFor(() => followUps.length === 1, 'follow-up posted');
    assert.equal(followUps[0].text, 'Check these types');
    assert.deepEqual(followUps[0].context, { prompt: 'Check these types', types: ['IfcWall', 'IfcSlab'], storey: '00 groundfloor' });
    assert.equal(
      composeFollowUpPrompt(followUps[0].text, followUps[0].context),
      'Check these types\n\n(context: {"types":["IfcWall","IfcSlab"],"storey":"00 groundfloor"})',
    );
  });

  it('runs a function-call action (exportCsv) only when the button is clicked', async () => {
    const { host } = await seedA2uiModels();
    const { container } = await mountReply(host, block(`root = Column([go])
go = Button(Text("Download"), "default", exportCsv(_, {types: ["IfcWall"]}))`));
    await waitFor(() => [...container.querySelectorAll('button')].some((b) => b.textContent?.includes('Download')), 'button');
    assert.deepEqual(downloadedNames(), [], 'rendering did not export');
    click([...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Download'))!);
    await waitFor(() => downloadedNames().length === 1, 'click exported');
    assert.deepEqual(downloadedNames(), ['ifc-entities.csv']);
  });

  it('lays out Tabs, Card, Row and Divider on viewer primitives', async () => {
    const { host } = await seedA2uiModels();
    const { container } = await mountReply(host, block(`root = Card(tabs)
tabs = Tabs([{title: "One", child: a}, {title: "Two", child: b}])
a = Row([Text("left"), Divider(), Text("right")])
b = Callout("Careful", "warn", "Heads up")`));
    await waitFor(() => container.querySelectorAll('[role="tab"]').length === 2, 'two tabs');
    assert.ok(container.textContent?.includes('left') && container.textContent.includes('right'));
    // Scope to the Row: Radix Tabs also carry data-orientation.
    const row = [...container.querySelectorAll('div')].filter((d) => d.textContent === 'leftright').at(-1);
    assert.ok(row?.querySelector('[role="separator"], [data-orientation]'), 'divider inside the row');
  });
});
