/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6947 in a real browser, on a real model: three clash runs over the sample
 * revision B (the demo model with an injected clash), two of them saved as
 * reports, three charts (one per report, one on the current result), then a
 * page reload. The runs differ by their settings: hard clashes, hard clashes
 * with touching pairs reported, and a 0.5 m clearance check.
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
import { clickPanelAction, panelHeader } from './panel-header.helpers';

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

async function loadModel(page: Page, reload = false): Promise<void> {
  const loaded = page.waitForEvent('console', { predicate: (message) => message.text().includes('[ifc-lite] Added model building-architecture-rev-b.ifc'), timeout: 180_000 });
  if (reload) await page.reload();
  else await page.goto(`${viewerUrl}?model=/samples/building-architecture-rev-b.ifc`);
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

type RunSettings = { mode: 'hard' | 'clearance'; reportTouch: boolean; clearance?: number };

/** Set the detection settings, start "Detect all clashes" from the Clash panel and wait for the new result. */
async function run(page: Page, settings: RunSettings): Promise<number> {
  const button = 'Detect all clashes';
  const before = await page.evaluate((next) => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    state.setClashMode(next.mode);
    state.setClashReportTouch(next.reportTouch);
    if (next.clearance !== undefined) state.setClashClearance(next.clearance);
    return state.clashRunSeq;
  }, settings);
  const start = page.getByRole('button', { name: button, exact: true }).first();
  const detection = page.getByRole('button', { name: /^Detection/i }).first();
  // #8520: wait for the lazy panel before deciding whether Detection is collapsed.
  await expect(start.or(detection).first()).toBeVisible();
  // With a result on screen the Detection section is collapsed; open it to reach the run buttons.
  if (!(await start.isVisible())) await detection.click();
  await start.click();
  await page.waitForFunction((seq) => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    return !state.clashRunning && state.clashRunSeq > seq;
  }, before, { timeout: 180_000 });
  const count = await clashCount(page);
  expect(count, `"${button}" publishes a result`).not.toBeNull();
  return count ?? 0;
}

async function saveAs(page: Page, name: string): Promise<void> {
  // A Clash panel header action, inline or in its More actions menu (#8802).
  await clickPanelAction(page, panelHeader(page, 'Clash detection'), 'Saved clash reports');
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
  await page.setViewportSize({ width: 1700, height: 1250 });
  await loadModel(page);
  await openPanels(page);
  // A fresh dashboard, so the three charts are the only cards.
  await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    state.upsertDashboard({ version: 2, id: 'clash-runs-6947', name: 'Clash runs', scope: { kind: 'all' }, charts: [], layout: [] });
    state.setActiveDashboardId('clash-runs-6947');
  });

  const a = await run(page, { mode: 'hard', reportTouch: false });
  await saveAs(page, 'Run A: hard');
  await page.screenshot({ path: info.outputPath('1-save-dialog.png') });
  await page.keyboard.press('Escape');

  const b = await run(page, { mode: 'hard', reportTouch: true });
  await saveAs(page, 'Run B: with touching');
  await page.keyboard.press('Escape');
  expect(a, 'the sample model has clashes for run A').toBeGreaterThan(0);
  expect(b, 'runs A and B must differ for the charts to be told apart').not.toBe(a);

  await addClashChart(page, 'Chart of run A', 'Run A: hard');
  await addClashChart(page, 'Chart of run B', 'Run B: with touching');
  await addClashChart(page, 'Current result', null);
  // Lay the three cards out side by side; new charts are stacked below one another.
  await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const dashboard = state.dashboards.find((entry) => entry.id === 'clash-runs-6947');
    if (dashboard) state.upsertDashboard({ ...dashboard, layout: dashboard.charts.map((chart, index) => ({ chartId: chart.id, x: index * 4, y: 0, w: 4, h: 4 })) });
  });
  await page.screenshot({ path: info.outputPath('2-chart-editor-and-cards.png') });

  // Run C replaces the current result.
  const c = await run(page, { mode: 'clearance', reportTouch: false, clearance: 0.5 });
  expect(c, 'run C must differ from the saved runs for the charts to be told apart').not.toBe(b);
  await expect.poll(() => population(page, 'Current result')).toBe(c);
  expect(await population(page, 'Chart of run A')).toBe(a);
  expect(await population(page, 'Chart of run B')).toBe(b);
  await page.screenshot({ path: info.outputPath('3-after-run-c.png') });

  // Reload the page with the same model: no current result, and the reports come back from IndexedDB.
  await loadModel(page);
  await page.waitForFunction(() => globalThis.__ifc_lite_viewer_store__.getState().savedClashReportsStorage.phase === 'ready');
  expect(await clashCount(page), 'a reload keeps no current result').toBeNull();
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().savedClashReports.map((report) => report.name).sort()))
    .toEqual(['Run A: hard', 'Run B: with touching']);
  await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    state.setActiveDashboardId('clash-runs-6947');
    state.showWorkspacePanel('charts');
  });
  const chartA = page.locator('[data-chart-id]', { hasText: 'Chart of run A' }).first();
  await expect(chartA).toBeVisible();
  await expect.poll(() => population(page, 'Chart of run A')).toBe(a);
  expect(await population(page, 'Chart of run B')).toBe(b);
  expect(await population(page, 'Current result')).toBe(0);
  // The same file is loaded again, unedited: the report is on its recorded revision and carries no warning.
  await expect(chartA.locator('[data-chart-subtitle]')).toHaveText(/^Saved clash report: Run A: hard, saved /);
  await chartA.getByRole('button', { name: 'Edit Chart of run A', exact: true }).click();
  await expect(page.locator('[data-chart-editor]').getByLabel('Clash report', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('4-after-reload-editor.png') });
  await page.locator('[data-chart-editor]').getByRole('button', { name: 'Cancel', exact: true }).click();

  // Delete report A: its chart is unavailable and offers the way out; it does not show another run.
  await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const report = state.savedClashReports.find((entry) => entry.name === 'Run A: hard');
    return report ? state.deleteSavedClashReport(report.id) : false;
  });
  const orphan = page.locator('[data-chart-id]', { hasText: 'Chart of run A' }).first();
  await expect(orphan.locator('[data-chart-subtitle]')).toHaveText('Saved clash report unavailable');
  await expect(orphan.getByRole('button', { name: 'Choose a source', exact: true })).toBeVisible();
  expect(await population(page, 'Chart of run A')).toBe(0);
  await page.screenshot({ path: info.outputPath('5-report-deleted.png') });
});

test('#9259 real IFC quality evidence survives threshold edits, documentation capture and reload', async ({ page }, info) => {
  test.setTimeout(480_000);
  await page.setViewportSize({ width: 1700, height: 1250 });
  await loadModel(page);
  await openPanels(page);
  expect(await run(page, { mode: 'hard', reportTouch: false })).toBeGreaterThan(0);
  const gates = page.locator('[data-quality-rule]');
  await expect(gates.first()).toBeVisible();
  // Count physical source entities from loaded geometry, independently of the
  // engine's membership collection. Reuse the IFC eligibility classifier only.
  const expected = await page.evaluate(async ({ adapterUrl, instancesUrl }) => {
    const { isNonClashableTag }: typeof import('../../packages/clash/src/adapters/shared') = await import(adapterUrl);
    const { withInstancedMeshes }: typeof import('../../apps/viewer/src/utils/instancedExport') = await import(instancesUrl);
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const result = state.clashRawResult;
    if (!result) throw new Error('Real model detection produced no raw result');
    const population = new Set<string>();
    for (const model of state.models.values()) {
      if (!model.geometryResult || !model.ifcDataStore) continue;
      const meshes = withInstancedMeshes(model.geometryResult, { modelId: model.id, idOffset: model.idOffset ?? 0, maxExpressId: model.maxExpressId ?? 0 }).meshes;
      for (const mesh of meshes) {
        const tag = model.ifcDataStore.entities.getTypeName(mesh.expressId - (model.idOffset ?? 0));
        if (mesh.positions.length && !isNonClashableTag(tag)) population.add(JSON.stringify([model.id, mesh.expressId]));
      }
    }
    return result.rulesRun.map(rule => {
      const checked = population.size;
      const affected = new Set(result.clashes.filter(clash => clash.rule === rule.id)
        .flatMap(clash => [clash.a, clash.b]).map(member => JSON.stringify([member.model, member.ref]))).size;
      return { rule: rule.id, checked, affected };
    });
  }, { adapterUrl: `/@fs/${ROOT}/packages/clash/src/adapters/shared.ts`, instancesUrl: '/src/utils/instancedExport.ts' });
  for (const row of expected) {
    await expect(page.locator('[data-quality-rule]').filter({ hasText: `${row.checked} checked · ${row.affected} affected` }).first()).toBeVisible();
    const percent = 100 * (row.checked - row.affected) / row.checked;
    const label = percent >= 95 ? 'Passed' : percent >= 90 ? 'Partially passed' : 'Failed';
    await expect(gates.first()).toContainText(label);
    await expect(gates.first().getByRole('img')).toHaveAccessibleName(new RegExp(`${label}$`));
    const displayedPercent = Number((await gates.first().locator('svg text').textContent())?.replace('%', ''));
    expect(displayedPercent).toBeLessThanOrEqual(percent + 1e-9);
    expect(percent - displayedPercent).toBeLessThan(0.100001);
  }
  await page.screenshot({ path: info.outputPath('9259-real-ifc-quality.png') });
  await saveAs(page, 'Quality evidence 9259');
  const captured = await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().savedClashReports
    .find(report => report.name === 'Quality evidence 9259')?.qualityGates);
  expect(captured?.rows.map(({ rule, checked, affected }) => ({ rule, checked, affected }))).toEqual(expected);
  await page.keyboard.press('Escape');
  await page.getByText('Configure quality gates', { exact: true }).click();
  for (const index of [1, 2, 3]) await page.getByLabel(`Clash checks Category name ${index}`, { exact: true }).fill(`Changed after capture ${index}`);
  await page.getByRole('button', { name: 'Save thresholds', exact: true }).click();
  await expect(gates.first()).toContainText('Changed after capture');
  await clickPanelAction(page, panelHeader(page, 'Clash detection'), 'Saved clash reports');
  const reportRow = page.getByRole('dialog').locator('li[data-clash-report]', { hasText: 'Quality evidence 9259' });
  await reportRow.getByText('Quality gates', { exact: true }).click();
  await reportRow.getByRole('button', { name: 'Add quality gates to Documentation', exact: true }).click();
  await page.waitForFunction(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    return state.documents.some(doc => doc.name === 'Quality evidence 9259' && state.documentsStorage.items[doc.id] === 'saved');
  });
  const documentCopy = await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().documents.find(doc => doc.name === 'Quality evidence 9259'));
  expect(documentCopy?.blocks.some(block => block.kind === 'image' && block.dataUrl.startsWith('data:image/png;base64,'))).toBe(true);
  expect(documentCopy?.blocks.filter(block => block.kind === 'text').map(block => block.text).join('\n')).not.toContain('Changed after capture');
  await loadModel(page, true);
  await page.evaluate(async () => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    await state.initializeSavedClashReports();
    await state.initializeDocuments();
  });
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().savedClashReports
    .find(report => report.name === 'Quality evidence 9259')?.qualityGates)).toEqual(captured);
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().documents
    .find(doc => doc.name === 'Quality evidence 9259'))).toEqual(documentCopy);
});
