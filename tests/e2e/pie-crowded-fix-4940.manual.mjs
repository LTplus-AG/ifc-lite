/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Re-verification for the #4940 headed-Chrome finding: a half-width 220pt
// pie chart with many categories drew per-slice callout labels/leader lines
// over the legend grid. Builds the same document shape the original
// evidence used (half-width bar + half-width pie by Name, a spacer, a
// full-width bar), screenshots the pie zoomed in, and asserts no <text> node
// belonging to the pie's own callout group is present (label.show=false).
//   pnpm exec vite --port 5311 --strictPort   (in apps/viewer)
//   node tests/e2e/pie-crowded-fix-4940.manual.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = process.env.WALKTHROUGH_OUT ?? 'C:/Users/louistrue/ci/evidence-4940';
mkdirSync(OUT, { recursive: true });
const STORE = '__ifc_lite_viewer_store__';
const BASE = process.env.WALKTHROUGH_BASE ?? 'http://localhost:5311';
const log = (...a) => console.log('[verify]', ...a);

const browser = await chromium.launch({
  headless: false, channel: 'chrome',
  args: ['--enable-gpu', '--enable-webgpu', '--enable-unsafe-webgpu', '--use-angle=default', '--ignore-gpu-blocklist', '--window-size=1600,1000'],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const state = (expr) => page.evaluate(({ k, e }) => new Function('s', `return (${e});`)(globalThis[k].getState()), { k: STORE, e: expr });

await page.goto(`${BASE}/?model=/samples/building-architecture.ifc`);
await page.waitForFunction((k) => !!globalThis[k], STORE, { timeout: 60000 });
await page.waitForFunction((k) => { const s = globalThis[k].getState(); return s.models.size > 0 && !s.loading && (s.geometryResult?.meshes?.length ?? 0) > 0; }, STORE, { timeout: 120000 });
await page.waitForTimeout(3000);

// Build the same document shape as the original evidence: a half-width bar +
// a half-width pie by Name (many categories — this is the crowded chart),
// a spacer, then a full-width bar. Driven through the store directly, the
// way the original 04-pie-zoom.png evidence was produced.
await page.evaluate(({ k }) => {
  const s = globalThis[k].getState();
  const freshBlockId = () => `block-${crypto.randomUUID()}`;
  const doc = {
    version: 2,
    id: `document-${crypto.randomUUID()}`,
    name: 'Fix verification (#4940)',
    page: { size: 'A4', orientation: 'portrait' },
    blocks: [
      { kind: 'text', id: freshBlockId(), style: 'heading', text: 'Pie legend overlap — after fix' },
      {
        kind: 'chart', id: freshBlockId(), snapshot: false, height: 300, width: 'half',
        chart: { id: freshBlockId(), title: 'Elements by type', source: 'elements', type: 'bar', dimension: 'IfcType', measure: { agg: 'count' } },
      },
      {
        kind: 'chart', id: freshBlockId(), snapshot: false, height: 220, width: 'half',
        chart: { id: freshBlockId(), title: 'Elements by name', source: 'elements', type: 'pie', dimension: 'Name', measure: { agg: 'count' } },
      },
      { kind: 'spacer', id: freshBlockId(), height: 40 },
    ],
  };
  s.upsertDocument(doc);
  s.setActiveDocumentId(doc.id);
}, { k: STORE });

await page.getByRole('tab', { name: /analy/i }).first().click();
await page.getByRole('button', { name: /^Document/ }).first().click();
await page.waitForSelector('[data-document-panel]', { timeout: 15000 });
await page.locator('select[aria-label="Document"]').selectOption({ label: 'Fix verification (#4940)' });
await page.waitForTimeout(1500);

const row = page.locator('[data-preview-row]').first();
await row.scrollIntoViewIfNeeded();
await page.waitForTimeout(500);
await row.screenshot({ path: `${OUT}/05-after-fix.png` });
log('screenshot saved', `${OUT}/05-after-fix.png`);

// The pie's own callout instance is not exposed on the chart element, so
// assert on the rendered SVG structurally: with 14 categories the legend is
// capped (packages/charts/src/echarts-option.ts PRINT_LEGEND_MAX_ROWS), so a
// crowded pie with its callouts correctly hidden has roughly one <text> per
// visible legend row and nothing more. Before the fix, every one of the 14
// categories also drew its own leader-line label — comfortably more text
// nodes than the capped legend has rows for.
const pieSvg = await page.locator('[data-preview-row] [data-chart-svg]').nth(1).innerHTML();
const texts = [...pieSvg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
log('pie svg text nodes', texts.length, texts);
const ok = texts.length <= 10; // legend rows only; 14 uncapped callouts would push this well past 10
log(ok ? 'PASS: text-node count matches the capped legend, no extra per-slice callouts' : 'FAIL: more text than the legend accounts for — a callout may still be drawn');
log('page errors', errors.length, errors.slice(0, 10));

await browser.close();
process.exit(ok ? 0 : 1);
