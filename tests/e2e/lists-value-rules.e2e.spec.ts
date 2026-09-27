/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6190: a Lists-only predicate authored in the shared Rules editor on a real
 * authored IFC (Archicad AC20-FZK-Haus). Created and saved through the Lists
 * panel, the page reloaded, the saved list reopened in the editor, then run on
 * one model and again after a second model is added.
 */

import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const STORE = '__ifc_lite_viewer_store__';
const FIXTURE = 'tests/models/ara3d/AC20-FZK-Haus.ifc';
const LIST = 'Ground floor elements';
/** FZK-Haus's two storeys; the rule keeps what the ground floor directly contains. */
const KEPT = 'Erdgeschoss';
const EXCLUDED = 'Dachgeschoss';

type Store = {
  entityIndex: { byType: Map<string, number[]> };
  entities: { getName(id: number): string };
  spatialHierarchy: { elementToStorey: Map<number, number> };
};
type Api = { getState(): {
  models: Map<string, { geometryResult?: { meshes: unknown[] }; ifcDataStore: Store | null }>;
  /** A single loaded model may keep its store on this legacy slot only. */
  ifcDataStore: Store | null;
  loading: boolean;
  listDefinitions: Array<{ name: string; groups: unknown; unreadableConditions?: unknown[] }>;
  listResult: { rows: Array<{ modelId: string; entityId: number }> } | null;
  setListPanelVisible(visible: boolean): void;
} };

async function waitForModels(page: Page, count: number) {
  await page.waitForFunction(([key, n]) => {
    const api = (globalThis as unknown as Record<string, Api>)[key as string];
    const models = [...(api?.getState().models.values() ?? [])];
    return !!api && !api.getState().loading && models.length === n
      && models.every((model) => (model.geometryResult?.meshes.length ?? 0) > 0);
  }, [STORE, count] as const, { timeout: 180_000 });
}

async function openFirstModel(page: Page) {
  await page.goto('/');
  await page.waitForFunction((key) => !!(globalThis as Record<string, unknown>)[key], STORE, { timeout: 120_000 });
  await page.locator('#file-input-open').setInputFiles(join(process.cwd(), FIXTURE));
  await waitForModels(page, 1);
  await page.evaluate((key) => (globalThis as unknown as Record<string, Api>)[key].getState().setListPanelVisible(true), STORE);
}

async function snap(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(name);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

async function runAndReadRows(page: Page) {
  await page.getByRole('button', { name: `Run list ${LIST}` }).click();
  await page.waitForFunction((key) => ((globalThis as unknown as Record<string, Api>)[key].getState().listResult?.rows.length ?? 0) > 0,
    STORE, { timeout: 60_000 });
  return page.evaluate((key) => (globalThis as unknown as Record<string, Api>)[key].getState().listResult!.rows
    .map(({ modelId, entityId }) => ({ modelId, entityId })), STORE);
}

test('a saved exact-Container List value rule is created, reopened and run on one and two authored models (#6190)', async ({ page }, testInfo) => {
  test.skip(!existsSync(join(process.cwd(), FIXTURE)), `${FIXTURE} missing — run \`pnpm fixtures\``);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await openFirstModel(page);
  const storeys = await page.evaluate((key) => {
    const state = (globalThis as unknown as Record<string, Api>)[key].getState();
    const store = [...state.models.values()][0]?.ifcDataStore ?? state.ifcDataStore;
    if (!store) throw new Error('no parsed store after load');
    return (store.entityIndex.byType.get('IFCBUILDINGSTOREY') ?? []).map((id) => store.entities.getName(id)).sort();
  }, STORE);
  expect(storeys, 'the authored file has both storeys').toEqual([EXCLUDED, KEPT]);

  // Create: name, a Name column, and a List value rule on the exact Container level.
  await page.getByRole('button', { name: 'New List', exact: true }).first().click();
  await page.getByPlaceholder('List name…').fill(LIST);
  await page.getByRole('button', { name: 'Name', exact: true }).first().click();
  await page.getByRole('button', { name: 'Add rule' }).click();
  await page.getByRole('menuitem', { name: 'List value', exact: true }).click();
  await expect(page.getByLabel('List value source')).toHaveValue('spatial');
  await expect(page.getByLabel('Spatial level')).toHaveValue('Building');
  await page.getByLabel('Spatial level').selectOption('Container');
  await page.getByPlaceholder('Container name').fill(KEPT);
  await snap(page, testInfo, 'lists-value-rule-authored.png');
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  const saved = await page.evaluate((key) => (globalThis as unknown as Record<string, Api>)[key].getState().listDefinitions, STORE);
  expect(saved.find((list) => list.name === LIST)?.groups).toEqual([{ combinator: 'AND', rules: [
    { kind: 'listCondition', source: 'spatial', propertyName: 'Container', operator: 'equals', value: KEPT },
  ] }]);

  // Reopen after a reload: the list comes back from localStorage, not from memory.
  await page.reload();
  await openFirstModel(page);
  await page.getByRole('button', { name: `Edit list ${LIST}` }).click();
  await expect(page.getByLabel('List value source')).toHaveValue('spatial');
  await expect(page.getByLabel('Spatial level')).toHaveValue('Container');
  await expect(page.getByPlaceholder('Container name')).toHaveValue(KEPT);
  await page.getByLabel('List value source').scrollIntoViewIfNeeded();
  await snap(page, testInfo, 'lists-value-rule-reopened.png');
  await page.getByRole('button', { name: 'Cancel', exact: true }).first().click();

  // One model.
  const one = await runAndReadRows(page);
  const [firstId] = new Set(one.map((row) => row.modelId));
  expect(new Set(one.map((row) => row.modelId)).size).toBe(1);
  // Every kept element sits on the ground floor, and upper-floor elements exist but were dropped.
  const sides = await page.evaluate(([key, ids, kept, excluded]) => {
    const state = (globalThis as unknown as Record<string, Api>)[key as string].getState();
    const store = [...state.models.values()][0]?.ifcDataStore ?? state.ifcDataStore;
    if (!store) throw new Error('no parsed store');
    const storeyOf = (id: number) => store.entities.getName(store.spatialHierarchy.elementToStorey.get(id) ?? 0);
    return {
      keptOnGround: (ids as number[]).filter((id) => storeyOf(id) === kept).length,
      upper: [...store.spatialHierarchy.elementToStorey.keys()].filter((id) => storeyOf(id) === excluded).length,
      upperKept: (ids as number[]).filter((id) => storeyOf(id) === excluded).length,
    };
  }, [STORE, one.map((row) => row.entityId), KEPT, EXCLUDED] as const);
  expect(sides.keptOnGround, 'every row is on the ground floor').toBe(one.length);
  expect(sides.upper, 'the upper floor has elements to exclude').toBeGreaterThan(0);
  expect(sides.upperKept).toBe(0);
  await snap(page, testInfo, 'lists-value-rule-one-model.png');

  // Two models: a second copy of the authored file.
  const copy = join(tmpdir(), 'AC20-FZK-Haus copy.ifc');
  copyFileSync(join(process.cwd(), FIXTURE), copy);
  await page.locator('#file-input-add').setInputFiles(copy);
  await waitForModels(page, 2);
  const alignmentNotice = page.locator('[role="alert"] button').first();
  if (await alignmentNotice.isVisible()) await alignmentNotice.click();
  await page.getByRole('button', { name: 'Back to Lists' }).first().click();
  const two = await runAndReadRows(page);
  const perModel = new Map<string, number>();
  for (const row of two) perModel.set(row.modelId, (perModel.get(row.modelId) ?? 0) + 1);
  expect(perModel.size, 'rows come from both models').toBe(2);
  expect([...perModel.values()], 'each copy keeps the same rows as the single model').toEqual([one.length, one.length]);
  expect(perModel.get(firstId)).toBe(one.length);
  await snap(page, testInfo, 'lists-value-rule-two-models.png');
  testInfo.annotations.push({ type: 'rows', description: `one=${one.length}; excludedUpper=${sides.upper}; two=${JSON.stringify([...perModel.values()])}` });
});
