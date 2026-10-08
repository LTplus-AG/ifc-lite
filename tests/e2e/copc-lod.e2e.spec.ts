/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * COPC through the real viewer build (#6869): the canonical Open path, the
 * decode worker, laz-perf's `ChunkDecoder` fetched through the Vite `?url`
 * asset, and keyed renderer chunks. Until this spec, no e2e decoded a single
 * compressed LAS point (see laz-wasm.e2e.spec.ts).
 *
 * The fixture is `packages/pointcloud/test-fixtures/tiny.copc.laz` (1,800
 * points, 45 nodes on 8 hierarchy pages; expected numbers in
 * `tiny-copc.json`). It is opened under a `.las` name: COPC must be detected
 * by its `copc`/`info` VLR, not by the `.copc.laz` suffix.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { ViewerState } from '../../apps/viewer/src/store';
import { DEVICE_LOST_STATE_ERROR, skipForGpuDeviceLoss, watchGpuDeviceLoss } from './gpu-device-loss';

declare global {
  var __ifc_lite_viewer_store__: { getState(): ViewerState };
  var __ifc_lite_render_stats__: (() => { pointCloudPoints: number }) | undefined;
  var __ifc_lite_rendered_point_cloud__: ((handleId: number) => { pointCount: number } | null) | undefined;
}

const FIXTURE = 'packages/pointcloud/test-fixtures/tiny.copc.laz';
const expected = JSON.parse(readFileSync('packages/pointcloud/test-fixtures/tiny-copc.json', 'utf8')) as {
  pointCount: number;
  classCounts: Record<string, number>;
};

test('COPC files stream octree nodes into one renderer asset each and free them on removal (#6869)', async ({ page }) => {
  const gpu = await watchGpuDeviceLoss(page);
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('/');
  await page.locator('#file-input-open').setInputFiles({
    name: 'renamed-scan.las',
    mimeType: 'application/octet-stream',
    buffer: readFileSync(FIXTURE),
  });
  const outcome = await gpu.raceLoss('COPC load', () => page.waitForFunction((deviceLost) => {
    const state = globalThis.__ifc_lite_viewer_store__?.getState();
    if (!state) return false;
    if (new RegExp(deviceLost).test(String(state.error ?? ''))) return 'device-lost';
    const models = [...state.models.values()];
    if (models.some((m) => m.loadState === 'error')) return `error: ${models.map((m) => m.loadError).join(', ')}`;
    return !state.loading && models.length === 1 && models[0].pointCloudHandleId !== undefined
      && models[0].loadState === 'complete' ? 'ok' : false;
  }, DEVICE_LOST_STATE_ERROR.source, { timeout: 120_000 }).then((h) => h.jsonValue()));
  if (outcome === 'device-lost' || await gpu.lost(500)) skipForGpuDeviceLoss('COPC load', String(outcome));
  expect(outcome, `load outcome; page errors: ${pageErrors.join('; ')}`).toBe('ok');

  const handleId = await page.evaluate(() =>
    [...globalThis.__ifc_lite_viewer_store__.getState().models.values()][0].pointCloudHandleId as number);

  await gpu.requireLiveGpu('COPC node streaming and removal', () => gpu.raceLoss('COPC node streaming and removal', async () => {
    // The camera frames the whole (small) cloud, so the view-dependent
    // selection settles on every node: all points resident, none twice.
    await expect.poll(() => page.evaluate(() => globalThis.__ifc_lite_render_stats__?.().pointCloudPoints), { timeout: 30_000 })
      .toBe(expected.pointCount);

    // Coarse nodes (levels 0-2: the whole fixture) fed the scan cache once each.
    const sampled = await page.evaluate((id) => globalThis.__ifc_lite_rendered_point_cloud__?.(id)?.pointCount, handleId);
    expect(sampled).toBe(expected.pointCount);

    // Class histogram, estimated from decoded nodes (stride 1 here: exact).
    const classes = await page.evaluate((id) => globalThis.__ifc_lite_viewer_store__.getState().pointCloudClassCounts[id], handleId);
    expect(classes).toEqual(Object.fromEntries(Object.entries(expected.classCounts).map(([k, v]) => [k, v])));

    // A second copy through Add (the federated path into the same loadFile).
    await page.locator('#file-input-add').setInputFiles({
      name: 'second.copc.laz', mimeType: 'application/octet-stream', buffer: readFileSync(FIXTURE),
    });
    await expect.poll(() => page.evaluate(() => globalThis.__ifc_lite_render_stats__?.().pointCloudPoints), { timeout: 60_000 })
      .toBe(2 * expected.pointCount);

    // Removing one model frees exactly its keyed node chunks; the other stays.
    await page.evaluate((id) => {
      const state = globalThis.__ifc_lite_viewer_store__.getState();
      const [modelId] = [...state.models.entries()].find(([, m]) => m.pointCloudHandleId === id) ?? [];
      if (modelId) state.removeModel(modelId);
    }, handleId);
    await expect.poll(() => page.evaluate((id) => {
      const state = globalThis.__ifc_lite_viewer_store__.getState();
      return {
        models: state.models.size,
        removedClasses: state.pointCloudClassCounts[id] ?? null,
        resident: globalThis.__ifc_lite_render_stats__?.().pointCloudPoints,
      };
    }, handleId), { timeout: 15_000 }).toEqual({ models: 1, removedClasses: null, resident: expected.pointCount });
  }));
  expect(pageErrors).toEqual([]);
});
