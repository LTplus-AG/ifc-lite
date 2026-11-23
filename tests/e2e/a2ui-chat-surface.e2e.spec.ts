/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A2UI in the chat, in the real viewer: `?a2uiDemo=1` plays a recorded
 * assistant reply through the chat's streaming store fields once the sample is
 * loaded. The EntityTable it renders is query-bound, so its rows come from the
 * model; clicking one must select that wall in 3D (docs/architecture/a2ui.md).
 */
import { test, expect, type Page } from '@playwright/test';
import type { ViewerState } from '../../apps/viewer/src/store';

declare global {
  var __ifc_lite_viewer_store__: { getState(): ViewerState };
}

async function waitForModel(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const state = globalThis.__ifc_lite_viewer_store__?.getState();
    return state?.models.size === 1 && !state.loading &&
      [...state.models.values()].every((model) => model.ifcDataStore && (model.geometryResult?.meshes.length ?? 0) > 0);
  }, undefined, { timeout: 180_000 });
}

function selection(page: Page) {
  return page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    return { globalIds: [...state.selectedEntityIds], refs: [...state.selectedEntitiesSet], modelIds: [...state.models.keys()] };
  });
}

test('a recorded A2UI reply renders a live EntityTable whose row click selects the wall in 3D', async ({ page }, info) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/?model=/samples/building-architecture.ifc&a2uiDemo=1');
  await page.waitForFunction(() => !!globalThis.__ifc_lite_viewer_store__, undefined, { timeout: 120_000 });
  await waitForModel(page);

  // Wait for the finalised message (the streaming copy unmounts when the reply ends).
  await page.waitForFunction(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    return state.chatStatus === 'idle' && !!state.chatMessages.at(-1)?.a2ui;
  }, undefined, { timeout: 60_000 });
  const rows = page.locator('[data-a2ui-row]');
  await expect(rows).toHaveCount(4, { timeout: 60_000 });
  await expect(page.locator('[data-a2ui-stat]')).toHaveCount(4);
  // Sorted by NetVolume, largest first: #315 "house - outer wall - house left".
  await expect(rows.first()).toContainText('house - outer wall - house left');
  await page.locator('[data-a2ui-surface]').first().screenshot({ path: info.outputPath('a2ui-surface.png') });

  const before = await selection(page);
  await rows.first().click();
  await expect.poll(async () => (await selection(page)).globalIds.length).toBe(1);
  const after = await selection(page);
  expect(after.globalIds).not.toEqual(before.globalIds);
  const modelId = after.modelIds[0];
  expect(await rows.first().getAttribute('data-a2ui-row')).toBe(`${modelId}:315`);
  expect(after.refs).toContain(`${modelId}:315`);
  await page.screenshot({ path: info.outputPath('a2ui-chat-surface-selected.png') });
});
