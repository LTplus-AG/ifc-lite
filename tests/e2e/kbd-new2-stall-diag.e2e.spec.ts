/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #5841: real authored IFC keyboard commands and modal priority. */
import { test, expect } from '@playwright/test';
import type { ViewerState } from '../../apps/viewer/src/store';

declare global {
  var __ifc_lite_viewer_store__: { getState(): ViewerState };
}

test('#5841 shared dispatcher preserves 3D commands while a modal owns its keys', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript((stall) => {
    localStorage.setItem('ifclite.extensions.privacy-disclosure.v2', 'e2e acknowledged');
    if (stall) window.addEventListener('keydown', (e) => {
      if (!/^[1-6]$/.test(e.key)) return;
      const real = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => real(() => { setTimeout(() => cb(performance.now()), 700); }) as unknown as number;
    });
  }, true);
  await page.goto('/?model=/samples/building-architecture.ifc');
  await expect.poll(() => page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__?.getState();
    const model = state && [...state.models.values()][0];
    const entities = model?.ifcDataStore?.entities.count ?? 0;
    return { ready: state?.models.size === 1 && !state.loading && entities > 0,
      models: state?.models.size ?? 0, loading: state?.loading ?? true, entities };
  }), { timeout: 180_000 }).toMatchObject({ ready: true });
  await expect(page.locator('canvas').first()).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  for (const [key, tool] of [['v', 'select'], ['c', 'walk'], ['m', 'measure'], ['x', 'section']] as const) {
    await page.keyboard.press(key);
    await expect.poll(() => page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().activeTool)).toBe(tool);
  }
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().activeTool)).toBe('select');

  const tweening = () => page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().cameraCallbacks.isCameraTweening?.());
  // The preset loop below trusts isCameraTweening() to say a tween is over, so
  // show the viewer's wiring is neither stuck false nor stuck true. The first two reads
  // run in one task, before any frame can have applied the tween: a tween
  // started through the viewer's own animated applyViewpoint must read true at
  // once, and must read false again once the render loop has finished it.
  const wiring = await page.evaluate(() => {
    const callbacks = globalThis.__ifc_lite_viewer_store__.getState().cameraCallbacks;
    const view = callbacks.getViewpoint?.();
    if (!view || !callbacks.applyViewpoint || !callbacks.isCameraTweening) throw new Error('camera callbacks are missing');
    const before = callbacks.isCameraTweening();
    callbacks.applyViewpoint({ ...view, position: { ...view.position, y: view.position.y + 5 } }, true, 300);
    return { before, started: callbacks.isCameraTweening() };
  });
  expect(wiring, 'idle camera is not tweening; an animated applyViewpoint starts a tween').toEqual({ before: false, started: true });
  await expect.poll(tweening, { message: 'the viewer reports the tween finished once the render loop has applied it', timeout: 30_000 }).toBe(false);

  const viewpoints: string[] = [];
  const initial = await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().cameraCallbacks.getViewpoint?.());
  // Poses a settled preset must differ from: the load framing, then each earlier preset.
  const used = [JSON.stringify(initial?.position)];
  for (const key of ['1', '2', '3', '4', '5', '6']) {
    await page.keyboard.press(key);
    // Camera.setPresetView tweens its pose over 300 ms of wall clock, but the
    // tween is only applied by the render loop's update(). On a loaded hosted
    // runner one SwiftShader frame can outlast a fixed sleep, and the pose read
    // after it is still the previous preset's (CI run 40977269130 attempt 2:
    // preset 6 read back exactly preset 5's position, Set size 5). Equal reads
    // do not prove a tween finished either: with the render loop stalled they
    // are equally what an intermediate pose looks like. So wait on the camera's
    // own signal, which stays true until update() has applied the final pose,
    // and take the pose only then. Inspect the renderer viewpoint, not the
    // intentionally static store cameraRotation. A preset that never moves the
    // camera still fails: its pose is one an earlier preset already used.
    let settled: string | undefined;
    await expect.poll(async () => {
      const read = await page.evaluate(() => {
        const callbacks = globalThis.__ifc_lite_viewer_store__.getState().cameraCallbacks;
        return { tweening: callbacks.isCameraTweening?.(), viewpoint: callbacks.getViewpoint?.() };
      });
      expect(read.tweening, 'the viewer exposes the camera tween state').not.toBeUndefined();
      expect(read.viewpoint, `view preset ${key} has a live camera`).toBeTruthy();
      const position = JSON.stringify(read.viewpoint?.position);
      settled = read.tweening === false && !used.includes(position) ? position : undefined;
      return settled ?? null;
    }, { message: `view preset ${key} finishes its tween on a pose no earlier preset used`, timeout: 30_000, intervals: [150] }).not.toBeNull();
    viewpoints.push(settled!);
    used.push(settled!);
  }
  expect(new Set(viewpoints).size, 'all six view presets drive distinct camera positions').toBe(6);

  await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const prior = state.cameraCallbacks;
    (globalThis as typeof globalThis & { __keyboardFitCalls: number }).__keyboardFitCalls = 0;
    state.setCameraCallbacks({ ...prior, fitAll: () => {
      (globalThis as typeof globalThis & { __keyboardFitCalls: number }).__keyboardFitCalls++;
      prior.fitAll?.();
    } });
  });
  await page.keyboard.press('f');
  await page.keyboard.press('z');
  expect(await page.evaluate(() => (globalThis as typeof globalThis & { __keyboardFitCalls: number }).__keyboardFitCalls),
    'F frames an empty selection and Z fits the loaded IFC').toBe(2);

  await page.keyboard.press('e');
  await expect.poll(() => page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().editEnabled)).toBe(true);
  const edit = await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const model = [...state.models.values()][0];
    const entities = model.ifcDataStore?.entities;
    if (!entities) throw new Error('authored IFC data store missing');
    const entityId = Array.from(entities.expressId).find((id) => Boolean(entities.getName(id)));
    if (entityId === undefined) throw new Error('authored IFC has no named entity');
    const oldName = entities.getName(entityId);
    return { modelId: model.id, committed: state.setAttribute(model.id, entityId, 'Name', 'Keyboard undo witness', oldName) !== null };
  });
  expect(edit.committed, 'real model attribute mutation committed').toBe(true);
  await expect.poll(() => page.evaluate((modelId) =>
    globalThis.__ifc_lite_viewer_store__.getState().undoStacks.get(modelId)?.length ?? 0, edit.modelId)).toBe(1);
  await page.keyboard.press('Control+z');
  await expect.poll(() => page.evaluate((modelId) => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    return { undo: state.undoStacks.get(modelId)?.length ?? 0, redo: state.redoStacks.get(modelId)?.length ?? 0 };
  }, edit.modelId)).toEqual({ undo: 0, redo: 1 });

  const theme = await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().theme);
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await palette.evaluate((element) => { const dialog = element as HTMLElement; dialog.tabIndex = -1; dialog.focus(); });
  await page.keyboard.press('t');
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().theme),
    'modal command palette blocks global theme T').toBe(theme);
  await page.keyboard.press('Escape');
  await expect(palette).not.toBeVisible();

  await testInfo.attach('authored-ifc-keyboard-viewer', { body: await page.screenshot(), contentType: 'image/png' });
});
