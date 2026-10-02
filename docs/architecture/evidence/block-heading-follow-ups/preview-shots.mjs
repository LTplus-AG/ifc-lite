/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* Screenshots of the document preview for the block heading follow-ups, in a real Chromium, against a
 * running Vite dev server, and the heading's measured box.
 *   EVIDENCE_TAG=main|branch EVIDENCE_OUT=<dir> EVIDENCE_BASE=http://127.0.0.1:5178/ node docs/architecture/evidence/block-heading-follow-ups/preview-shots.mjs
 * `f1-topic`: a topic with no authored title at heading size 24 on a yellow strip. `f2-unset` and `f2-size12`:
 * a table and an IDS report with their title set, first at the default size and then at 12 pt. */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.EVIDENCE_BASE ?? 'http://127.0.0.1:5178/';
const OUT = process.env.EVIDENCE_OUT ?? '.';
const TAG = process.env.EVIDENCE_TAG ?? 'main';
mkdirSync(OUT, { recursive: true });

const ids = (id, extra) => ({ kind: 'ids-report', id, variant: 'compact', benchmarks: true, sourceName: 'Design IDS', generatedAt: '2026-01-15T10:00:00.000Z',
  summary: { checked: 4, passed: 1, failed: 3, passRate: 25 }, checks: [{ id: 's1', shortDescription: 'Walls', checked: 4, passed: 1, failed: 3, passRate: 25, rules: [] }], title: 'Validation result', ...extra });
const docs = {
  'f1-topic': [{ kind: 'topic', id: 't', guid: 'topic-1', snapshot: false, titleFontSize: 24, titleBackgroundColor: '#ffff00' },
    { kind: 'text', id: 'after', style: 'body', text: 'Text after the topic block.' }],
  'f2-unset': [{ kind: 'table', id: 'table', source: { kind: 'validation', rows: 'failed', columns: ['rule'] }, title: 'Failed rules' }, ids('ids', {})],
  'f2-size12': [{ kind: 'table', id: 'table', source: { kind: 'validation', rows: 'failed', columns: ['rule'] }, title: 'Failed rules', titleFontSize: 12 }, ids('ids', { titleFontSize: 12 })],
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
await page.goto(BASE);
await page.waitForFunction(() => Boolean(globalThis.__ifc_lite_viewer_store__), null, { timeout: 120000 });
for (const [name, blocks] of Object.entries(docs)) {
  await page.evaluate(({ blocks }) => {
    const st = globalThis.__ifc_lite_viewer_store__;
    st.setState({ bcfProject: { version: '3.0', name: 'p', topics: new Map([['topic-1', { guid: 'topic-1', title: 'Fire door in corridor 2.14 is missing its closer and label', description: 'Coordinate with the door supplier.', topicStatus: 'Open', viewpoints: [], comments: [] }]]) } });
    const state = st.getState();
    state.upsertDocument({ version: 11, id: 'shots', name: 'Preview evidence', page: { size: 'A4', orientation: 'portrait' }, blocks });
    state.setActiveDocumentId('shots'); state.showWorkspacePanel('document'); state.setSidebarActivePanel('document');
  }, { blocks });
  await page.waitForSelector('[data-document-preview] [data-preview-block]');
  await page.waitForTimeout(400);
  const first = blocks[0].id;
  const box = await page.evaluate((id) => {
    const root = document.querySelector(`[data-document-preview] [data-preview-block="${id}"]`);
    const text = [...root.querySelectorAll('div')].find((d) => d.children.length === 0 && d.textContent.trim());
    const r = text.getBoundingClientRect(); const cs = getComputedStyle(text);
    return { fontPx: Number.parseFloat(cs.fontSize), boxHeightPx: r.height, textScrollHeightPx: text.scrollHeight, whiteSpace: cs.whiteSpace };
  }, first);
  console.log(`${name}-${TAG}: first heading font ${box.fontPx.toFixed(2)} px, box ${box.boxHeightPx.toFixed(2)} px tall, text needs ${box.textScrollHeightPx} px, white-space ${box.whiteSpace}`);
  await page.locator('[data-document-preview]').last().screenshot({ path: `${OUT}/${name}-${TAG}.png` });
}
await browser.close();
