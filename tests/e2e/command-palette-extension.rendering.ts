/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, type Page, type TestInfo } from '@playwright/test';
import { decodePng, rendererColorFrame, type DecodedPng } from './federation-control-triplet.rendering';

function difference(a: DecodedPng, b: DecodedPng): number {
  expect([b.width, b.height]).toEqual([a.width, a.height]);
  let changed = 0;
  for (let y = Math.floor(a.height * 0.15); y < a.height * 0.85; y++) {
    for (let x = Math.floor(a.width * 0.15); x < a.width * 0.85; x++) {
      const i = (y * a.width + x) * 4;
      if (Math.abs(a.rgba[i]! - b.rgba[i]!) + Math.abs(a.rgba[i + 1]! - b.rgba[i + 1]!)
        + Math.abs(a.rgba[i + 2]! - b.rgba[i + 2]!) >= 24) changed++;
    }
  }
  return changed;
}

/** #8947: completed production GPU readbacks, never the visibility input sets. */
export async function visibilityOutputWitness(page: Page, info: TestInfo, name: string,
  hide: () => Promise<void>, show: () => Promise<void>) {
  const matrix = () => page.evaluate(() => (globalThis as typeof globalThis & {
    __ifc_lite_view_projection__: () => number[];
  }).__ifc_lite_view_projection__());
  const camera = await matrix();
  const capture = async (phase: string) => {
    const png = await rendererColorFrame(page);
    await info.attach(`${name}-${phase}-gpu.png`, { body: png, contentType: 'image/png' });
    expect(await matrix(), 'camera stays fixed through every submitted GPU frame').toEqual(camera);
    return decodePng(png);
  };
  // Independent absent-wall reference: model-level visibility, not the extension's
  // entity hide command. Selection/scene/camera stay fixed. Highlight-only changes
  // cannot satisfy agreement with these completed wall-absent frames (#8947).
  const visibleModels = await page.evaluate(() => [...globalThis.__ifc_lite_viewer_store__.getState().models]
    .filter(([, model]) => model.visible).map(([id]) => id));
  expect(visibleModels.length, 'resident visible model is required').toBeGreaterThan(0);
  let absent: DecodedPng;
  let absentRepeat: DecodedPng;
  try {
    await page.evaluate(ids => {
      const state = globalThis.__ifc_lite_viewer_store__.getState();
      for (const id of ids) state.setModelVisibility(id, false);
    }, visibleModels);
    absent = await capture('model-absent');
    absentRepeat = await capture('model-absent-repeat');
  } finally {
    await page.evaluate(ids => {
      const state = globalThis.__ifc_lite_viewer_store__.getState();
      for (const id of ids) state.setModelVisibility(id, true);
    }, visibleModels);
  }
  const before = await capture('before');
  const beforeRepeat = await capture('before-repeat');
  await hide();
  const hidden = await capture('hidden');
  const hiddenRepeat = await capture('hidden-repeat');
  await show();
  const shown = await capture('shown');
  const shownRepeat = await capture('shown-repeat');
  const noise = Math.max(difference(absent, absentRepeat), difference(before, beforeRepeat), difference(hidden, hiddenRepeat), difference(shown, shownRepeat));
  const hiddenChange = difference(before, hidden);
  const restoredDifference = difference(before, shown);
  const remainingWall = difference(absent, hidden);
  const initialWall = difference(absent, before);
  const shownChange = difference(hidden, shown);
  await info.attach(`${name}-gpu-verdict.json`, {
    body: JSON.stringify({ width: before.width, height: before.height, camera, noise, hiddenChange, shownChange, restoredDifference, remainingWall, initialWall }),
    contentType: 'application/json',
  });
  // Isolated, framed wall must occupy a meaningful area; incidental overlay noise cannot pass.
  const minimum = Math.max(before.width * before.height * 0.01, noise * 3);
  expect(initialWall, 'framed wall renders differently from independently hidden model').toBeGreaterThan(minimum);
  expect(remainingWall, 'hidden output matches the independent wall-absent reference').toBeLessThanOrEqual(Math.max(64, noise * 3));
  expect(remainingWall, 'highlight loss alone cannot pass as wall disappearance').toBeLessThan(initialWall * 0.1);
  expect(hiddenChange, 'Hide changes the actual raster above repeated-frame noise').toBeGreaterThan(minimum);
  expect(shownChange, 'Show changes the actual raster back').toBeGreaterThan(minimum);
  expect(restoredDifference, 'Show restores the original raster within observed noise').toBeLessThanOrEqual(Math.max(64, noise * 3));
  expect(restoredDifference, 'restoration is much closer than the hidden raster').toBeLessThan(hiddenChange * 0.1);
}
