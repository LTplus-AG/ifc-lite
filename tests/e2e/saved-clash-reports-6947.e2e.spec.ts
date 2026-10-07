/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6947 in a real browser, on a real model: three clash runs over the sample
 * architecture model, two of them saved as reports, three charts (one per
 * report, one on the current result), then a page reload.
 *
 * The component tests cover the rules; this covers what they cannot: the real
 * IndexedDB across a real reload, and the real layout the screenshots show.
 */
import { test, expect, type Page } from '@playwright/test';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

interface DevServer {
  listen(): Promise<void>;
  close(): Promise<void>;
  resolvedUrls: { local: string[] } | null;
}
let vite: DevServer;
let viewerUrl: string;
let viteCache: string;

test.beforeAll(async () => {
  const requireFromViewer = createRequire(join(ROOT, 'apps/viewer/package.json'));
  const { createServer } = await import(pathToFileURL(requireFromViewer.resolve('vite')).href);
  viteCache = await mkdtemp(join(tmpdir(), 'ifc-clash-reports-'));
  vite = await createServer({ root: join(ROOT, 'apps/viewer'), cacheDir: viteCache, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await vite.listen();
  viewerUrl = vite.resolvedUrls?.local[0] ?? '';
  if (!viewerUrl) throw new Error('Vite did not expose its browser test URL');
});

test.afterAll(async () => { await vite.close(); await rm(viteCache, { recursive: true, force: true }); });

const clashCount = (page: Page): Promise<number | null> =>
  page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().clashResult?.clashes.length ?? null);

async function loadModel(page: Page): Promise<void> {
  const loaded = page.waitForEvent('console', { predicate: (message) => message.text().includes('[ifc-lite] Added model building-architecture.ifc'), timeout: 180_000 });
  await page.goto(`${viewerUrl}?model=/samples/building-architecture.ifc`);
  await loaded;
  await page.waitForFunction(() => (globalThis.__ifc_lite_viewer_store__.getState().geometryResult?.meshes.length ?? 0) > 0, undefined, { timeout: 180_000 });
}

async function openPanels(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    state.showWorkspacePanel('charts');
    state.showWorkspacePanel('clash');
    state.setSidebarActivePanel('clash');
  });
  await expect(page.locator('[data-charts-panel]').first()).toBeVisible();
}

/** Start one run from the Clash panel and wait until a new result is published. */
async function run(page: Page, button: string): Promise<number> {
  const before = await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().clashRunSeq);
  await page.getByRole('button', { name: button, exact: true }).first().click();
  await page.waitForFunction((seq) => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    return !state.clashRunning && state.clashRunSeq > seq;
  }, before, { timeout: 180_000 });
  const count = await clashCount(page);
  expect(count, `"${button}" publishes a result`).not.toBeNull();
  return count ?? 0;
}

async function saveAs(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Saved clash reports', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Report name').fill(name);
  await dialog.getByRole('button', { name: 'Save current result', exact: true }).click();
  await page.waitForFunction((reportName) => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const report = state.savedClashReports.find((entry) => entry.name === reportName);
    return !!report && state.savedClashReportsStorage.items[report.id] === 'saved';
  }, name);
  await expect(dialog.getByLabel(`Name of “${name}”`)).toBeVisible();
}

async function addClashChart(page: Page, title: string, report: string | null): Promise<void> {
  const panel = page.locator('[data-charts-panel]').first();
  await panel.getByRole('button', { name: 'Add chart', exact: true }).click();
  const editor = panel.locator('[data-chart-editor]');
  await editor.getByLabel('Source', { exact: true }).selectOption('clash');
  if (report !== null) await editor.getByLabel('Clash report', { exact: true }).selectOption({ label: report });
  await editor.getByLabel('Chart title', { exact: true }).fill(title);
  await editor.getByRole('button', { name: 'Save chart', exact: true }).click();
  await expect(panel.locator('[data-chart-id]', { hasText: title })).toBeVisible();
}

/** A card's clash count: the sum of its bucket values, from the legend the card renders for screen readers. */
async function population(page: Page, title: string): Promise<number> {
  const items = await page.locator('[data-chart-id]', { hasText: title }).first().locator('[data-chart-legend] li').allTextContents();
  return items.reduce((sum, item) => sum + Number(/: (\d+)$/.exec(item.trim())?.[1] ?? Number.NaN), 0);
}

test('#6947 two saved clash reports and the current result chart side by side, and survive a reload', async ({ page }, info) => {
  test.setTimeout(480_000);
  await page.setViewportSize({ width: 1700, height: 1100 });
  await loadModel(page);
  await openPanels(page);
  // A fresh dashboard, so the three charts are the only cards.
  await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    state.upsertDashboard({ version: 2, id: 'clash-runs-6947', name: 'Clash runs', scope: { kind: 'all' }, charts: [], layout: [] });
    state.setActiveDashboardId('clash-runs-6947');
  });

  const a = await run(page, 'Detect all clashes');
  await saveAs(page, 'Run A: all clashes');
  await page.screenshot({ path: info.outputPath('1-save-dialog.png') });
  await page.keyboard.press('Escape');

  const b = await run(page, 'Find duplicates');
  await saveAs(page, 'Run B: duplicates');
  await page.keyboard.press('Escape');
  expect(a, 'the sample model has clashes for run A').toBeGreaterThan(0);
  expect(b, 'runs A and B must differ for the charts to be told apart').not.toBe(a);

  await addClashChart(page, 'Chart of run A', 'Run A: all clashes');
  await addClashChart(page, 'Chart of run B', 'Run B: duplicates');
  await addClashChart(page, 'Current result', null);
  await page.screenshot({ path: info.outputPath('2-chart-editor-and-cards.png') });

  // Run C replaces the current result (here: back to all clashes, after run B was current).
  const c = await run(page, 'Detect all clashes');
  expect(c).not.toBe(b);
  await expect.poll(() => population(page, 'Current result')).toBe(c);
  expect(await population(page, 'Chart of run A')).toBe(a);
  expect(await population(page, 'Chart of run B')).toBe(b);
  await page.screenshot({ path: info.outputPath('3-after-run-c.png') });

  // Reload without a model: no current result, the reports come back from IndexedDB.
  await page.goto(viewerUrl);
  await page.waitForFunction(() => globalThis.__ifc_lite_viewer_store__?.getState().savedClashReportsStorage.phase === 'ready');
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().savedClashReports.map((report) => report.name).sort()))
    .toEqual(['Run A: all clashes', 'Run B: duplicates']);
  await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    state.setActiveDashboardId('clash-runs-6947');
    state.showWorkspacePanel('charts');
  });
  await expect(page.locator('[data-chart-id]', { hasText: 'Chart of run A' }).first()).toBeVisible();
  await expect.poll(() => population(page, 'Chart of run A')).toBe(a);
  expect(await population(page, 'Chart of run B')).toBe(b);
  expect(await population(page, 'Current result')).toBe(0);
  await expect(page.locator('[data-chart-id]', { hasText: 'Chart of run A' }).first().locator('[data-chart-subtitle]')).toContainText('Models not loaded');
  await page.screenshot({ path: info.outputPath('4-after-reload.png') });

  // Delete report A: its chart is unavailable and offers the way out; it does not show another run.
  await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const report = state.savedClashReports.find((entry) => entry.name === 'Run A: all clashes');
    return report ? state.deleteSavedClashReport(report.id) : false;
  });
  const orphan = page.locator('[data-chart-id]', { hasText: 'Chart of run A' }).first();
  await expect(orphan.locator('[data-chart-subtitle]')).toHaveText('Saved clash report unavailable');
  await expect(orphan.getByRole('button', { name: 'Choose a source', exact: true })).toBeVisible();
  expect(await population(page, 'Chart of run A')).toBe(0);
  await page.screenshot({ path: info.outputPath('5-report-deleted.png') });
});
