/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #5886: browser toggle timing on a built viewer, used for base/branch evidence.
 * Start that checkout's `vite preview`, then set PERF_VIEWER_URL and optionally
 * PERF_SECOND_MODEL before running this script from the same checkout. */
import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const url = process.env.PERF_VIEWER_URL;
const first = resolve('tests/models/ara3d/AC20-FZK-Haus.ifc');
const second = process.env.PERF_SECOND_MODEL ? resolve(process.env.PERF_SECOND_MODEL) : null;
if (!url) throw new Error('Set PERF_VIEWER_URL to the isolated preview URL');
if (!existsSync(first) || (second && !existsSync(second))) throw new Error('Fixture missing — run pnpm fixtures');

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader',
    '--disable-vulkan-surface', '--ignore-gpu-blocklist', '--enable-gpu'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(url);
  await page.waitForFunction(() => !!globalThis.__ifc_lite_viewer_store__, undefined, { timeout: 120_000 });
  await page.locator('#file-input-open').setInputFiles(first);
  const waitForModels = (count) => page.waitForFunction((expected) => {
    const state = globalThis.__ifc_lite_viewer_store__?.getState();
    return state?.models.size === expected && !state.loading && !state.geometryStreamingActive &&
      [...state.models.values()].every((model) => (model.geometryResult?.meshes.length ?? 0) > 0);
  }, count, { timeout: 180_000 });
  await waitForModels(1);
  if (second) {
    await page.locator('#file-input-add').setInputFiles(second);
    await waitForModels(2);
  }
  await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().setHierarchyMode('type'));
  await page.locator('[role="treeitem"][aria-level="1"][aria-expanded]').first().waitFor();

  const samples = await page.evaluate(async () => {
    const pick = () => document.querySelector('[role="treeitem"][aria-level="1"][aria-expanded]');
    const durations = [];
    for (let i = 0; i < 22; i++) {
      const row = pick();
      const button = row?.querySelector('button[aria-expanded]');
      if (!button) throw new Error('No expandable class row');
      const prior = row.getAttribute('aria-expanded');
      const started = performance.now();
      const elapsed = await new Promise((accept, reject) => {
        const observer = new MutationObserver(() => {
          if (pick()?.getAttribute('aria-expanded') === prior) return;
          clearTimeout(timer);
          observer.disconnect();
          accept(performance.now() - started);
        });
        const timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error('Hierarchy toggle did not render within 10 seconds'));
        }, 10_000);
        observer.observe(document.body, { attributes: true, attributeFilter: ['aria-expanded'], childList: true, subtree: true });
        button.click();
      });
      if (i >= 2) durations.push(elapsed); // warm-up pair
    }
    return durations;
  });
  const sorted = [...samples].sort((a, b) => a - b);
  const median = (sorted[9] + sorted[10]) / 2;
  const p95 = sorted[18];
  process.stdout.write(`${JSON.stringify({ models: second ? 2 : 1, samples, medianMs: median, p95Ms: p95 })}\n`);
} finally {
  await browser.close();
}
