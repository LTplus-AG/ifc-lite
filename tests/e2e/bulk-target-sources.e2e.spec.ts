/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #5890: an authored IFC federation, the actual Bulk dialog, and workspace Undo. */
import { test, expect } from '@playwright/test';
import { join } from 'node:path';

const STORE = '__ifc_lite_viewer_store__';
const OTHER_MODEL = 'apps/viewer/public/samples/building-architecture-rev-b.ifc';

test('Bulk Selection edits three walls across two IFC models in one undo step (#5890)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    window.localStorage.setItem('ifclite.extensions.privacy-disclosure.v2', 'e2e acknowledged');
  });
  await page.goto('/?model=/samples/building-architecture.ifc');
  await page.waitForFunction((key) => {
    const api = (globalThis as Record<string, { getState(): {
      models: Map<string, { geometryResult?: { meshes: unknown[] } }>;
      loading: boolean;
    } }>)[key];
    const models = [...(api?.getState().models.values() ?? [])];
    return !api.getState().loading && models.length === 1 &&
      (models[0].geometryResult?.meshes.length ?? 0) > 0;
  }, STORE, { timeout: 180_000 });
  await page.locator('#file-input-add').setInputFiles(join(process.cwd(), OTHER_MODEL));
  await page.waitForFunction((key) => {
    const api = (globalThis as Record<string, { getState(): {
      models: Map<string, { geometryResult?: { meshes: unknown[] } }>;
      loading: boolean;
    } }>)[key];
    const models = [...(api?.getState().models.values() ?? [])];
    return !api.getState().loading && models.length === 2 && models.every((model) =>
      (model.geometryResult?.meshes.length ?? 0) > 0);
  }, STORE, { timeout: 180_000 });

  // The second authored file can emit a georeference warning that overlays
  // the dialog footer. It does not affect local IFC property editing.
  const alignmentNotice = page.locator('[role="alert"] button').first();
  if (await alignmentNotice.isVisible()) await alignmentNotice.click();

  // Bulk authoring is available through the viewer's Model workspace.
  await page.getByRole('tab', { name: 'Author', exact: true }).click();
  const modelWorkspace = page.getByRole('tabpanel', { name: 'Author' }).getByRole('button', { name: 'Model', exact: true });
  await modelWorkspace.click();
  await expect(modelWorkspace).toHaveAttribute('aria-pressed', 'true');

  const refs = await page.evaluate((key) => {
    type Model = { id: string; ifcDataStore: { entityIndex: { byType: Map<string, number[]> } } };
    type State = { models: Map<string, Model>; toGlobalId(modelId: string, expressId: number): number;
      setSelectedEntityIds(ids: number[]): void };
    const state = (globalThis as Record<string, { getState(): State }>)[key].getState();
    const models = [...state.models.values()];
    const wallIds = models.map((model) => model.ifcDataStore.entityIndex.byType.get('IFCWALL') ?? []);
    if (wallIds[0].length < 2 || wallIds[1].length < 3) throw new Error('Authored IFC fixture needs three walls per model');
    const targets = [{ modelId: models[0].id, expressId: wallIds[0][0] },
      { modelId: models[1].id, expressId: wallIds[1][0] },
      { modelId: models[1].id, expressId: wallIds[1][1] }];
    state.setSelectedEntityIds(targets.map(({ modelId, expressId }) => state.toGlobalId(modelId, expressId)));
    return { targets, untouched: { modelId: models[1].id, expressId: wallIds[1][2] } };
  }, STORE);

  await page.getByRole('tab', { name: 'Author', exact: true }).click();
  await page.getByRole('button', { name: 'Bulk property editor' }).click();
  const dialog = page.getByRole('dialog', { name: 'Bulk Property Editor' });
  await expect(dialog.getByRole('combobox', { name: 'Target source' })).toContainText('Selection');
  await expect(dialog.getByText('3 entities matched')).toBeVisible();
  await dialog.getByPlaceholder('e.g., Pset_WallCommon').fill('Pset_BulkTargetWitness');
  await dialog.getByPlaceholder('e.g., FireRating').fill('Code');
  await dialog.getByPlaceholder('Value').fill('ONLY_THREE');
  await page.screenshot({ path: 'docs/architecture/evidence/bulk-target-sources-5890/selection-two-models.png' });
  await dialog.getByRole('button', { name: 'Apply to 3 entities' }).click();
  await expect(dialog.getByText('Success', { exact: true })).toBeVisible();

  const values = () => page.evaluate(([key, refs]) => {
    const state = (globalThis as Record<string, { getState(): {
      getMutationView(id: string): { getPropertyValue(id: number, pset: string, prop: string): unknown } | undefined;
    } }>)[key].getState();
    return [...refs.targets, refs.untouched].map(({ modelId, expressId }) =>
      state.getMutationView(modelId)?.getPropertyValue(expressId, 'Pset_BulkTargetWitness', 'Code') ?? null);
  }, [STORE, refs] as const);
  expect(await values()).toEqual(['ONLY_THREE', 'ONLY_THREE', 'ONLY_THREE', null]);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await expect.poll(values).toEqual([null, null, null, null]);
});
