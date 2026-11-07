/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #8341 F2: a type record the decoder cannot read loses its type geometry, and
 * the viewer must say so. The fixture carries one such record (#500, with two
 * maps) beside a valid type. Loaded twice through the real file input: as is
 * (under 2 MB, the main-thread `buildPrePassOnce` path) and padded past 2 MB
 * with inert points (the dedicated prepass worker, whose `complete` event
 * carries the count to the host).
 */

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';

const STORE = '__ifc_lite_viewer_store__';
const FIXTURE = 'rust/processing/tests/fixtures/f2_omitted_type_record_8341.ifc';
const NOTICE = /: 1 type definition could not be read, so its type geometry was left out\./;
const LINE = '1 type definition could not be read, so its type geometry was left out.';

/** The fixture plus enough unreferenced points to cross the 2 MB parallel threshold. */
function padded(source: string): Buffer {
  const points: string[] = [];
  for (let id = 100_000; id < 170_000; id++) points.push(`#${id}=IFCCARTESIANPOINT((0.,0.,0.));`);
  return Buffer.from(source.replace('ENDSEC;\nEND-ISO', `${points.join('\n')}\nENDSEC;\nEND-ISO`));
}

async function loadAndReadCount(page: Page, file: { name: string; buffer: Buffer }): Promise<unknown> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/');
  await page.waitForFunction((k) => !!(globalThis as Record<string, unknown>)[k], STORE, { timeout: 120000 });
  await page.locator('input[type="file"]').first().setInputFiles({ ...file, mimeType: 'application/octet-stream' });
  await expect(page.getByText(NOTICE).first()).toBeVisible({ timeout: 120000 });
  // The notice fires on the stream's `complete`; the model record is finalized after it.
  await page.waitForFunction((k) => {
    const s = (globalThis as unknown as Record<string, { getState(): { models: Map<string, { omittedTypeRecords?: number }> } }>)[k].getState();
    return [...s.models.values()].some((m) => m.omittedTypeRecords !== undefined);
  }, STORE, { timeout: 60000 });
  return page.evaluate((k) => {
    const s = (globalThis as unknown as Record<string, { getState(): { models: Map<string, { omittedTypeRecords?: number }> } }>)[k].getState();
    return [...s.models.values()].map((m) => m.omittedTypeRecords);
  }, STORE);
}

async function expectLoadReportLine(page: Page): Promise<void> {
  await page.evaluate((k) => {
    (globalThis as unknown as Record<string, { getState(): { openPanelInHome(panel: 'loadReport'): void } }>)[k]
      .getState().openPanelInHome('loadReport');
  }, STORE);
  const report = page.getByRole('region', { name: 'Load report', exact: true });
  await expect(report).toContainText(LINE);
  await expect(report).toContainText('Issues found');
}

test('#8341: a small load (main-thread prepass) reports the omitted type record', async ({ page }) => {
  const buffer = readFileSync(join(process.cwd(), FIXTURE));
  expect(buffer.length).toBeLessThan(2 * 1024 * 1024);
  expect(await loadAndReadCount(page, { name: 'f2_omitted_type_record_8341.ifc', buffer })).toEqual([1]);
  await expectLoadReportLine(page);
});

test('#8341: a large load (prepass worker) relays the count on its complete event', async ({ page }) => {
  const buffer = padded(readFileSync(join(process.cwd(), FIXTURE), 'utf8'));
  expect(buffer.length).toBeGreaterThan(2 * 1024 * 1024);
  const workerScripts: string[] = [];
  page.on('worker', (worker) => workerScripts.push(worker.url()));
  expect(await loadAndReadCount(page, { name: 'f2_padded_8341.ifc', buffer })).toEqual([1]);
  expect(workerScripts.some((url) => url.includes('geometry.worker')), 'the parallel worker path ran').toBe(true);
  await expectLoadReportLine(page);
});
