/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Real viewport evidence helpers for the federation control triplet. */
import { expect, type Page } from '@playwright/test';
import type { ViewerState } from '../../apps/viewer/src/store';

declare global {
  var __ifc_lite_viewer_store__: { getState(): ViewerState };
  var __ifc_lite_rendered_point_cloud__: ((handleId: number) => {
    pointCount: number;
    points: Point3[];
  } | null) | undefined;
}

type Point3 = readonly [number, number, number];
type ControlPoint = { id: string; local: Point3 };
type RenderPoint = (point: Point3) => { x: number; y: number; z: number };

export interface RenderedModelEvidence {
  modelId: string;
  bytesPerPixel: number | null;
  renderedBytes: number | null;
  blankBytes: number | null;
}

export interface OrdinarySelection {
  selectedEntityId: number | null;
  selectedEntity: { modelId: string; expressId: number } | null;
  selectedLandXmlSource: { modelId: string; sourceId: string } | null;
  selectedModelId: string | null;
}

export async function snapshotRenderedPointCloud(page: Page, handleId: number, timeout: number): Promise<{ pointCount: number; points: Point3[] }> {
  await page.waitForFunction((handle) => {
    const snapshot = globalThis.__ifc_lite_rendered_point_cloud__?.(handle);
    return snapshot !== null && snapshot !== undefined && snapshot.points.length > 0;
  }, handleId, { timeout });
  return page.evaluate((handle) => {
    const snapshot = globalThis.__ifc_lite_rendered_point_cloud__?.(handle);
    if (!snapshot) throw new Error(`rendered point-cloud snapshot unavailable for handle ${handle}`);
    return snapshot;
  }, handleId);
}

async function showOnlyModelAndFrame(page: Page, modelId: string): Promise<void> {
  await page.evaluate((id) => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    state.clearEntitySelection();
    state.setModelsVisibility(state.models.keys(), false);
    state.setModelVisibility(id, true);
    state.openReposition([id]);
  }, modelId);
  await page.waitForFunction((id) => {
    const models = globalThis.__ifc_lite_viewer_store__.getState().models;
    return [...models.values()].filter((model) => model.visible).map((model) => model.id).join(',') === id;
  }, modelId);
  await page.getByRole('button', { name: 'Frame moving', exact: true }).click();
  await page.waitForTimeout(500); // fitting is animated; wait for a painted frame
  await page.keyboard.press('Escape');
}

export async function assertIsolatedRenderedContent(page: Page, modelId: string, gpuStrict: boolean): Promise<RenderedModelEvidence> {
  await showOnlyModelAndFrame(page, modelId);
  if (!gpuStrict) {
    console.log(`[e2e] E2E_GPU_STRICT=0 — skipping ${modelId} isolated canvas-density assertion (software WebGPU)`);
    return { modelId, bytesPerPixel: null, renderedBytes: null, blankBytes: null };
  }
  const canvas = page.locator('canvas').first();
  await expect(canvas, 'viewer canvas').toBeVisible();
  const png = await canvas.screenshot();
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  const bytesPerPixel = png.byteLength / (width * height);
  await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    state.setModelsVisibility(state.models.keys(), false);
  });
  await page.waitForTimeout(250);
  const blank = await canvas.screenshot();
  expect(png.byteLength - blank.byteLength,
    `${modelId}: isolated rendered canvas (${png.byteLength}B, ${bytesPerPixel.toFixed(4)} B/px) exceeds its blank canvas (${blank.byteLength}B)`)
    .toBeGreaterThan(16);
  return { modelId, bytesPerPixel, renderedBytes: png.byteLength, blankBytes: blank.byteLength };
}

export async function ordinaryGpuSelectControl(
  page: Page, modelId: string, control: ControlPoint, toRender: RenderPoint, gpuStrict: boolean,
): Promise<OrdinarySelection> {
  await showOnlyModelAndFrame(page, modelId);
  if (!gpuStrict) {
    console.log(`[e2e] E2E_GPU_STRICT=0 — skipping ${modelId} ordinary GPU selection assertion (software WebGPU)`);
    return page.evaluate(selectionSnapshot);
  }
  const projected = await page.evaluate((point) => globalThis.__ifc_lite_viewer_store__.getState()
    .cameraCallbacks.projectToScreen!(point), toRender(control.local));
  expect(projected, `${control.id}: isolated ${modelId} control projects into the viewer`).not.toBeNull();
  const canvas = await page.locator('canvas').first().boundingBox();
  expect(canvas, 'viewer canvas').not.toBeNull();
  const revision = await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().selectionRevision);
  await page.mouse.click(canvas!.x + projected!.x, canvas!.y + projected!.y);
  await expect.poll(
    () => page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().selectionRevision),
    { message: `${control.id}: ${modelId} ordinary GPU pick completes` },
  ).toBeGreaterThan(revision);
  return page.evaluate(selectionSnapshot);
}

function selectionSnapshot(): OrdinarySelection {
  const state = globalThis.__ifc_lite_viewer_store__.getState();
  return { selectedEntityId: state.selectedEntityId, selectedEntity: state.selectedEntity,
    selectedLandXmlSource: state.selectedLandXmlSource, selectedModelId: state.selectedModelId };
}
