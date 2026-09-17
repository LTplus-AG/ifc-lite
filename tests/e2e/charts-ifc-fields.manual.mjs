/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Headed Chrome walkthrough of IFC-field charts (#4833) against a dev server.
// Not a CI test: it drives the real UI (WebGPU, ECharts canvas) and saves a
// screenshot per step. Run, with `pnpm exec vite --port 5199` up in apps/viewer:
//   node tests/e2e/charts-ifc-fields.manual.mjs
// Env: WALKTHROUGH_BASE (default http://localhost:5199), WALKTHROUGH_OUT
// (default <tmp>/ifc-lite-charts-ifc-fields), WALKTHROUGH_FIELDS (comma list
// of `source:set:name` picks to chart, default the property + attribute below).
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.env.WALKTHROUGH_OUT ?? join(tmpdir(), 'ifc-lite-charts-ifc-fields');
mkdirSync(OUT, { recursive: true });
const STORE = '__ifc_lite_viewer_store__';
const BASE = process.env.WALKTHROUGH_BASE ?? 'http://localhost:5199';
const FIELDS = (process.env.WALKTHROUGH_FIELDS ?? 'property:Pset_SlabCommon:FireRating,attribute::ObjectType,relation::Material,quantity:Qto_SlabBaseQuantities:NetArea').split(',').map((s) => s.split(':'));
const log = (...a) => console.log('[walk]', ...a);
const findings = [];
const note = (s) => { findings.push(s); log('FINDING:', s); };

const browser = await chromium.launch({
  headless: false, channel: 'chrome',
  args: ['--enable-gpu', '--enable-webgpu', '--enable-unsafe-webgpu', '--use-angle=default', '--ignore-gpu-blocklist', '--window-size=1600,1000'],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
let step = 0;
const shot = async (name) => { step += 1; const p = `${OUT}/${String(step).padStart(2, '0')}-${name}.png`; await page.screenshot({ path: p }); log('shot', p); };
const state = (expr) => page.evaluate(({ k, e }) => new Function('s', `return (${e});`)(globalThis[k].getState()), { k: STORE, e: expr });

await page.goto(`${BASE}/?model=/samples/building-architecture.ifc`);
await page.waitForFunction((k) => !!globalThis[k], STORE, { timeout: 60000 });
await page.waitForFunction((k) => { const s = globalThis[k].getState(); return s.models.size > 0 && !s.loading && (s.geometryResult?.meshes?.length ?? 0) > 0; }, STORE, { timeout: 120000 });
await page.waitForTimeout(3000);
log('model loaded, meshes', await state('s.geometryResult?.meshes?.length'));

await page.getByRole('tab', { name: /analy/i }).first().click().catch(async () => { await page.getByText('Analyze', { exact: true }).first().click(); });
await page.waitForTimeout(300);
await page.getByRole('button', { name: /^Charts/ }).first().click();
await page.waitForSelector('[data-charts-panel]', { timeout: 15000 });
await page.waitForTimeout(1200);
await shot('charts-panel-open');

for (const [source, setName, fieldName] of FIELDS) {
  await page.getByRole('button', { name: /Add chart/ }).click();
  await page.waitForSelector('[data-chart-editor]');
  const picker = page.locator('[data-chart-editor] select[aria-label="Element field source"]');
  // Discovery scans the model in chunks; wait until the option is enabled.
  await page.waitForFunction((src) => {
    const select = document.querySelector('[data-chart-editor] select[aria-label="Element field source"]');
    return select && [...select.options].some((o) => o.value === src && !o.disabled);
  }, source, { timeout: 60000 });
  await picker.selectOption(source);
  if (source === 'property' || source === 'quantity') {
    await page.locator(`[data-chart-editor] select[aria-label="IFC ${source} set"]`).selectOption(setName);
    await page.locator(`[data-chart-editor] select[aria-label="IFC ${source}"]`).selectOption({ label: fieldName });
    if (source === 'quantity') {
      // A quantity opens as a histogram; chart its sum per storey so the bucket click is a selection of elements.
      await page.locator('[data-chart-editor] select[aria-label="Chart type"]').selectOption('bar');
      await page.locator('[data-chart-editor] select[aria-label="Group by"]').selectOption('Storey');
      const measure = page.locator('[data-chart-editor] select[aria-label="Measure"]');
      const sumValue = await measure.locator('option').evaluateAll((opts) => opts.find((o) => o.textContent.startsWith('Sum of'))?.value);
      await measure.selectOption(sumValue);
    }
  } else if (source === 'relation') {
    const relation = page.locator('[data-chart-editor] select[aria-label="IFC relation"]');
    const value = await relation.locator('option').evaluateAll((opts, name) => opts.find((o) => o.textContent.startsWith(name))?.value, fieldName);
    await relation.selectOption(value);
  } else {
    await page.locator('[data-chart-editor] select[aria-label="IFC attribute"]').selectOption({ label: fieldName });
  }
  const title = `${source}:${setName ? `${setName}.` : ''}${fieldName}`;
  await page.locator('[data-chart-editor] input[aria-label="Chart title"]').fill(title);
  await shot(`editor-${fieldName}`);
  await page.getByRole('button', { name: 'Save chart' }).click();
  await page.waitForTimeout(1500);
  const saved = await state('s.dashboards[0].charts.at(-1)');
  log('saved chart', JSON.stringify({ dimension: saved.dimension, elementField: saved.elementField, type: saved.type }));
  const card = page.locator(`[data-chart-id="${saved.id}"]`);
  await card.waitFor({ timeout: 15000 });
  const subtitle = await card.locator('[data-chart-subtitle]').textContent();
  log('subtitle', subtitle);
  if (/^No data|^0 buckets/.test(subtitle ?? '')) note(`${title}: no buckets rendered (${subtitle})`);
  const hasCanvas = await card.locator('[data-chart-host] canvas').count();
  if (!hasCanvas) note(`${title}: chart host has no canvas`);
  await shot(`card-${fieldName}`);

  // Click the first bucket through the sr-only legend (the same handler the canvas click uses).
  const legend = card.locator('[data-chart-legend] button');
  const buckets = await legend.allTextContents();
  log('buckets', buckets);
  if (buckets.length === 0) { note(`${title}: legend has no buckets`); continue; }
  await legend.first().evaluate((b) => b.click());
  await page.waitForTimeout(1200);
  const selection = await state('({ n: s.selectedEntityIds.size, source: s.chartSliceSource, slice: s.chartSlice ? s.chartSlice.size : null, ghost: s.ghostExceptEntities ? s.ghostExceptEntities.size : null })');
  log('after bucket click', JSON.stringify(selection));
  if (selection.n === 0) note(`${title}: bucket click selected nothing in 3D`);
  if (selection.source !== saved.id) note(`${title}: chart slice not owned by the new chart`);
  // The legend formats counts with toLocaleString ("1,234"): keep the digits only.
  const expected = Number.parseInt((buckets[0].split(': ').at(-1) ?? '').replace(/\D/g, ''), 10);
  if (saved.measure?.agg === 'count' && Number.isFinite(expected) && selection.n !== expected) note(`${title}: bucket reports ${expected} elements but ${selection.n} are selected`);
  await shot(`selected-${fieldName}`);
  // Clear for the next chart.
  await legend.first().evaluate((b) => b.click());
  await page.waitForTimeout(500);
  await page.evaluate((k) => globalThis[k].getState().clearEntitySelection(), STORE);
  await page.waitForTimeout(500);
}

log('page errors', errors.length, errors.slice(0, 5));
if (errors.length) note(`${errors.length} console/page errors: ${errors.slice(0, 3).join(' | ')}`);
writeFileSync(`${OUT}/findings.txt`, findings.length ? findings.join('\n') : 'no findings\n');
log('findings', findings.length ? findings : 'none');
await browser.close();
