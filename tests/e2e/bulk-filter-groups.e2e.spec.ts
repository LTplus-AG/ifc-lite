/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #5898: authored IFC, shared group editor, union result, and actual Bulk writes. */
import { test, expect } from '@playwright/test';

const STORE = '__ifc_lite_viewer_store__';

test('Bulk Query unions two filter groups before applying to an authored IFC (#5898)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // This test exercises Bulk editing as a returning user. A first-launch
  // privacy notice appears on a timer and can cover the dialog's Apply button.
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

  await page.getByRole('tab', { name: 'Author', exact: true }).click();
  await page.getByRole('button', { name: 'Enter edit mode' }).click();
  await expect(page.getByRole('button', { name: 'Exit edit mode' })).toBeVisible();
  await page.getByRole('button', { name: 'Bulk property editor' }).click();
  const dialog = page.getByRole('dialog', { name: 'Bulk Property Editor' });
  await expect(dialog.getByRole('combobox', { name: 'Target source' })).toContainText('Query');

  await dialog.getByRole('button', { name: 'Add rule' }).click();
  await page.getByRole('menuitem', { name: 'Name', exact: true }).click();
  await dialog.getByPlaceholder('text').fill('plumbing wall');
  await expect(dialog.getByText('2 entities matched')).toBeVisible();

  await dialog.getByRole('button', { name: 'Add group' }).click();
  await dialog.getByRole('button', { name: 'Add rule' }).click();
  await page.getByRole('menuitem', { name: 'Name', exact: true }).click();
  await dialog.getByPlaceholder('text').fill('house - outer wall - house right front');
  await expect(dialog.getByText('4 entities matched')).toBeVisible();

  await dialog.getByPlaceholder('e.g., Pset_WallCommon').fill('Pset_BulkGroupWitness');
  await dialog.getByPlaceholder('e.g., FireRating').fill('Code');
  await dialog.getByPlaceholder('Value').fill('TWO_GROUPS');
  await page.screenshot({ path: 'docs/architecture/evidence/bulk-filter-groups-5898/two-groups.png' });
  // Hosted SwiftShader may lose the drawing device after the IFC has loaded.
  // Its persistent toast can cover Apply even though Bulk editing itself is
  // healthy. Dismiss only that specific unrelated notice in software-GPU mode;
  // a DOM click avoids Radix treating the toast's pointerdown as a dialog exit.
  const dismissSoftwareGpuLoss = async () => {
    if (process.env.E2E_GPU_STRICT !== '0') return false;
    const notice = page.getByRole('alert').filter({ hasText: 'The graphics device was lost, so the 3D view has stopped drawing.' });
    if (!(await notice.isVisible())) return false;
    await notice.getByRole('button', { name: 'Dismiss notification' }).evaluate((button: HTMLButtonElement) => button.click());
    return true;
  };
  await dismissSoftwareGpuLoss();
  const apply = dialog.getByRole('button', { name: 'Apply to 4 entities' });
  try {
    await apply.click({ timeout: 10_000 });
  } catch (error) {
    if (!(await dismissSoftwareGpuLoss())) throw error;
    await apply.click();
  }
  await expect(dialog.getByText('Success', { exact: true })).toBeVisible();

  const edited = await page.evaluate((key) => {
    type Store = {
      models: Map<string, { id: string; ifcDataStore: {
        entities: { count: number; expressId: ArrayLike<number>; getName(id: number): string };
      } }>;
      getMutationView(id: string): { getPropertyValue(id: number, pset: string, prop: string): unknown } | undefined;
    };
    const state = (globalThis as Record<string, { getState(): Store }>)[key].getState();
    const model = [...state.models.values()][0];
    const view = state.getMutationView(model.id);
    return Array.from({ length: model.ifcDataStore.entities.count }, (_, i) => {
      const id = model.ifcDataStore.entities.expressId[i];
      return { name: model.ifcDataStore.entities.getName(id),
        value: view?.getPropertyValue(id, 'Pset_BulkGroupWitness', 'Code') ?? null };
    }).filter((row) => row.value !== null);
  }, STORE);
  expect(edited.map((row) => row.name).sort()).toEqual([
    'house - outer wall - house right front', 'house - outer wall - house right front',
    'plumbing wall', 'plumbing wall',
  ]);
  expect(edited.map((row) => row.value)).toEqual(['TWO_GROUPS', 'TWO_GROUPS', 'TWO_GROUPS', 'TWO_GROUPS']);
});
