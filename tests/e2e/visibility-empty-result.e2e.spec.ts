/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #5879: authored SketchUp IFC, one and two models, conflicting storey × roof filter. */
import { test, expect } from '@playwright/test';
import { join } from 'node:path';

const STORE = '__ifc_lite_viewer_store__';
const SECOND_MODEL = 'apps/viewer/public/samples/building-architecture-rev-b.ifc';

for (const modelCount of [1, 2]) {
  test(`empty-result notice explains and resets conflicting IFC filters on ${modelCount} model(s) (#5879)`,
    async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto('/?model=/samples/building-architecture.ifc');
      await page.waitForFunction((key) => {
        const api = (globalThis as Record<string, { getState(): {
          models: Map<string, { geometryResult?: { meshes: unknown[] } }>;
        } }>)[key];
        const models = [...(api?.getState().models.values() ?? [])];
        return models.length === 1 && (models[0].geometryResult?.meshes.length ?? 0) > 0;
      }, STORE, { timeout: 180_000 });
      if (modelCount === 2) {
        await page.locator('#file-input-add').setInputFiles(join(process.cwd(), SECOND_MODEL));
        await page.waitForFunction((key) => {
          const api = (globalThis as Record<string, { getState(): {
            models: Map<string, { geometryResult?: { meshes: unknown[] } }>;
          } }>)[key];
          const models = [...(api?.getState().models.values() ?? [])];
          return models.length === 2 && models.every((model) => (model.geometryResult?.meshes.length ?? 0) > 0);
        }, STORE, { timeout: 180_000 });
      }

      await page.evaluate((key) => {
        interface Model {
          idOffset: number;
          ifcDataStore: { spatialHierarchy: { byStorey: Map<number, number[]> };
            entities: { getTypeName(id: number): string } };
        }
        const api = (globalThis as unknown as Record<string, { getState(): {
          models: Map<string, Model>;
          setStoreysSelection(ids: number[]): void;
          setClassFilter(ids: number[], label: string): void;
        } }>)[key];
        const state = api.getState();
        const models = [...state.models.values()];
        const first = models[0];
        const storeyId = first.ifcDataStore.spatialHierarchy.byStorey.keys().next().value;
        if (storeyId === undefined) throw new Error('authored IFC has no storey');
        const roofIds = models.map((model) => {
          if (model.ifcDataStore.entities.getTypeName(382) !== 'IfcRoof') {
            throw new Error('authored IFC roof #382 changed');
          }
          return model.idOffset + 382;
        });
        if (first.ifcDataStore.spatialHierarchy.byStorey.get(storeyId)?.includes(382)) {
          throw new Error('authored roof unexpectedly belongs to the selected storey');
        }
        state.setStoreysSelection([storeyId]);
        state.setClassFilter(roofIds, 'IfcRoof');
      }, STORE);

      const notice = page.locator('[data-hud-region="top-center"]');
      await expect(notice.getByText('Nothing is visible: the active filters exclude every element.')).toBeVisible();
      await expect(notice).toContainText('Storey filter or Solo view');
      await expect(notice).toContainText('Class filter');
      await testInfo.attach(`empty-result-${modelCount}-models.png`, {
        body: await page.screenshot(), contentType: 'image/png',
      });

      await notice.getByRole('button', { name: 'Reset everything' }).click();
      await expect(notice.getByText('Nothing is visible: the active filters exclude every element.')).toHaveCount(0);
      const restored = await page.evaluate((key) => {
        const api = (globalThis as unknown as Record<string, { getState(): {
          classFilter: unknown;
          selectedStoreys: Set<number>;
          models: Map<string, { visible: boolean; geometryResult?: { meshes: unknown[] } }>;
        } }>)[key];
        const state = api.getState();
        return state.classFilter === null && state.selectedStoreys.size === 0
          && [...state.models.values()].some((model) => model.visible && (model.geometryResult?.meshes.length ?? 0) > 0);
      }, STORE);
      expect(restored).toBe(true);
    });
}
