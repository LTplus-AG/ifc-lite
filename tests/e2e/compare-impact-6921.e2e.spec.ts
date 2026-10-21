/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ViewerBenchmarkPage } from '../benchmark/viewer-benchmark-page';

// #6921: the committed demo revision pair (SketchUp base + derived rev B)
// loaded through "Try with demo data", compared, clash-checked natively, and
// the Compare panel's impact and run-reconciliation sections driven through
// the UI. Only the store is read back; every number comes from native runs.

// A tall coordinator display: below ~1000 px the Compare controls leave the change list little height.
test.use({ viewport: { width: 1440, height: 1500 } });

type StoreState = {
  models: Map<string, unknown>; loading: boolean; geometryStreamingActive: boolean;
  compareResult: { diff: { counts: Record<string, number> } } | null; compareRunning: boolean;
  clashResult: { clashes: unknown[] } | null; clashRunning: boolean;
  openPanelInHome(panel: string): void; setClashTolerance(value: number): void;
};
const state = <T>(page: Page, read: (s: StoreState) => T) => page.evaluate((fn) => {
  const s = (globalThis as unknown as { __ifc_lite_viewer_store__: { getState(): StoreState } }).__ifc_lite_viewer_store__.getState();
  return (new Function('s', `return (${fn})(s)`))(s) as T;
}, read.toString());

async function runClash(page: Page) {
  await state(page, s => s.openPanelInHome('clash'));
  await state(page, s => { (globalThis as unknown as { previousClash: unknown }).previousClash = s.clashResult; });
  // Re-run replays the previous request; clear first so the run uses the current tolerance.
  // Only the Clash panel is open in the Home slot here, so its Clear results is the one on screen.
  const clear = page.getByRole('button', { name: 'Clear results', exact: true });
  if (await clear.count()) await clear.click();
  await page.getByRole('button', { name: 'Detect all clashes', exact: true }).click();
  await expect.poll(() => state(page, s => s.clashResult !== null && !s.clashRunning
    && s.clashResult !== (globalThis as unknown as { previousClash: unknown }).previousClash), { timeout: 120_000 }).toBe(true);
  await state(page, s => s.openPanelInHome('compare'));
}

/** Full page, plus the right-hand panel column alone for review. */
async function shoot(page: Page, region: ReturnType<Page['getByRole']>, path: (name: string) => string, name: string) {
  await page.screenshot({ path: path(`${name}.png`) });
  const box = await region.boundingBox();
  const viewport = page.viewportSize();
  if (box && viewport) {
    await page.screenshot({ path: path(`${name}-panel.png`),
      clip: { x: Math.max(0, box.x - 16), y: 128, width: box.width + 32, height: viewport.height - 160 } });
  }
}

test('comparison impact and run reconciliation on the demo revision pair', async ({ page }, testInfo) => {
  const viewer = new ViewerBenchmarkPage(page);
  await viewer.setup();
  await state(page, s => s.openPanelInHome('compare'));
  await page.getByRole('button', { name: 'Try with demo data', exact: true }).click();
  await expect.poll(() => state(page, s => s.models.size === 2 && !s.loading && !s.geometryStreamingActive), { timeout: 120_000 }).toBe(true);
  await page.getByRole('button', { name: 'Run comparison', exact: true }).click();
  await expect.poll(() => state(page, s => s.compareResult !== null && !s.compareRunning), { timeout: 120_000 }).toBe(true);
  expect(await state(page, s => s.compareResult?.diff.counts)).toEqual({ added: 1, deleted: 1, modified: 2, unchanged: 19 });
  await runClash(page);

  const sections = page.getByRole('region', { name: 'Comparison impact and reconciliation', exact: true });
  const impact = sections.getByRole('button', { name: /Impact on other analyses/ });
  await impact.click();
  await expect(impact).toHaveAttribute('aria-expanded', 'true');
  await expect(sections).toContainText('4 changed elements checked against loaded results');
  await expect(sections).toContainText(/Clashes\s*\d+ touched/);
  await expect(sections).toContainText('Joined by model and GlobalId only.');
  await shoot(page, sections, n => testInfo.outputPath(n), 'compare-impact');

  // Reconcile the one run over both revisions as base and head.
  await impact.click();
  await sections.getByRole('button', { name: 'Reconcile findings across revisions' }).click();
  await sections.getByRole('button', { name: 'Capture current run', exact: true }).click();
  await sections.getByRole('button', { name: 'Reconcile', exact: true }).click();
  const outcome = sections.getByRole('status');
  await expect(outcome).toContainText('New');
  await expect(outcome).toContainText(/pair or lack identity across revisions/);
  await shoot(page, sections, n => testInfo.outputPath(n), 'compare-reconcile');

  // A second run with a wider tolerance is refused with the named difference.
  await state(page, s => s.setClashTolerance(0.01));
  await runClash(page);
  // Switching panels remounts Compare; its sections reopen collapsed, the stored outcome survives.
  await sections.getByRole('button', { name: 'Reconcile findings across revisions' }).click();
  await expect(sections.getByRole('status')).toContainText('New');
  await sections.getByRole('button', { name: 'Capture current run', exact: true }).click();
  await sections.getByRole('button', { name: 'Reconcile', exact: true }).click();
  const refusal = sections.getByRole('alert');
  await expect(refusal).toContainText('These runs cannot be reconciled:');
  await expect(refusal).toContainText('The clash settings differ: tolerance');
  await expect(sections.getByRole('status')).toHaveCount(0);
  await shoot(page, sections, n => testInfo.outputPath(n), 'compare-reconcile-refused');
  // Both sections expanded, refusal on screen: no axe violations inside them.
  await sections.getByRole('button', { name: /Impact on other analyses/ }).click();
  const axe = await new AxeBuilder({ page }).include('section[aria-label="Comparison impact and reconciliation"]').analyze();
  expect(axe.violations.map(v => `${v.id}: ${v.nodes.length}`)).toEqual([]);

  // The assistant's comparison evidence carries both sections.
  await page.getByRole('button', { name: 'Discuss with AI', exact: true }).click();
  const assistant = page.getByRole('region', { name: 'Assistant', exact: true });
  await assistant.getByText('Evidence details', { exact: true }).click();
  await assistant.getByText('Inspect evidence sent to the model', { exact: true }).click();
  await expect(assistant.locator('pre')).toContainText('"section":"impact"');
  await expect(assistant.locator('pre')).toContainText('"code":"settingsDiffer"');
  await shoot(page, assistant, n => testInfo.outputPath(n), 'compare-assistant-evidence');
});

// #8017: real demo comparison, normal laptop height. The old results-only
// scroller collapsed after setup/source/export chrome consumed the column.
test('comparison categories isolate results and remain reachable on a short panel (#8017)', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const viewer = new ViewerBenchmarkPage(page);
  await viewer.setup();
  await state(page, s => s.openPanelInHome('compare'));
  await page.getByRole('button', { name: 'Try with demo data', exact: true }).click();
  await expect.poll(() => state(page, s => s.models.size === 2 && !s.loading && !s.geometryStreamingActive), { timeout: 120_000 }).toBe(true);
  await page.getByRole('button', { name: 'Run comparison', exact: true }).click();
  await expect.poll(() => state(page, s => !!s.compareResult && !s.compareRunning), { timeout: 120_000 }).toBe(true);
  const results = page.locator('[data-tour="compare-results"]');
  const before = await page.evaluate(() => [...(globalThis as unknown as {
    __ifc_lite_viewer_store__: { getState(): { hiddenEntities: Set<number> } }
  }).__ifc_lite_viewer_store__.getState().hiddenEntities].sort((a, b) => a - b));
  // Observe the real camera actuator; await its animation before capturing
  // the viewport, so screenshots demonstrate the isolated geometry as well.
  await page.evaluate(() => {
    const realm = globalThis as unknown as {
      __compareFrameCount: number; __compareFrameReady?: Promise<boolean> | boolean;
      __ifc_lite_viewer_store__: { getState(): { cameraCallbacks: { frameSelection?: (duration?: number) => Promise<boolean> | boolean } } };
    };
    realm.__compareFrameCount = 0;
    const callbacks = realm.__ifc_lite_viewer_store__.getState().cameraCallbacks;
    const frame = callbacks.frameSelection;
    callbacks.frameSelection = (duration) => {
      realm.__compareFrameCount++;
      return realm.__compareFrameReady = frame?.(duration) ?? false;
    };
  });
  let frames = 0;
  for (const [label, diffState] of [['Added', 'added'], ['Deleted', 'deleted'], ['Changed', 'modified']] as const) {
    const badge = page.getByRole('button', { name: label, exact: true });
    await badge.click();
    await expect(badge).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __compareFrameCount: number }).__compareFrameCount)).toBe(++frames);
    expect(await page.evaluate(() => (globalThis as unknown as { __compareFrameReady: Promise<boolean> }).__compareFrameReady)).toBe(true);
    const visibility = await page.evaluate((category) => {
      const s = (globalThis as unknown as { __ifc_lite_viewer_store__: { getState(): {
        hiddenEntities: Set<number>; compareResult: { diff: { entries: Array<{
          state: string; base?: { ref: { globalId: number } }; head?: { ref: { globalId: number } };
        }> } };
      } } }).__ifc_lite_viewer_store__.getState();
      return s.compareResult.diff.entries.filter(e => e.state !== category).every(e =>
        [e.base, e.head].every(f => !f || s.hiddenEntities.has(f.ref.globalId)));
    }, diffState);
    expect(visibility).toBe(true);
    await results.scrollIntoViewIfNeeded();
    await expect(results).toContainText(label);
    expect(await results.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThan(26);
    // Read the production color attachment as well: headless Chromium can
    // omit a WebGPU canvas from compositor screenshots even when it renders.
    const frame = await page.evaluate(async () => {
      const host = globalThis as unknown as { __ifc_lite_capture_color_frame__: () => Promise<string | null> };
      const png = await host.__ifc_lite_capture_color_frame__();
      if (!png) return null;
      const bitmap = await createImageBitmap(await (await fetch(png)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      const bytes = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let colored = 0;
      for (let i = 0; i < bytes.length; i += 4) {
        if (Math.max(bytes[i], bytes[i + 1], bytes[i + 2]) - Math.min(bytes[i], bytes[i + 1], bytes[i + 2]) > 30) colored++;
      }
      bitmap.close();
      return { png, colored };
    });
    expect(frame?.colored).toBeGreaterThan(20);
    await testInfo.attach(`compare-8017-${diffState}-gpu.png`, {
      body: Buffer.from(frame!.png.split(',')[1], 'base64'), contentType: 'image/png',
    });
    await page.screenshot({ path: testInfo.outputPath(`compare-8017-${diffState}.png`) });
    await badge.click();
    await expect(badge).toHaveAttribute('aria-pressed', 'false');
  }
  await page.getByLabel('Change kind', { exact: true }).selectOption('data');
  await expect(page.getByRole('button', { name: 'Changed', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Show all results', exact: true }).click();
  const after = await page.evaluate(() => [...(globalThis as unknown as {
    __ifc_lite_viewer_store__: { getState(): { hiddenEntities: Set<number> } }
  }).__ifc_lite_viewer_store__.getState().hiddenEntities].sort((a, b) => a - b));
  expect(after).toEqual(before);
  const scroll = page.locator('[data-compare-scroll]');
  expect(await scroll.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
});
