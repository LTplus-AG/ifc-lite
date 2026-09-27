/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #5896: authored IFC in two models, through the mounted Lens runtime. */
import { test, expect } from '@playwright/test';
import { join } from 'node:path';

const STORE = '__ifc_lite_viewer_store__';

test('a shared IFC-class group colors authored walls in both models (#5896)', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?model=/samples/building-architecture.ifc');
  await page.waitForFunction((key) => {
    const api = (globalThis as Record<string, {
      getState(): { models: Map<string, { geometryResult?: { meshes: unknown[] } }> };
    }>)[key];
    const models = [...(api?.getState().models.values() ?? [])];
    return models.length === 1 && (models[0].geometryResult?.meshes.length ?? 0) > 0;
  }, STORE, { timeout: 180_000 });

  await page.evaluate((key) => {
    const api = (globalThis as unknown as Record<string, {
      getState(): {
        createLens(lens: object): { ok: boolean };
        setActiveLens(id: string): void;
        setLensPanelVisible(visible: boolean): void;
      };
    }>)[key];
    const state = api.getState();
    const result = state.createLens({
      id: 'authored-groups', name: 'Authored walls', rules: [{
        id: 'authored-walls', name: 'Walls in both models', enabled: true,
        criteria: { type: 'and', conditions: [] },
        groups: [{ combinator: 'AND', rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWall'] }] }],
        action: 'colorize', color: '#ff0000',
      }],
    });
    if (!result.ok) throw new Error('Could not save the authored Lens');
    state.setActiveLens('authored-groups');
    state.setLensPanelVisible(true);
  }, STORE);

  await page.waitForFunction((key) => {
    const api = (globalThis as unknown as Record<string, { getState(): {
      lensRuleEntityIds: Map<string, number[]>;
    } }>)[key];
    return (api.getState().lensRuleEntityIds.get('authored-walls')?.length ?? 0) > 0;
  }, STORE, { timeout: 60_000 });
  await page.locator('#file-input-add').setInputFiles(join(process.cwd(),
    'apps/viewer/public/samples/building-architecture-rev-b.ifc'));
  await page.waitForFunction((key) => {
    const api = (globalThis as Record<string, {
      getState(): { models: Map<string, { geometryResult?: { meshes: unknown[] } }> };
    }>)[key];
    const models = [...(api?.getState().models.values() ?? [])];
    return models.length === 2 && models.every((model) => (model.geometryResult?.meshes.length ?? 0) > 0);
  }, STORE, { timeout: 180_000 });

  await page.waitForFunction((key) => {
    const api = (globalThis as unknown as Record<string, { getState(): {
      models: Map<string, { idOffset: number; maxExpressId: number }>;
      lensRuleEntityIds: Map<string, number[]>;
      lensColorMap: Map<number, string>;
    } }>)[key];
    const state = api.getState();
    const ids = state.lensRuleEntityIds.get('authored-walls') ?? [];
    return [...state.models.values()].every(({ idOffset, maxExpressId }) =>
      ids.some((id) => id >= idOffset && id <= idOffset + maxExpressId
        && state.lensColorMap.get(id)?.toLowerCase() === '#ff0000'));
  }, STORE, { timeout: 60_000 });

  await expect(page.getByText('Authored walls', { exact: true }).first()).toBeVisible();
  const screenshot = testInfo.outputPath('lens-filter-groups-two-authored-models.png');
  await page.screenshot({ path: screenshot });
  await testInfo.attach('lens-filter-groups-two-authored-models.png', {
    path: screenshot, contentType: 'image/png',
  });
});
