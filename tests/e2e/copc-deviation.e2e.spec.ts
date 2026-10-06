/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BIM-to-scan deviation over a COPC scan whose resident nodes change with the
 * view (#6880 LOD streaming x #6877 statistics), through the real viewer
 * build: Open/Add, the COPC worker, GPU deviation, the panel and its CSV.
 *
 * Invariant: the Deviation panel's statistics and CSV describe the scan
 * points that are resident now. A view that only EVICTS nodes (the scan
 * leaves the frustum) re-runs deviation and refreshes the statistics, just
 * as a view that adds nodes does; before the fix only passes that added
 * nodes did, so the panel kept reporting, and exporting, points that were
 * no longer drawn.
 */

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { ViewerState } from '../../apps/viewer/src/store';
import { DEVICE_LOST_STATE_ERROR, skipForGpuDeviceLoss, watchGpuDeviceLoss } from './gpu-device-loss';

declare global {
  var __ifc_lite_viewer_store__: { getState(): ViewerState };
  var __ifc_lite_copc_lod__: (() => Record<string, { residentPoints?: number }>) | undefined;
  var __ifc_lite_rendered_point_cloud__: ((handleId: number) => { points: Array<[number, number, number]> } | null) | undefined;
}

const IFC = { name: 'building.ifc', mimeType: 'application/octet-stream', buffer: readFileSync('apps/viewer/public/samples/building-architecture.ifc') };
const COPC = { name: 'site.copc.laz', mimeType: 'application/octet-stream', buffer: readFileSync('packages/pointcloud/test-fixtures/tiny.copc.laz') };
const expected = JSON.parse(readFileSync('packages/pointcloud/test-fixtures/tiny-copc.json', 'utf8')) as { pointCount: number };

async function load(page: Page, file: typeof IFC, count: number) {
  await page.locator(count === 1 ? '#file-input-open' : '#file-input-add').setInputFiles(file);
  const outcome = await page.waitForFunction(({ n, deviceLost }) => {
    const state = globalThis.__ifc_lite_viewer_store__?.getState();
    if (!state) return false;
    if (new RegExp(deviceLost).test(String(state.error ?? ''))) return 'device-lost';
    const models = [...state.models.values()];
    if (models.some((m) => m.loadState === 'error')) return `error: ${models.map((m) => m.loadError).join(', ')}`;
    return !state.loading && !state.geometryStreamingActive && models.length === n
      && models.every((m) => m.pointCloudHandleId !== undefined || (m.geometryResult?.meshes.length ?? 0) > 0) ? 'ok' : false;
  }, { n: count, deviceLost: DEVICE_LOST_STATE_ERROR.source }, { timeout: 120_000 }).then((h) => h.jsonValue());
  if (outcome === 'device-lost') skipForGpuDeviceLoss(`load ${file.name}`, String(outcome));
  expect(outcome, `load ${file.name}`).toBe('ok');
}

const resident = (page: Page) => page.evaluate(() =>
  Object.values(globalThis.__ifc_lite_copc_lod__?.() ?? {}).reduce((sum, d) => sum + (d.residentPoints ?? 0), 0));

/** Point the camera at the scan's centre (`toward`) or straight away from it. */
async function look(page: Page, toward: boolean) {
  await page.evaluate((toward) => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const handle = [...state.models.values()].find((m) => m.pointCloudHandleId !== undefined)!.pointCloudHandleId!;
    const points = globalThis.__ifc_lite_rendered_point_cloud__!(handle)!.points;
    const c = [0, 1, 2].map((axis) => points.reduce((sum, p) => sum + p[axis], 0) / points.length);
    const eye = { x: c[0] + 25, y: c[1] + 25, z: c[2] + 25 };
    const target = toward ? { x: c[0], y: c[1], z: c[2] } : { x: c[0] + 50, y: c[1] + 50, z: c[2] + 50 };
    state.cameraCallbacks.applyViewpoint!({ position: eye, target, up: { x: 0, y: 1, z: 0 }, fov: Math.PI / 4, projectionMode: 'perspective' }, false);
  }, toward);
}

/** The panel's "Points measured" figure, once its statistics are on screen. */
const measured = (page: Page) => page.evaluate(() => {
  const term = [...document.querySelectorAll('[data-testid="deviation-summary"] dt')].find((dt) => dt.textContent === 'Points measured');
  return term?.nextElementSibling?.textContent ?? null;
});

async function exportRows(page: Page): Promise<Array<Record<string, string>>> {
  const button = page.getByRole('button', { name: 'Export CSV', exact: true });
  await expect(button).toBeEnabled();
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  const [header, ...lines] = readFileSync((await download.path())!, 'utf8').replace(/^﻿/, '').trimEnd().split(/\r?\n/);
  const columns = header.split(',');
  return lines.map((line) => Object.fromEntries(line.split(',').map((cell, i) => [columns[i], cell])));
}

test('COPC deviation statistics follow the resident nodes as the view changes (#6880, #6877)', async ({ page }, info) => {
  const gpu = await watchGpuDeviceLoss(page);
  await page.goto('/');
  await load(page, IFC, 1);
  await load(page, COPC, 2);
  await gpu.skipIfLost('IFC + COPC load');
  const count = expected.pointCount.toLocaleString('en-US');

  await gpu.requireLiveGpu('COPC deviation across views', async () => {
    // The scan sits at LV95 coordinates, far from the local IFC: frame it.
    await look(page, true);
    await expect.poll(() => resident(page), { timeout: 30_000 }).toBe(expected.pointCount);
    await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().openWorkspacePanel('pointclouds', 'programmatic'));
    await page.getByRole('button', { name: 'Compute deviation', exact: true }).click();
    await expect.poll(() => measured(page), { timeout: 30_000 }).toBe(count);
    const inView = await exportRows(page);
    expect(inView.map((r) => r.PointsProcessed)).toEqual([String(expected.pointCount)]);

    // Looking away evicts every node: the statistics must stop describing them.
    const revision = await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().pointCloudDeviationRevision);
    await look(page, false);
    await expect.poll(() => resident(page), { timeout: 30_000 }).toBe(0);
    await expect.poll(() => measured(page), { timeout: 30_000 }).toBe('0');
    expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().pointCloudDeviationRevision)).toBeGreaterThan(revision);

    // Back in view, the re-streamed nodes are measured again.
    await look(page, true);
    await expect.poll(() => resident(page), { timeout: 30_000 }).toBe(expected.pointCount);
    await expect.poll(() => measured(page), { timeout: 30_000 }).toBe(count);
    const back = await exportRows(page);
    await info.attach('deviation CSV rows', { body: JSON.stringify({ inView, back }, null, 2), contentType: 'application/json' });
    expect(back.map((r) => r.PointsProcessed)).toEqual([String(expected.pointCount)]);
  });
});
