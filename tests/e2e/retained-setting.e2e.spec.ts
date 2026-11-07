// SPDX-License-Identifier: MPL-2.0
// #7955 production opt-in: a `VITE_RETAINED_GEOMETRY=lazy` build with a staged engine.
// Run as `VITE_RETAINED_GEOMETRY=lazy IFCLITE_RETAINED_ENGINE=/abs/engine
//   playwright test --project=viewer-retained` after building the viewer the same way.
import { test, expect, type Page, type Response } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ViewerState } from '../../apps/viewer/src/store';
import { CODE_SIGNATURES } from '../../scripts/check-viewer-retained-free.mjs';

const WALL = 'rust/geometry/tests/fixtures/issue_098_wall_W.ifc';
const engine = process.env.IFCLITE_RETAINED_ENGINE;
const lazyBuild = process.env.VITE_RETAINED_GEOMETRY === 'lazy';
const SETTING_KEY = 'ifc-lite:geometry-kernel-setting';
interface ViewerGlobals { __ifc_lite_viewer_store__: { getState(): ViewerState } }

test.skip(!lazyBuild || !(engine && existsSync(join(engine, 'engine-manifest.json'))),
  'SKIP: needs a VITE_RETAINED_GEOMETRY=lazy build and a staged engine; this is NOT opt-in evidence');

/** Every JS body the page received, so retained code can be looked for in what was downloaded. */
function watchDownloads(page: Page) {
  const urls: string[] = [];
  const retainedJs: string[] = [];
  const pending: Promise<void>[] = [];
  page.context().on('request', (request) => urls.push(request.url()));
  page.context().on('response', (response: Response) => {
    if (!/\.m?js(\?|$)/.test(response.url())) return;
    pending.push(response.body().then((body) => {
      if (CODE_SIGNATURES.some((signature) => body.includes(signature))) retainedJs.push(response.url());
    }, () => undefined));
  });
  return { urls, retainedJs, settled: () => Promise.all(pending) };
}

async function open(page: Page, query = '') {
  await page.addInitScript(() => window.localStorage.setItem('ifclite.extensions.privacy-disclosure.v2', 'e2e acknowledged'));
  await page.goto(`/${query}`);
  await page.waitForFunction(() => Boolean((globalThis as typeof globalThis & ViewerGlobals).__ifc_lite_viewer_store__));
  await expect(page.locator('#file-input-open')).toBeAttached();
}

async function loadWall(page: Page) {
  await page.locator('#file-input-open').setInputFiles(resolve(WALL));
  await page.waitForFunction(() => {
    const state = (globalThis as typeof globalThis & ViewerGlobals).__ifc_lite_viewer_store__.getState();
    const model = [...state.models.values()][0];
    return Boolean(state.error) || (!state.loading && model?.loadState === 'complete'
      && model.retainedGeometry?.completeness !== 'running');
  }, null, { timeout: 180000 });
  return page.evaluate(() => {
    const state = (globalThis as typeof globalThis & ViewerGlobals).__ifc_lite_viewer_store__.getState();
    const model = [...state.models.values()][0];
    return { error: state.error, kernel: model?.retainedGeometry?.kernel ?? 'exact', meshes: model?.geometryResult?.meshes.length ?? 0,
      isolated: globalThis.crossOriginIsolated };
  });
}

async function chooseInSettings(page: Page, label: 'Exact (default)' | 'Retained (experimental)') {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('ifc-lite:open-settings', { detail: { section: 'performance' } })));
  const choice = page.locator('[data-settings-dialog] #settings-geometry-kernel');
  await expect(choice).toBeVisible();
  await choice.getByText(label, { exact: true }).click();
  await page.keyboard.press('Escape');
}

test('a user who never switches loads exact and downloads no retained code', async ({ page }) => {
  const downloads = watchDownloads(page);
  await open(page);
  const result = await loadWall(page);
  await downloads.settled();
  expect(result.error).toBeNull();
  expect(result.kernel).toBe('exact');
  expect(result.meshes).toBeGreaterThan(0);
  expect(downloads.urls.filter((url) => /\/smlib\/|\/retained-engine\//.test(url))).toEqual([]);
  expect(downloads.retainedJs).toEqual([]);
  await expect(page.locator('[data-retained-chip]')).toHaveCount(0);
});

test('the Settings choice persists in this browser, runs retained, and ?kernel=exact still overrides it', async ({ page }) => {
  await open(page);
  expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
  await chooseInSettings(page, 'Retained (experimental)');
  expect(await page.evaluate((key) => localStorage.getItem(key), SETTING_KEY)).toBe('retained');

  // A reload is a fresh page of the same browser: the saved choice applies with no parameter.
  await page.reload();
  await page.waitForFunction(() => Boolean((globalThis as typeof globalThis & ViewerGlobals).__ifc_lite_viewer_store__));
  const retained = await loadWall(page);
  expect(retained.error).toBeNull();
  expect(retained.kernel).toBe('retained');
  await expect(page.locator('[data-retained-chip]')).toBeVisible();

  // A new tab with ?kernel=exact overrides the saved choice and fetches nothing retained.
  const tab = await page.context().newPage();
  const downloads = watchDownloads(tab);
  await open(tab, '?kernel=exact');
  const exact = await loadWall(tab);
  await downloads.settled();
  expect(exact.kernel).toBe('exact');
  expect(downloads.urls.filter((url) => /\/smlib\/|\/retained-engine\//.test(url))).toEqual([]);
  expect(await tab.evaluate((key) => localStorage.getItem(key), SETTING_KEY)).toBe('retained');

  // Back to Exact in Settings clears the saved choice.
  await chooseInSettings(page, 'Exact (default)');
  expect(await page.evaluate((key) => localStorage.getItem(key), SETTING_KEY)).toBeNull();
});
