/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #5882: real IFC federation, three active HUD reasons, light and dark screenshots. */
import { test, expect } from '@playwright/test';
import { join } from 'node:path';

const STORE = '__ifc_lite_viewer_store__';
const SECOND_MODEL = 'apps/viewer/public/samples/building-architecture-rev-b.ifc';

for (const scheme of ['light', 'dark'] as const) {
  test(`visibility chips show three reasons on two IFC models in ${scheme} mode (#5882)`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/?model=/samples/building-architecture.ifc');
    await page.waitForFunction((key) => {
      const api = (globalThis as Record<string, { getState(): { models: Map<string, { geometryResult?: { meshes: unknown[] } }> } }>)[key];
      const models = [...(api?.getState().models.values() ?? [])];
      return models.length === 1 && (models[0].geometryResult?.meshes.length ?? 0) > 0;
    }, STORE, { timeout: 180_000 });
    await page.locator('#file-input-add').setInputFiles(join(process.cwd(), SECOND_MODEL));
    await page.waitForFunction((key) => {
      const api = (globalThis as Record<string, { getState(): { models: Map<string, { geometryResult?: { meshes: unknown[] } }> } }>)[key];
      const models = [...(api?.getState().models.values() ?? [])];
      return models.length === 2 && models.every((model) => (model.geometryResult?.meshes.length ?? 0) > 0);
    }, STORE, { timeout: 180_000 });

    await page.evaluate(([key, theme]) => {
      const api = (globalThis as unknown as Record<string, {
        getState(): {
          models: Map<string, unknown>;
          typeVisibility: Record<string, boolean>;
          setTheme(value: string): void;
          setModelVisibility(id: string, visible: boolean): void;
          setLevelDisplayMode(mode: string): void;
        };
        setState(patch: object): void;
      }>)[key];
      const state = api.getState();
      state.setTheme(theme);
      state.setModelVisibility([...state.models.keys()][1], false);
      state.setLevelDisplayMode('exploded');
      api.setState({ typeVisibility: { ...state.typeVisibility, site: false } });
    }, [STORE, scheme] as const);

    const region = page.locator('[data-hud-region="top-left"]');
    const chips = region.locator('[data-visibility-reason]');
    await expect(chips).toHaveCount(3);
    await expect(chips.nth(0)).toHaveAttribute('data-visibility-reason', 'exploded');
    await expect(chips.nth(1)).toHaveAttribute('data-visibility-reason', 'modelHidden');
    await expect(chips.nth(2)).toHaveAttribute('data-visibility-reason', 'typeVisibility');
    await expect(chips.nth(1)).toContainText('Model hidden · 1 of 2 models');
    await expect(region.getByRole('button', { name: 'Reset everything' })).toBeVisible();
    const text = await region.innerText();
    expect(text).not.toContain('building-architecture');
    await testInfo.attach(`visibility-chips-two-models-${scheme}.png`, {
      body: await page.screenshot(), contentType: 'image/png',
    });
  });
}
