/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* Screenshot of the document preview for the block heading follow-ups, in a real Chromium, against a
 * running Vite dev server, and the heading's measured box. The preview draws the composer's items (#6731),
 * so the heading is the composer's bold text span and its strip the composed `rect` fill.
 *   EVIDENCE_TAG=main|branch EVIDENCE_OUT=<dir> EVIDENCE_BASE=http://127.0.0.1:5178/ node docs/architecture/evidence/block-heading-follow-ups/preview-shots.mjs
 * `f1-topic`: a topic with no authored title at heading size 24 on a yellow strip. */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.EVIDENCE_BASE ?? 'http://127.0.0.1:5178/';
const OUT = process.env.EVIDENCE_OUT ?? '.';
const TAG = process.env.EVIDENCE_TAG ?? 'main';
mkdirSync(OUT, { recursive: true });

const docs = {
  'f1-topic': [{ kind: 'topic', id: 't', guid: 'topic-1', snapshot: false, titleFontSize: 24, titleBackgroundColor: '#ffff00' },
    { kind: 'text', id: 'after', style: 'body', text: 'Text after the topic block.' }],
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1800 } });
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
    const root = [...document.querySelectorAll(`[data-document-preview] [data-preview-block="${id}"]`)].at(-1);
    const heading = [...root.querySelectorAll('span')].find((el) => el.style.fontWeight === '700');
    const strip = root.querySelector('[data-composed-fill="rect"]');
    const sheet = root.closest('[data-document-preview-paper]'); sheet.setAttribute('data-evidence-sheet', '');
    const range = document.createRange(); range.selectNodeContents(heading);
    return { text: heading.textContent.trimEnd(), fontPx: Number.parseFloat(getComputedStyle(heading).fontSize),
      textRight: range.getBoundingClientRect().right, stripRight: strip.getBoundingClientRect().right, sheetRight: sheet.getBoundingClientRect().right };
  }, first);
  console.log(`${name}-${TAG}: heading "${box.text}" ${box.fontPx.toFixed(2)} px; glyphs end ${(box.textRight - box.stripRight).toFixed(1)} px from the strip's right edge, ${(box.textRight - box.sheetRight).toFixed(1)} px from the sheet's right edge (negative is inside)`);
  await page.locator('[data-evidence-sheet]').screenshot({ path: `${OUT}/${name}-${TAG}.png` });
}
await browser.close();
