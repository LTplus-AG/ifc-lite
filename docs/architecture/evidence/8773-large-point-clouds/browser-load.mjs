/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Drives a running Chrome over CDP; the file path is native to that Chrome's OS.
// Usage: node browser-load.mjs <cdpPort> <viewerUrl> <windowsFilePath> <outPrefix>
import { chromium } from '@playwright/test';
const [port, url, winPath, out] = process.argv.slice(2);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = browser.contexts()[0];
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.setViewportSize({ width: 1400, height: 900 });
const t0 = Date.now();
const logs = [];
page.on('console', (m) => { const t = m.text(); if (/useIfc|pointcloud|Stream|rejected|exceeds|error|Error/i.test(t) && logs.length < 200) logs.push(`${((Date.now() - t0) / 1000).toFixed(1)}s [${m.type()}] ${t.slice(0, 300)}`); });
page.on('pageerror', (e) => logs.push(`PAGEERROR ${e.message.slice(0, 300)}`));
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
for (const id of nodeIds) { const { attributes } = await cdp.send('DOM.getAttributes', { nodeId: id }); const acc = attributes[attributes.indexOf('accept') + 1] ?? ''; if (attributes.includes('accept') && acc.includes('.e57')) { target = id; break; } }
if (!target) throw new Error(`no model file input (found ${nodeIds.length} inputs)`);
const tLoad = Date.now();
await cdp.send('DOM.setFileInputFiles', { nodeId: target, files: [winPath] });
let phase = '', done = false, shot = false;
while (Date.now() - tLoad < 20 * 60_000) {
  await page.waitForTimeout(2000);
  const text = await page.evaluate(() => document.body.innerText);
  const m = text.match(/Streaming[^\n]*/g);
  const p = m ? m.join(' | ') : '';
  if (p !== phase) { phase = p; logs.push(`${((Date.now() - t0) / 1000).toFixed(1)}s PHASE ${p}`); }
  if (!shot && /Streaming \(\d/.test(p) && /\/ /.test(p)) { await page.screenshot({ path: `${out}-streaming.png` }); shot = true; }
  if (/rejected|exceeds maxFileSize/i.test(text)) { logs.push('UI shows rejection'); break; }
  if (/Streaming complete/.test(p) || (phase === '' && logs.some((l) => l.includes('PHASE Streaming')))) { done = true; break; }
}
const loadSeconds = (Date.now() - tLoad) / 1000;
await page.waitForTimeout(3000);
await page.screenshot({ path: `${out}-done.png` });
console.log(JSON.stringify({ done, loadSeconds, logs }, null, 1));
await browser.close();
