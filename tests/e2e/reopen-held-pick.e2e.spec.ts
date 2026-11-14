/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const FIXTURE = 'tests/models/ara3d/C20-Institute-Var-2.ifc';
const WARMUP = 'tests/models/ara3d/AC20-FZK-Haus.ifc';
const deadline = 180_000;
type E2EModel = { id: string; geometryRestorePending?: boolean; geometryResult: { meshes: Array<{ expressId: number }> } };
type E2EState = { loading: boolean; geometryStreamingActive: boolean; models: Map<string, E2EModel>; selectedEntityId: number | null; selectedEntityIds: Set<number>; activeModelId: string | null; setSelectedEntityId(id: number | null): void; toGlobalId(modelId: string, expressId: number): number };
type E2EWindow = typeof globalThis & {
  __ifc_lite_geometry_restore_test__?: { releaseDelayMs?: number; geometryRestoreBackstopFires?: () => number };
  __ifc_lite_viewer_store__?: { getState(): E2EState };
  __IFC_LITE_LOAD_TRACE__?: { latest(): { spans?: Array<{ name: string; end: number | null }> } | undefined };
  __ifc_lite_scene_owner__?: (id: number) => { screen: { x: number; y: number } | null };
};

test('#10218 reopen ignores a viewport click until restored geometry can be picked', async ({ context }) => {
  test.skip(!existsSync(join(process.cwd(), FIXTURE)) || !existsSync(join(process.cwd(), WARMUP)), 'IFC fixtures missing — run `pnpm fixtures`');
  const settled = () => {
    const s = (globalThis as E2EWindow).__ifc_lite_viewer_store__?.getState();
    return Boolean(s && !s.loading && !s.geometryStreamingActive);
  };
  // Cold load (as cold-load-scene-snapshot does): warm-up model first, then the fixture, until its scene snapshot is written.
  const cold = await context.newPage();
  await cold.goto('/?perfTrace=1');
  await cold.waitForFunction(() => Boolean((globalThis as E2EWindow).__ifc_lite_viewer_store__));
  await cold.locator('#file-input-open').setInputFiles(join(process.cwd(), WARMUP));
  await cold.waitForFunction(settled, null, { timeout: deadline });
  await cold.locator('#file-input-open').setInputFiles(join(process.cwd(), FIXTURE));
  await cold.waitForFunction(() => {
    const load = (globalThis as E2EWindow).__IFC_LITE_LOAD_TRACE__?.latest();
    return Boolean(load?.spans?.some((s: { name: string; end: number | null }) => s.name === 'cache.writeSceneSnapshot' && s.end !== null));
  }, null, { timeout: deadline, polling: 250 });
  // A point of the canvas that selects an element of the fixture, and that element's express id (offsets differ per page).
  const selectedExpressId = (page: Page) => page.evaluate(() => {
    const s = (globalThis as E2EWindow).__ifc_lite_viewer_store__!.getState() as unknown as { selectedEntityId: number | null; activeModelId: string | null; models: Map<string, { idOffset: number }> };
    const offset = s.activeModelId ? s.models.get(s.activeModelId)?.idOffset ?? 0 : 0;
    return s.selectedEntityId === null ? null : s.selectedEntityId - offset;
  });
  const coldCanvas = cold.locator('canvas').first();
  const box = await coldCanvas.boundingBox();
  if (!box) throw new Error('no render canvas');
  let point: { x: number; y: number } | null = null;
  let expected: number | null = null;
  for (const [fx, fy] of [[0.5, 0.55], [0.5, 0.4], [0.45, 0.6], [0.6, 0.5], [0.4, 0.45]] as const) {
    await coldCanvas.click({ position: { x: box.width * fx, y: box.height * fy } });
    await cold.waitForTimeout(300);
    expected = await selectedExpressId(cold);
    if (expected !== null) { point = { x: box.x + box.width * fx, y: box.y + box.height * fy }; break; }
  }
  if (!point || expected === null) throw new Error('no probe point selects an element of the cold-loaded model');
  await cold.close();

  // Reopen in a fresh page (a primary cache hit that adopts the stored scene), with the restore release held long enough to click.
  const page = await context.newPage();
  await page.addInitScript(() => {
    (globalThis as E2EWindow).__ifc_lite_geometry_restore_test__ = { releaseDelayMs: 2500 };
  });
  await page.goto('/?perfTrace=1');
  await page.waitForFunction(() => Boolean((globalThis as E2EWindow).__ifc_lite_viewer_store__));
  await page.locator('#file-input-open').setInputFiles(join(process.cwd(), FIXTURE));
  await page.waitForFunction(() => {
    const g = globalThis as E2EWindow;
    const s = g.__ifc_lite_viewer_store__?.getState();
    const names = g.__IFC_LITE_LOAD_TRACE__?.latest()?.spans?.map((span: { name: string }) => span.name) ?? [];
    return Boolean(s?.models && [...s.models.values()].some((m: E2EModel) => m.geometryRestorePending)
      && names.includes('scene.snapshotAdopted'));
  }, null, { timeout: deadline, polling: 50 });

  // Tree-style selection remains usable during restore; the viewport click is ignored.
  // Geometry is not published during the hold (only metadata is): select a known element by id, as the tree does.
  const heldSelection = await page.evaluate((expressId) => {
    const state = (globalThis as E2EWindow).__ifc_lite_viewer_store__!.getState();
    const [modelId] = [...state.models][0]!;
    state.setSelectedEntityId(state.toGlobalId(modelId, expressId));
    const after = (globalThis as E2EWindow).__ifc_lite_viewer_store__!.getState(); // a set makes a new state object: re-read
    return { id: after.selectedEntityId, ids: [...after.selectedEntityIds] };
  }, expected);
  expect(heldSelection.id, 'the tree-style selection took effect during the hold').not.toBeNull();
  expect(await page.evaluate(() => [...(globalThis as E2EWindow).__ifc_lite_viewer_store__!.getState().models.values()].some((m) => m.geometryRestorePending)),
    'the click lands while the geometry restore still holds').toBe(true);
  await page.mouse.click(point.x, point.y);
  expect(await page.evaluate(() => {
    const state = (globalThis as E2EWindow).__ifc_lite_viewer_store__!.getState();
    return { id: state.selectedEntityId, ids: [...state.selectedEntityIds] };
  })).toEqual(heldSelection);
  await page.waitForFunction(() => {
    const state = (globalThis as E2EWindow).__ifc_lite_viewer_store__!.getState();
    return ![...state.models.values()].some((model: E2EModel) => model.geometryRestorePending);
  }, null, { timeout: deadline, polling: 50 });
  expect(await page.evaluate(() => {
    const state = (globalThis as E2EWindow).__ifc_lite_viewer_store__!.getState();
    return { id: state.selectedEntityId, ids: [...state.selectedEntityIds] };
  })).toEqual(heldSelection);
  await page.mouse.click(point.x, point.y);
  await expect.poll(() => selectedExpressId(page), { timeout: 10_000, message: 'a post-release click selects the element at the probe point' }).toBe(expected);
  expect(await page.evaluate(() => (globalThis as E2EWindow).__ifc_lite_geometry_restore_test__?.geometryRestoreBackstopFires?.())).toBe(0);
});
