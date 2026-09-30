/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, type Page } from '@playwright/test';
import type { SceneOwnerSnapshot } from '../../apps/viewer/src/lib/viewport-debug-hooks';
import { assertIsolatedRenderedContent, rendererColorFrame } from './federation-control-triplet.rendering';

/** #6499: use production GPU color readback, since SwiftShader can discard compositor pixels. */
export async function collabRenderedWitness(page: Page) {
  const ids = await page.evaluate(() => [...globalThis.__ifc_lite_viewer_store__.getState().models.keys()]);
  const rendered = [];
  for (const modelId of ids) {
    await page.evaluate(id => {
      const state = globalThis.__ifc_lite_viewer_store__.getState();
      state.showEntities(state.models.get(id)?.geometryResult?.meshes.map(mesh => mesh.expressId) ?? []);
      state.hideEntities([...state.models].filter(([other]) => other !== id)
        .flatMap(([, model]) => model.geometryResult?.meshes.map(mesh => mesh.expressId) ?? []));
    }, modelId);
    // Root-only IFCX stores do not carry geometry flags. Use resident mesh ids
    // for this pixel oracle rather than deriving the hide set from those flags.
    const pixels = await assertIsolatedRenderedContent(page, modelId, true, () => page.evaluate(id => {
      const state = globalThis.__ifc_lite_viewer_store__.getState();
      state.hideEntities(state.models.get(id)?.geometryResult?.meshes.map(mesh => mesh.expressId) ?? []);
    }, modelId));
    await page.evaluate(id => {
      const state = globalThis.__ifc_lite_viewer_store__.getState();
      state.setModelVisibility(id, true);
      state.showEntities(state.models.get(id)?.geometryResult?.meshes.map(mesh => mesh.expressId) ?? []);
    }, modelId);
    await page.getByRole('button', { name: 'Fit all', exact: true }).click();
    await page.waitForTimeout(500);
    const canvas = await page.locator('canvas[data-viewport="main"]').boundingBox();
    expect(canvas).not.toBeNull();
    const points = await page.evaluate(id => {
      const state = globalThis.__ifc_lite_viewer_store__.getState();
      const host = globalThis as unknown as { __ifc_lite_scene_owner__: (globalId: number) => SceneOwnerSnapshot };
      return (state.models.get(id)?.geometryResult?.meshes ?? []).slice(0, 64)
        .map(mesh => host.__ifc_lite_scene_owner__(mesh.expressId).screen).filter(point => point !== null);
    }, modelId);
    let picked = false;
    for (const point of points) {
      if (point.x < canvas!.x || point.x >= canvas!.x + canvas!.width
        || point.y < canvas!.y || point.y >= canvas!.y + canvas!.height) continue;
      const target = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, point);
      if (target !== 'CANVAS') continue;
      await page.mouse.click(point.x, point.y);
      await page.waitForTimeout(150);
      picked = await page.evaluate(id => globalThis.__ifc_lite_viewer_store__.getState().selectedEntity?.modelId === id, modelId);
      if (picked) break;
    }
    expect(picked, `${modelId}: ordinary viewport GPU pick resolves the shared model`).toBe(true);
    const stats = await page.evaluate(() => {
      const host = globalThis as unknown as { __ifc_lite_render_stats__: () => unknown };
      return host.__ifc_lite_render_stats__();
    });
    rendered.push({ ...pixels, picked, stats });
  }
  await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    state.clearEntitySelection();
    state.showEntities([...state.models.values()].flatMap(model => model.geometryResult?.meshes.map(mesh => mesh.expressId) ?? []));
    state.setModelsVisibility([...state.models.keys()], true);
  });
  await page.getByRole('button', { name: 'Fit all', exact: true }).click();
  await page.waitForTimeout(500);
  return { rendered, png: await rendererColorFrame(page) };
}
