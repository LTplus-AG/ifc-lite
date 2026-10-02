/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6629: in the Documentation tab a chart block's "Chart from a dashboard"
 * source picker rendered at about zero width in a narrow editor card, so
 * it was in the DOM but invisible. happy-dom does no flex layout, so this
 * is measured with real bounding boxes in Chromium.
 */
import { test, expect } from '@playwright/test';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
/** The reporter's editor card was 401 CSS px wide. */
const NARROW_CARD_PX = 401;
/** A select this narrow cannot show even its chevron plus a few characters. */
const USABLE_SELECT_PX = 96;

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
  viteCache = await mkdtemp(join(tmpdir(), 'ifc-chart-source-'));
  vite = await createServer({ root: join(ROOT, 'apps/viewer'), cacheDir: viteCache, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await vite.listen();
  viewerUrl = vite.resolvedUrls?.local[0] ?? '';
  if (!viewerUrl) throw new Error('Vite did not expose its browser test URL');
});

test.afterAll(async () => { await vite.close(); await rm(viteCache, { recursive: true, force: true }); });

test('#6629 the chart source picker keeps a usable width in a narrow editor card', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto(viewerUrl);
  await page.waitForFunction(() => Boolean(globalThis.__ifc_lite_viewer_store__));
  await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    state.upsertDocument({ version: 1, id: 'chart-6629', name: 'Report', page: { size: 'A4', orientation: 'portrait' }, blocks: [] });
    state.setActiveDocumentId('chart-6629');
    state.showWorkspacePanel('document');
    state.setSidebarActivePanel('document');
  });
  const panel = page.locator('[data-document-panel]').first();
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Add block', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Chart', exact: true }).click();
  const editor = panel.locator('[data-block-editor][data-block-kind="chart"]');
  await expect(editor).toHaveCount(1);
  const picker = editor.getByRole('combobox', { name: 'Chart from a dashboard' });

  const measure = async (width: number) => {
    await editor.evaluate((el, w) => { (el as HTMLElement).style.width = `${w}px`; (el as HTMLElement).style.maxWidth = `${w}px`; }, width);
    const card = await editor.boundingBox();
    const select = await picker.boundingBox();
    return { card: card?.width ?? 0, select: select?.width ?? 0 };
  };

  const narrow = await measure(NARROW_CARD_PX);
  await editor.screenshot({ path: testInfo.outputPath('chart-row-narrow.png') });
  console.log(`#6629 card ${narrow.card}px -> chart source select ${narrow.select}px`);
  expect(narrow.card).toBeCloseTo(NARROW_CARD_PX, 0);
  expect(narrow.select).toBeGreaterThanOrEqual(USABLE_SELECT_PX);

  // Wide cards keep the row on one line, the picker taking the leftover.
  const wide = await measure(900);
  console.log(`#6629 card ${wide.card}px -> chart source select ${wide.select}px`);
  expect(wide.select).toBeGreaterThanOrEqual(USABLE_SELECT_PX);
});
