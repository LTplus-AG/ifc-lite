/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Headed Chrome walkthrough of the no-model first run against a dev server:
// the viewport empty state, model-dependent panels opened on an empty viewer
// (the panels field replays show no-load sessions exploring), and the welcome
// / ribbon / lens tours driven the way the skip telemetry says users drive
// them. Not a CI test. Run, with `pnpm exec vite --port 5347 --strictPort`
// up in apps/viewer:
//   node tests/e2e/first-run-activation.manual.mjs [label]
// Env: WALKTHROUGH_BASE (default http://localhost:5347), WALKTHROUGH_OUT
// (default <tmp>/ifc-lite-first-run).
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LABEL = process.argv[2] ?? 'run';
const OUT = join(process.env.WALKTHROUGH_OUT ?? join(tmpdir(), 'ifc-lite-first-run'), LABEL);
mkdirSync(OUT, { recursive: true });
const STORE = '__ifc_lite_viewer_store__';
const BASE = process.env.WALKTHROUGH_BASE ?? 'http://localhost:5347';
const log = (...a) => console.log('[walk]', ...a);

const browser = await chromium.launch({
  headless: false, channel: 'chrome',
  args: ['--enable-gpu', '--enable-webgpu', '--enable-unsafe-webgpu', '--use-angle=default', '--ignore-gpu-blocklist', '--window-size=1600,1000'],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const shot = async (name) => { const p = `${OUT}/${name}.png`; await page.screenshot({ path: p }); log('shot', p); };
const state = (expr) => page.evaluate(({ k, e }) => new Function('s', `return (${e});`)(globalThis[k].getState()), { k: STORE, e: expr });
const act = (expr) => page.evaluate(({ k, e }) => { new Function('s', `${e};`)(globalThis[k].getState()); }, { k: STORE, e: expr });
const tourStep = () => page.evaluate(() => document.querySelector('[data-tour-card]')?.getAttribute('data-tour-card') ?? null);

async function fresh() {
  await page.goto(`${BASE}/`);
  await page.waitForFunction((k) => !!globalThis[k], STORE, { timeout: 60000 });
  await page.waitForTimeout(2500);
}

// 1. The empty viewer as a first-time visitor sees it.
await fresh();
await shot('01-empty-viewport');

// 2. Model-dependent panels opened on the empty viewer (field replays: these
// are the panels no-load sessions open most).
for (const id of ['lens', 'clash', 'zones', 'gantt', 'charts', 'lists', 'validation', 'bcf', 'environment', 'presentation', 'model', 'collab']) {
  await act(`s.showWorkspacePanel('${id}', 'rail')`);
  await page.waitForTimeout(900);
  await shot(`02-empty-panel-${id}`);
}
// 2b. Dark mode: one takeover (Lens, side) and one banner (Lists, bottom).
await fresh();
await act(`s.setTheme('dark')`);
await act(`s.showWorkspacePanel('lens', 'rail')`);
await act(`s.showWorkspacePanel('lists', 'rail')`);
await page.waitForTimeout(1200);
await shot('02-dark-takeover-lens-banner-lists');
await act(`s.setTheme('light')`);

// 3. Tours, driven the way the field skip counts say users drive them. A
// step whose anchor never resolves auto-skips WITHOUT showing its card, so
// the sequence of cards seen is the broken-step evidence.
const card = () => page.evaluate(() => {
  const el = [...document.querySelectorAll('[role="dialog"][aria-labelledby]')].find((d) => d.textContent?.includes('Skip step'));
  if (!el) return null;
  const label = document.getElementById(el.getAttribute('aria-labelledby'))?.textContent ?? '';
  return label;
});
async function waitCard(prev, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const c = await card();
    if (c && c !== prev) return c;
    await page.waitForTimeout(150);
  }
  return null;
}
async function cardButton(name) {
  // "Skip step" reads "Skip (use demo)" on the welcome load step with nothing open (#6720).
  const role = name === 'Skip step' ? { name: /^Skip/ } : { name, exact: true };
  await page.locator('[role="dialog"][aria-labelledby]').getByRole('button', role).first().click();
}
async function runTour(label, start, drive) {
  const seen = [];
  await start();
  let c = await waitCard(null);
  while (c) {
    seen.push(c);
    log(label, 'card:', c);
    const next = await drive(c, seen.length);
    if (next === 'stop') break;
    c = await waitCard(c, 30000);
  }
  log(label, 'sequence', JSON.stringify(seen));
  return seen;
}
const palette = async (text) => {
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(400);
  await page.keyboard.type(text);
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
};

// 3a. Welcome tour from the first-run invite, skipping load / orbit / select
// with nothing open: the case that broke inspect and structure.
await fresh();
const welcome = await runTour('welcome', () => page.getByRole('button', { name: 'Take the two minute tour' }).click(), async (c, n) => {
  await page.waitForTimeout(700);
  const id = c.replace(/^Tour step (\d+) of \d+: (.*)$/, '$1-$2').replace(/\W+/g, '-').toLowerCase();
  await shot(`03-welcome-${id}`);
  if (/Read its data/.test(c)) {
    const tab = page.getByRole('tab', { name: /Quantities/ });
    if (await tab.count()) { await tab.click(); return; }
    log('welcome: no Quantities tab to click (nothing selected)');
  }
  if (/Keep exploring/.test(c)) { await cardButton('Done'); return 'stop'; }
  await cardButton('Skip step');
});

await page.waitForTimeout(800);
log('welcome: selection after finish', await state('s.selectedEntityId'));
await shot('03-welcome-7-after-finish');

// The lens and measure tours need a model; on a build where the welcome tour
// did not load one, load the demo from the welcome card.
if (!(await state('s.models.size > 0'))) await page.getByRole('button', { name: 'Load demo project' }).click();
await page.waitForFunction((k) => { const s = globalThis[k].getState(); return s.models.size > 0 && !s.loading && !s.geometryStreamingActive; }, STORE, { timeout: 120000 });
await page.waitForTimeout(1500);

// 3b. Lens tour on the loaded model, skipping "Apply a lens" (broke isolate-legend).
const lens = await runTour('lens', () => palette('Tour: Color the model'), async (c) => {
  await page.waitForTimeout(700);
  if (/Isolate from the legend/.test(c)) { await shot('04-lens-isolate-legend-after-skipped-apply'); await page.locator('[data-tour="end"]').count(); }
  if (/Your view, not your data/.test(c)) { await cardButton('Done'); return 'stop'; }
  if (/Apply a lens|Open Lens rules|Isolate|Bring everything/.test(c)) await cardButton('Skip step');
  else await cardButton('Next');
});

// 3c. Ribbon tour.
const ribbon = await runTour('ribbon', () => palette('Tour: The new ribbon'), async (c) => {
  await page.waitForTimeout(600);
  const id = c.replace(/^Tour step (\d+) of \d+: (.*)$/, '$1-$2').replace(/\W+/g, '-').toLowerCase();
  await shot(`05-ribbon-${id}`);
  if (/Reclaim the height/.test(c)) { await cardButton('Done'); return 'stop'; }
  // The retired action step (main before this change), skipped as 70 of 76 field runs did.
  if (/Open the View tab/.test(c)) { await cardButton('Skip step'); return; }
  await cardButton('Next');
});

// 3d. Measure-section: the tool-measure anchor (anchor-missing on 3.3.0).
const measure = await runTour('measure', () => palette('Tour: Measure and section'), async (c) => {
  await page.waitForTimeout(600);
  if (/Open the Measure tool/.test(c)) { await shot('06-measure-tool-measure'); await page.locator('[role="dialog"][aria-labelledby]').getByRole('button', { name: 'End tour' }).click(); return 'stop'; }
  await cardButton('Skip step');
});

log('summary', JSON.stringify({ welcome, lens, ribbon, measure }, null, 1));
log('errors', errors.length, errors.slice(0, 5));
await browser.close();
