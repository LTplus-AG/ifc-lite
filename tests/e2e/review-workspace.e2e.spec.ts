/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, expect, type Page } from '@playwright/test';
import { join } from 'node:path';
import { ViewerBenchmarkPage } from '../benchmark/viewer-benchmark-page';

// P18 (#6922): a native duplicate scan produces clash findings, a BCF topic names the first pair, and the Review
// workspace joins them into one card (models.size 1). Adding a second revision that reuses the same GlobalIds
// (models.size 2) makes the topic's model-less elements ambiguous: it must stop merging, never guess.
const sample = (name: string) => join(process.cwd(), 'apps/viewer/public/samples', name);

type Store = { getState(): Record<string, unknown> & { models: Map<string, unknown> } };
const store = '__ifc_lite_viewer_store__';

async function modelsReady(page: Page, count: number): Promise<void> {
  // Panels only: WSL has no WebGPU, so geometry streaming is not awaited; the parsed data store is what review reads.
  await expect.poll(() => page.evaluate(({ key }) => {
    const state = (globalThis as unknown as Record<string, Store>)[key]?.getState();
    const models = [...(state?.models.values() ?? [])] as Array<{ ifcDataStore?: { entityCount: number } | null }>;
    return models.length > 0 && models.every(model => (model.ifcDataStore?.entityCount ?? 0) > 10) ? models.length : 0;
  }, { key: store }), { timeout: 120_000 }).toBe(count);
}

test('review workspace joins clash findings and a BCF topic into one card with original evidence one click away', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1200 });
  const viewer = new ViewerBenchmarkPage(page);
  await viewer.setup();
  await viewer.loadFile(sample('building-architecture.ifc'));
  await modelsReady(page, 1);

  // A clash between two real walls of the loaded model, and a BCF topic selecting the same pair. The clash result is
  // set through the store (a single revision has no duplicates to scan); the walls and GlobalIds are the model's own.
  await page.evaluate(({ key }) => {
    type Entities = { getGlobalId(id: number): string; getName(id: number): string };
    type Model = { id: string; ifcDataStore: { entities: Entities; entityIndex: { byType: Map<string, number[]> } } };
    const state = (globalThis as unknown as Record<string, { getState(): { models: Map<string, Model>; setBcfProject(p: unknown): void };
      setState(patch: unknown): void }>)[key];
    const model = [...state.getState().models.values()][0];
    const [wallA, wallB] = model.ifcDataStore.entityIndex.byType.get('IFCWALLSTANDARDCASE') ?? model.ifcDataStore.entityIndex.byType.get('IFCWALL') ?? [];
    const ref = (id: number) => ({ key: model.ifcDataStore.entities.getGlobalId(id), ref: id, model: model.id, tag: 'IfcWall', name: model.ifcDataStore.entities.getName(id) });
    const clash = { id: 'e2e-clash-1', a: ref(wallA), b: ref(wallB), rule: 'walls', status: 'hard', distance: -0.02, distanceKind: 'mesh', severity: 'major',
      point: [0, 0, 0], bounds: { min: [0, 0, 0], max: [1, 1, 1] } };
    const result = { clashes: [clash], summary: { total: 1, byRule: { walls: 1 }, byTypePair: {}, bySeverity: { critical: 0, major: 1, minor: 0, info: 0 } },
      rulesRun: [{ id: 'walls', name: 'Wall vs wall', a: 'IfcWall', b: 'IfcWall', mode: 'hard' }], settings: { tolerance: 0.002, excludeVoidsAndHosts: true } };
    state.setState({ clashResult: result, clashRawResult: result });
    state.getState().setBcfProject({ version: '2.1', name: 'Coordination', topics: new Map([['topic-1', {
      guid: 'topic-1', title: 'Walls overlap', creationDate: '2026-01-01T00:00:00Z', creationAuthor: 'e2e@example.com', comments: [], topicStatus: 'Open',
      viewpoints: [{ guid: 'vp-1', components: { selection: [{ ifcGuid: clash.a.key }, { ifcGuid: clash.b.key }] } }] }]]) });
  }, { key: store });

  await page.evaluate(({ key }) => (globalThis as unknown as Record<string, { getState(): { openPanelInHome(panel: string): void } }>)[key].getState().openPanelInHome('review'), { key: store });
  const review = page.getByRole('region', { name: 'Review results', exact: true });
  await expect(review).toBeVisible();
  await expect(review.locator('[data-review-card]').first()).toBeVisible();
  await expect(review).toContainText('BCF topics');
  const sources = await review.locator('[data-review-card]').first().innerText();
  expect(sources).toContain('Clash');
  expect(sources).toContain('BCF topic');
  await page.screenshot({ path: testInfo.outputPath('review-1-cards.png') });

  const first = review.locator('[data-review-card]').first();
  await first.getByRole('button', { name: /^Show findings of/ }).click();
  await expect(first.getByText('Historical', { exact: true })).toHaveCount(0);
  await first.getByLabel('Status').selectOption('in-progress');
  await first.getByLabel('Comment').fill('Waiting for the architect');
  await first.getByRole('button', { name: 'Save decision' }).click();
  await expect(first.getByText('In progress').first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('review-2-expanded.png') });

  // Original evidence: the clash opens in the Clash panel with that clash selected.
  await first.locator('[data-finding-source="clash"]').getByRole('button', { name: /^Open the original Clash evidence/ }).click();
  await expect.poll(() => page.evaluate(({ key }) => (globalThis as unknown as Record<string, Store>)[key].getState().sidebarActivePanel, { key: store })).toBe('clash');
  await page.screenshot({ path: testInfo.outputPath('review-3-original.png') });

  // The decision survives a reload of the saved libraries.
  await page.evaluate(({ key }) => (globalThis as unknown as Record<string, { getState(): { openPanelInHome(panel: string): void } }>)[key].getState().openPanelInHome('review'), { key: store });
  await expect(page.getByRole('region', { name: 'Review results' }).locator('[data-review-card]').first()).toContainText('In progress');

  // Federation: the second revision reuses the first's GlobalIds, so the BCF topic can no longer name one model.
  await page.locator('#file-input-add').setInputFiles(sample('building-architecture-rev-b.ifc'));
  await modelsReady(page, 2);
  const panel = page.getByRole('region', { name: 'Review results' });
  await page.getByRole('button', { name: 'Refresh from the analyses' }).click();
  await expect(panel.locator('[data-review-card][data-card-identity="unvalidated"]').filter({ hasText: 'BCF topic' }).first()).toBeVisible();
  await expect(panel).toContainText('could not be matched to exactly one loaded model and');
  await page.screenshot({ path: testInfo.outputPath('review-4-federation-ambiguous.png') });
});

