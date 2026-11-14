/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const FIXTURE = 'tests/models/ara3d/C20-Institute-Var-2.ifc';
const WARMUP = 'tests/models/ara3d/AC20-FZK-Haus.ifc';
const deadline = 180_000;
type E2EModel = { id: string; geometryRestorePending?: boolean; geometryResult: { meshes: Array<{ expressId: number }> } };
type E2EState = { loading: boolean; geometryStreamingActive: boolean; models: Map<string, E2EModel>; selectedEntityIds: Set<number>; toGlobalId(modelId: string, expressId: number): number };
type E2EWindow = typeof globalThis & {
  __ifc_lite_geometry_restore_test__?: { releaseDelayMs?: number; geometryRestoreBackstopFires?: () => number };
  __ifc_lite_viewer_store__?: { getState(): E2EState };
  __IFC_LITE_LOAD_TRACE__?: { latest(): { spans?: Array<{ name: string; end: number | null }> } | undefined };
  __ifc_lite_scene_owner__?: (id: number) => { screen: { x: number; y: number } | null };
};

test('reopen queues a viewport click until restored geometry can be picked', async ({ page }) => {
  test.skip(!existsSync(join(process.cwd(), FIXTURE)) || !existsSync(join(process.cwd(), WARMUP)), 'IFC fixtures missing — run `pnpm fixtures`');
  await page.addInitScript(() => {
    (globalThis as E2EWindow).__ifc_lite_geometry_restore_test__ = { releaseDelayMs: 2500 };
  });
  await page.goto('/');
  await page.waitForFunction(() => Boolean((globalThis as E2EWindow).__ifc_lite_viewer_store__));
  await page.locator('#file-input-open').setInputFiles(join(process.cwd(), WARMUP));
  await page.waitForFunction(() => {
    const s = (globalThis as E2EWindow).__ifc_lite_viewer_store__?.getState();
    return Boolean(s && !s.loading && !s.geometryStreamingActive);
  }, null, { timeout: deadline });

  await page.locator('#file-input-open').setInputFiles(join(process.cwd(), FIXTURE));
  await page.waitForFunction(() => {
    const g = globalThis as E2EWindow;
    const load = g.__IFC_LITE_LOAD_TRACE__?.latest();
    return Boolean(load?.spans?.some((s: { name: string; end: number | null }) => s.name === 'cache.writeSceneSnapshot' && s.end !== null));
  }, null, { timeout: deadline, polling: 250 });
  await page.waitForFunction(() => {
    const s = (globalThis as E2EWindow).__ifc_lite_viewer_store__?.getState();
    return Boolean(s && !s.loading && !s.geometryStreamingActive);
  }, null, { timeout: deadline });

  await page.locator('#file-input-open').setInputFiles(join(process.cwd(), FIXTURE));
  await page.waitForFunction(() => {
    const g = globalThis as E2EWindow;
    const s = g.__ifc_lite_viewer_store__?.getState();
    const names = g.__IFC_LITE_LOAD_TRACE__?.latest()?.spans?.map((span: { name: string }) => span.name) ?? [];
    return Boolean(s?.models && [...s.models.values()].some((m: E2EModel) => m.geometryRestorePending)
      && names.includes('scene.snapshotAdopted'));
  }, null, { timeout: deadline, polling: 50 });

  const target = await page.evaluate(() => {
    const g = globalThis as E2EWindow;
    const state = g.__ifc_lite_viewer_store__.getState();
    const model = [...state.models.values()].find((item: E2EModel) => item.geometryRestorePending);
    const expressId = model.geometryResult.meshes[0].expressId;
    const globalId = state.toGlobalId(model.id, expressId);
    return { globalId, screen: g.__ifc_lite_scene_owner__(globalId).screen };
  });
  expect(target.screen).not.toBeNull();
  if (!target.screen) throw new Error('the reopened model has no visible element at the chosen point');
  await page.mouse.click(target.screen.x, target.screen.y);
  await page.waitForFunction((id) => {
    const state = (globalThis as E2EWindow).__ifc_lite_viewer_store__.getState();
    return ![...state.models.values()].some((model: E2EModel) => model.geometryRestorePending)
      && state.selectedEntityIds.has(id);
  }, target.globalId, { timeout: deadline, polling: 50 });
  expect(await page.evaluate(() => (globalThis as E2EWindow).__ifc_lite_geometry_restore_test__?.geometryRestoreBackstopFires?.())).toBe(0);
});
