/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Charter #6643: actual worker, canonical IFC loader, renderer, selection and grouped authoring undo. */
import { test, expect } from '@playwright/test';
import type { ViewerState } from '../../apps/viewer/src/store';
import { ViewerBenchmarkPage } from '../benchmark/viewer-benchmark-page';

const STORE = '__ifc_lite_viewer_store__';
const BASE = 'https://example.org/ifc-lite/pilot/';

test('linked records pilot selects revision-scoped geometry and projects with provenance in one undo (#6643)', async ({ page }, info) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const viewer = new ViewerBenchmarkPage(page); await viewer.setup();
  await page.waitForFunction(key => !!(globalThis as unknown as Record<string, { getState(): ViewerState }>)[key], STORE);
  await page.getByRole('tab', { name: 'Analyze', exact: true }).click();
  await page.getByRole('button', { name: 'Browse panels', exact: true }).click();
  await page.getByRole('menu').locator('[data-panel-id="semantic"]').click();
  const panel = page.getByRole('region', { name: 'Linked records', exact: true });
  await panel.getByRole('button', { name: 'Load pilot models and records', exact: true }).click();
  await page.waitForFunction(key => {
    const state = (globalThis as unknown as Record<string, { getState(): ViewerState }>)[key].getState();
    return state.models.size === 2 && !state.loading && !state.geometryStreamingActive &&
      [...state.models.values()].every(model => model.ifcDataStore && model.geometryResult?.meshes.length === 3);
  }, STORE, { timeout: 180000 });
  await expect(panel.getByRole('button', { name: 'Select Installed door 1', exact: true })).toBeVisible();
  const findings = panel.locator('li').filter({ hasText: `${BASE}incomplete-passport` });
  await expect(findings).toHaveCount(4); // JSON Schema and SHACL each report the two missing fields.

  await panel.getByRole('button', { name: 'Select Installed door 1', exact: true }).click();
  const selection = await page.evaluate(key => {
    const state = (globalThis as unknown as Record<string, { getState(): ViewerState }>)[key].getState();
    const ref = state.selectedEntity;
    if (!ref) throw new Error('Linked record did not select a property source');
    const numeric = [...state.selectedEntityIds];
    return { ref, numeric, resolved: numeric.map(id => state.resolveGlobalIdFromModels(id)),
      GlobalId: state.models.get(ref.modelId)?.ifcDataStore?.entities.getGlobalId(ref.expressId) };
  }, STORE);
  expect(selection.numeric).toHaveLength(1);
  expect(selection.resolved[0]?.modelId).toBe(selection.ref.modelId);
  expect(selection.resolved[0]?.expressId).toBe(selection.ref.expressId);
  expect(selection.GlobalId).toMatch(/^[0-3][0-9A-Za-z_$]{21}$/);
  const retainedSelection = () => page.evaluate(key => {
    const state = (globalThis as unknown as Record<string, { getState(): ViewerState }>)[key].getState();
    return { ref: state.selectedEntity, ids: [...state.selectedEntityIds], models: state.models.size };
  }, STORE);
  const expectedSelection = { ref: selection.ref, ids: selection.numeric, models: 2 };
  await page.getByRole('button', { name: 'Sidebar options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Float current panel', exact: true }).click();
  await expect(panel.locator('tbody tr')).toHaveCount(13);
  await expect(panel.locator('li').filter({ hasText: `${BASE}incomplete-passport` })).toHaveCount(4);
  expect(await retainedSelection()).toEqual(expectedSelection);
  await page.getByRole('button', { name: 'Dock into sidebar (reserves space beside the model)', exact: true }).click();
  await expect(panel).toBeVisible();
  expect(await retainedSelection()).toEqual(expectedSelection);

  // Use the same supported window.open portal exercised by document pop-out tests.
  await page.evaluate(() => Object.defineProperty(window, 'documentPictureInPicture', { value: undefined, configurable: true }));
  await page.getByRole('button', { name: 'Sidebar options', exact: true }).click();
  const childPromise = page.context().waitForEvent('page');
  await page.getByRole('menuitem', { name: 'Pop out to another screen', exact: true }).click();
  const child = await childPromise;
  await child.setViewportSize({ width: 1100, height: 1800 });
  const childPanel = child.getByRole('region', { name: 'Linked records', exact: true });
  await expect(childPanel).toBeVisible();
  await expect(childPanel.locator('tbody tr')).toHaveCount(13);
  await expect(childPanel.locator('li').filter({ hasText: `${BASE}incomplete-passport` })).toHaveCount(4);
  expect(await retainedSelection()).toEqual(expectedSelection);
  const popoutScreenshot = info.outputPath('semantic-linked-records-popout.png');
  await child.screenshot({ path: popoutScreenshot, fullPage: true });
  await info.attach('linked records retained in actual pop-out window', { path: popoutScreenshot, contentType: 'image/png' });
  await child.close();
  await expect(panel).toBeVisible();
  await expect(panel.locator('tbody tr')).toHaveCount(13);
  expect(await retainedSelection()).toEqual(expectedSelection);
  await panel.getByRole('checkbox', { name: 'Records related to current IFC selection' }).check();
  await expect(panel.getByRole('button', { name: 'Select Inspection evidence', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Select Incomplete passport: missing product and granularity', exact: true })).toHaveCount(0);

  // The actual Author/Model action creates the editable workspace; viewing alone cannot mutate IFC.
  await page.getByRole('tab', { name: 'Author', exact: true }).click();
  await page.getByRole('tabpanel', { name: 'Author', exact: true }).getByRole('button', { name: 'Model', exact: true }).click();
  await page.getByRole('tab', { name: 'Analyze', exact: true }).click();
  await page.getByRole('button', { name: 'Browse panels', exact: true }).click();
  await page.getByRole('menu').locator('[data-panel-id="semantic"]').click();
  await panel.getByRole('button', { name: 'Select Installed door 1', exact: true }).click();
  await panel.getByRole('button', { name: 'Preview projection', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Apply reviewed projection', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Apply reviewed projection', exact: true }).click();
  const projected = () => page.evaluate(key => {
    const state = (globalThis as unknown as Record<string, { getState(): ViewerState }>)[key].getState();
    const ref = state.selectedEntity;
    if (!ref) throw new Error('Projection lost property selection');
    const view = state.getMutationView(ref.modelId);
    return { FireRating: view?.getPropertyValue(ref.expressId, 'Pset_DoorCommon', 'FireRating') ?? null,
      Source: view?.getPropertyValue(ref.expressId, 'Pset_SemanticProjection', 'Source') ?? null,
      ProductId: view?.getPropertyValue(ref.expressId, 'Pset_SemanticProjection', 'ProductId') ?? null,
      GlobalId: view?.getPropertyValue(ref.expressId, 'Pset_SemanticProjection', 'GlobalId') ?? null,
      ModelRevision: view?.getPropertyValue(ref.expressId, 'Pset_SemanticProjection', 'ModelRevision') ?? null };
  }, STORE);
  await expect.poll(projected).toEqual({ FireRating: 'EI30', Source: BASE + 'original-demo', ProductId: BASE + 'batch',
    GlobalId: selection.GlobalId, ModelRevision: BASE + 'revision/1' });
  await page.evaluate(key => (globalThis as unknown as Record<string, { getState(): ViewerState }>)[key].getState().cameraCallbacks.frameSelection?.(), STORE);
  await page.mouse.move(1100, 500);
  const screenshot = info.outputPath('semantic-linked-records-pilot.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await info.attach('linked records real viewer and provenance', { path: screenshot, contentType: 'image/png' });
  await page.keyboard.press('Control+z');
  await expect.poll(projected).toEqual({ FireRating: null, Source: null, ProductId: null, GlobalId: null, ModelRevision: null });
  // Undo keeps the canonical geometry and both model revisions intact.
  expect(await page.evaluate(key => [...(globalThis as unknown as Record<string, { getState(): ViewerState }>)[key].getState().models.values()].map(model => model.geometryResult?.meshes.length), STORE)).toEqual([3, 3]);
});
