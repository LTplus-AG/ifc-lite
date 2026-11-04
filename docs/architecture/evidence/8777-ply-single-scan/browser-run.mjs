/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Drives a running Chrome over CDP; the file path is native to that Chrome's OS.
// Usage: node browser-run.mjs <cdpPort> <viewerUrl> <windowsFilePath> load|cancel [cancelAfterSeconds]
//   load:   time from handing the file to the viewer until streaming completes.
//   cancel: click the status bar's Cancel button after N seconds, then count the
//           decode worker's file reads and time the last one. The button hides
//           at once either way; the worker's reads show when the work stopped.
import { chromium } from '@playwright/test';
const [port, url, winPath, mode, after = '4'] = process.argv.slice(2);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = browser.contexts()[0];
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.setViewportSize({ width: 1400, height: 900 });
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(4000);
for (const name of [/^accept/i, /^decline/i, /^got it/i, /^ok$/i, /^dismiss/i, /^close$/i]) {
  const b = page.getByRole('button', { name }).first();
  if (await b.isVisible().catch(() => false)) await b.click().catch(() => {});
}
const cdp = await ctx.newCDPSession(page);
const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=file]' });
let target = null;
for (const id of nodeIds) { const { attributes } = await cdp.send('DOM.getAttributes', { nodeId: id }); const i = attributes.indexOf('accept'); if (i >= 0 && attributes[i + 1].includes('.ply')) { target = id; break; } }
if (!target) throw new Error(`no model file input (found ${nodeIds.length} inputs)`);
const cancel = page.getByRole('button', { name: /^cancel$/i }).first();
// Count every Blob read in the decode worker (PLY reads 4 MiB windows).
const countReads = () => {
  const g = globalThis, read = Blob.prototype.arrayBuffer;
  g.__reads = 0; g.__lastRead = 0;
  Blob.prototype.arrayBuffer = function () { g.__reads++; g.__lastRead = performance.timeOrigin + performance.now(); return read.call(this); };
};
let decodeWorker = null;
page.on('worker', (w) => { if (/decode/i.test(w.url())) { decodeWorker = w; void w.evaluate(countReads).catch(() => {}); } });
const phase = async () => ((await page.evaluate(() => document.body.innerText)).match(/Streaming[^\n]*/g) ?? []).join(' | ');
const t0 = Date.now();
const s = () => +((Date.now() - t0) / 1000).toFixed(2);
await cdp.send('DOM.setFileInputFiles', { nodeId: target, files: [winPath] });
const result = { mode };
if (mode === 'cancel') {
  await page.waitForTimeout(Number(after) * 1000);
  result.phaseAtCancel = await phase();
  result.cancelVisible = await cancel.isVisible();
  await cancel.click();
  const tc = Date.now();
  if (!decodeWorker) throw new Error('decode worker not found');
  const reads = () => decodeWorker.evaluate(() => [globalThis.__reads, globalThis.__lastRead]);
  const [atCancel] = await reads();
  // Stop once the worker has read nothing for 5 s.
  let last = await reads(), quietSince = Date.now();
  while (Date.now() - quietSince < 5000 && Date.now() - tc < 10 * 60_000) {
    await page.waitForTimeout(250);
    const now = await reads();
    if (now[0] !== last[0]) { last = now; quietSince = Date.now(); }
  }
  result.cancelledAt = Number(after);
  result.readsBeforeCancel = atCancel;
  result.readsAfterCancel = last[0] - atCancel;
  result.lastReadSecondsAfterCancel = last[1] > tc ? +((last[1] - tc) / 1000).toFixed(2) : 0;
} else {
  let last = '', sawStreaming = false;
  while (Date.now() - t0 < 20 * 60_000) {
    await page.waitForTimeout(250);
    const p = await phase();
    if (p !== last) { last = p; if (p.startsWith('Streaming')) { sawStreaming = true; result.firstStreamingAt ??= s(); } }
    if (/Streaming complete/.test(p) || (sawStreaming && !p)) break;
  }
  result.loadSeconds = s();
}
console.log(JSON.stringify(result));
await browser.close();
