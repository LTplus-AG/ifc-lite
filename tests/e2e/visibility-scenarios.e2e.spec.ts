/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5895: browser guards for #346, #1480 and #2060 with authored IFC models.
 * AC20-FZK-Haus (Archicad) has two storeys, spaces, annotations and openings;
 * ISSUE_844 has rendered IfcGeographicElement terrain. The bundled Building-
 * Architecture sample has none of the latter three classes, so it cannot
 * witness these regressions. Both files are SHA-verified by the fixture fetcher.
 */

import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ViewerState } from '../../apps/viewer/src/store';
import type { RenderVisibilitySnapshot, SceneOwnerSnapshot } from '../../apps/viewer/src/lib/viewport-debug-hooks';

declare global {
  var __ifc_lite_viewer_store__: { getState(): ViewerState };
  var __ifc_lite_render_visibility__: () => RenderVisibilitySnapshot;
  var __ifc_lite_annotation_line_vertices__: () => number;
  var __ifc_lite_visibility_reasons__: () => Array<{ id: string; resetPolicy: 'cleared' | 'kept' }>;
  var __ifc_lite_scene_owner__: (globalId: number) => SceneOwnerSnapshot;
}

const ARCH = 'tests/models/ara3d/AC20-FZK-Haus.ifc';
const TERRAIN = 'tests/models/issues/844_terrain_and_alignment.ifc';

test.skip(![ARCH, TERRAIN].every((file) => existsSync(join(process.cwd(), file))),
  'Authored IFC fixtures missing — run `pnpm fixtures`');

async function openViewer(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => !!globalThis.__ifc_lite_viewer_store__);
}

async function load(page: Page, file: string, count: number): Promise<void> {
  await page.locator(count === 1 ? '#file-input-open' : '#file-input-add').setInputFiles(join(process.cwd(), file));
  await page.waitForFunction((expected) => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    return !!globalThis.__ifc_lite_scene_owner__ && !!globalThis.__ifc_lite_render_visibility__
      && !!globalThis.__ifc_lite_annotation_line_vertices__
      && !!globalThis.__ifc_lite_visibility_reasons__
      && state.models.size === expected && !state.loading && !state.geometryStreamingActive
      && [...state.models.values()].every((model) =>
        !!model.ifcDataStore?.entityIndex && (model.geometryResult?.meshes.length ?? 0) > 0);
  }, count, { timeout: 180_000 });
}

async function modelIds(page: Page, index: number, type: string): Promise<number[]> {
  return page.evaluate(({ index, type }) => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const model = [...state.models.values()][index];
    if (!model?.ifcDataStore) throw new Error(`Model ${index} has no IFC metadata`);
    return (model.ifcDataStore.entityIndex.byType.get(type) ?? []).map((id) => state.toGlobalId(model.id, id));
  }, { index, type });
}

async function sceneOwners(page: Page, ids: number[]): Promise<number[]> {
  return page.evaluate((ids) => ids.filter((id) => {
    const owner = globalThis.__ifc_lite_scene_owner__(id);
    return owner.instance || (owner.flat?.length ?? 0) > 0;
  }), ids);
}

async function setTypeVisibility(page: Page, type: 'spaces' | 'openings' | 'site', visible: boolean): Promise<void> {
  await page.evaluate(({ type, visible }) => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    if (state.typeVisibility[type] !== visible) state.toggleTypeVisibility(type);
  }, { type, visible });
}

async function drawingTypeCounts(page: Page, index: number): Promise<Record<string, number>> {
  return page.evaluate((index) => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const model = [...state.models.values()][index];
    const drawing = state.drawing2D;
    if (!model?.ifcDataStore || !drawing) return {};
    const counts: Record<string, number> = {};
    for (const part of [...drawing.lines, ...drawing.cutPolygons, ...drawing.projectionPolygons]) {
      const localId = state.resolveGlobalIdInModel(model.id, part.entityId)?.expressId;
      const type = localId === undefined ? undefined : model.ifcDataStore.entities.getTypeName(localId);
      if (type) counts[type] = (counts[type] ?? 0) + 1;
    }
    return counts;
  }, index);
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(name);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

for (const federated of [false, true]) {
  test(`#5895 visibility combinations with ${federated ? 'two authored IFC models' : 'one authored IFC model'}`, async ({ page }, testInfo) => {
    await openViewer(page);
    await load(page, ARCH, 1);
    if (federated) await load(page, TERRAIN, 2);
    await page.waitForTimeout(800); // allow the first rendered frame to settle
    await attachScreenshot(page, testInfo, `visibility-${federated ? 'two' : 'one'}-models-loaded.png`);

    // #346: the first of Archicad's two storeys contains six spaces; the
    // second contains one. Assert the exact isolation set sent to the renderer,
    // not just the store's selectedStoreys field.
    await setTypeVisibility(page, 'spaces', true);
    const spaces = await modelIds(page, 0, 'IFCSPACE');
    expect(spaces.length).toBeGreaterThan(1);
    const { selected, other, storey } = await page.evaluate(() => {
      const state = globalThis.__ifc_lite_viewer_store__.getState();
      const model = [...state.models.values()][0];
      const hierarchy = model.ifcDataStore!.spatialHierarchy!;
      const storeyIds = [...hierarchy.byStorey.keys()];
      const spaceIds = model.ifcDataStore!.entityIndex.byType.get('IFCSPACE') ?? [];
      if (storeyIds.length < 2) throw new Error('The authored model needs two storeys');
      return {
        storey: state.toGlobalId(model.id, storeyIds[0]!),
        selected: spaceIds.filter((id) => hierarchy.elementToStorey.get(id) === storeyIds[0]).map((id) => state.toGlobalId(model.id, id)),
        other: spaceIds.filter((id) => hierarchy.elementToStorey.get(id) !== storeyIds[0]).map((id) => state.toGlobalId(model.id, id)),
      };
    });
    expect(selected.length).toBeGreaterThan(0);
    expect(other.length).toBeGreaterThan(0);
    await page.evaluate((id) => globalThis.__ifc_lite_viewer_store__.getState().setStoreySelection(id), storey);
    await expect.poll(() => page.evaluate(() => globalThis.__ifc_lite_render_visibility__().isolatedIds)).not.toBeNull();
    const renderIds = await page.evaluate(() => globalThis.__ifc_lite_render_visibility__().isolatedIds);
    for (const id of selected) expect(renderIds).toContain(id);
    for (const id of other) expect(renderIds).not.toContain(id);
    await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().clearStoreySelection());

    // #1480: hiding an annotation through the spatial tree reaches the renderer's hidden
    // channel, and Site visibility removes authored terrain geometry from the
    // actual scene, not merely from a UI toggle.
    const [annotation] = await modelIds(page, 0, 'IFCANNOTATION');
    if (annotation === undefined) throw new Error('The authored model has no IfcAnnotation');
    const annotationName = await page.evaluate((globalId) => {
      const state = globalThis.__ifc_lite_viewer_store__.getState();
      const model = [...state.models.values()][0];
      const localId = state.resolveGlobalIdFromModels(globalId)?.expressId;
      if (localId === undefined) throw new Error('Annotation is not resolved to an IFC entity');
      return model.ifcDataStore!.entities.getName(localId) || `IfcAnnotation #${localId}`;
    }, annotation);
    await expect.poll(() => page.evaluate(() => globalThis.__ifc_lite_annotation_line_vertices__())).toBeGreaterThan(0);
    const annotationLinesBefore = await page.evaluate(() => globalThis.__ifc_lite_annotation_line_vertices__());
    const hierarchySearch = page.getByPlaceholder('Search...', { exact: true });
    await hierarchySearch.fill(annotationName);
    await page.getByRole('button', { name: `Hide ${annotationName}`, exact: true }).click();
    await expect.poll(() => page.evaluate((id) => globalThis.__ifc_lite_render_visibility__().hiddenIds.includes(id), annotation)).toBe(true);
    // Only this owner changed: a drop in the uploaded channel proves its authored curves were present before Hide.
    await expect.poll(() => page.evaluate(() => globalThis.__ifc_lite_annotation_line_vertices__())).toBeLessThan(annotationLinesBefore);
    await hierarchySearch.clear();
    if (federated) {
      const terrain = await modelIds(page, 1, 'IFCGEOGRAPHICELEMENT');
      expect(terrain.length).toBeGreaterThan(0);
      await expect.poll(() => sceneOwners(page, terrain)).toHaveLength(terrain.length);
      await setTypeVisibility(page, 'site', false);
      await expect.poll(() => sceneOwners(page, terrain), { timeout: 30_000 }).toEqual([]);
      await setTypeVisibility(page, 'site', true);
    }

    // #2060: use a cut through rooms and openings that yields both classes in
    // the actual 2D output first. The same output feeds the section overlay.
    await setTypeVisibility(page, 'openings', true);
    await page.evaluate((cutPercent) => {
      const state = globalThis.__ifc_lite_viewer_store__.getState();
      state.setActiveTool('section');
      state.setSectionPlaneAxis('down');
      // The terrain extends the federated Y range far beyond the building.
      state.setSectionPlanePosition(cutPercent);
      state.openPanelInHome('drawing');
    }, federated ? 2 : 25);
    await expect.poll(() => drawingTypeCounts(page, 0), { timeout: 60_000 })
      .toEqual(expect.objectContaining({ IfcSpace: expect.any(Number), IfcOpeningElement: expect.any(Number) }));
    const baseline = await drawingTypeCounts(page, 0);
    expect(baseline.IfcSpace).toBeGreaterThan(0);
    expect(baseline.IfcOpeningElement).toBeGreaterThan(0);
    await setTypeVisibility(page, 'spaces', false);
    await setTypeVisibility(page, 'openings', false);
    await expect.poll(async () => {
      const counts = await drawingTypeCounts(page, 0);
      return { spaces: counts.IfcSpace ?? 0, openings: counts.IfcOpeningElement ?? 0 };
    }, { timeout: 60_000 }).toEqual({ spaces: 0, openings: 0 });
    const openings = await modelIds(page, 0, 'IFCOPENINGELEMENT');
    await expect.poll(() => sceneOwners(page, [...spaces, ...openings])).toEqual([]);

    // #5869 / Show All: it clears actionable reasons while retaining the
    // persisted type-visibility preference. #5882 names this kept reason.
    await page.evaluate(() => {
      const state = globalThis.__ifc_lite_viewer_store__.getState();
      const model = [...state.models.values()][0];
      const wall = model.ifcDataStore!.entityIndex.byType.get('IFCWALLSTANDARDCASE')?.[0];
      if (wall === undefined) throw new Error('The authored model has no wall');
      state.hideEntity(state.toGlobalId(model.id, wall));
      state.setStoreySelection(state.toGlobalId(model.id, [...model.ifcDataStore!.spatialHierarchy!.byStorey.keys()][0]!));
      state.showAll();
    });
    const reset = await page.evaluate(() => {
      const state = globalThis.__ifc_lite_viewer_store__.getState();
      return { hidden: state.hiddenEntities.size, storeys: state.selectedStoreys.size, spaces: state.typeVisibility.spaces, openings: state.typeVisibility.openings };
    });
    expect(reset).toEqual({ hidden: 0, storeys: 0, spaces: false, openings: false });

    // Drive every row of the production visibility-reason table. Some modes
    // cannot be activated by one sequence of UI clicks (ghost and isolation
    // are ordinarily exclusive), but the store can hold both after a restore.
    // Show All must clear every `cleared` row and preserve every `kept` row.
    const reasons = await page.evaluate(() => {
      const state = globalThis.__ifc_lite_viewer_store__.getState();
      const model = [...state.models.values()][0];
      const walls = model.ifcDataStore!.entityIndex.byType.get('IFCWALLSTANDARDCASE') ?? [];
      const firstWall = state.toGlobalId(model.id, walls[0]!);
      const secondWall = state.toGlobalId(model.id, walls[1]!);
      const firstStorey = state.toGlobalId(model.id, [...model.ifcDataStore!.spatialHierarchy!.byStorey.keys()][0]!);
      const lens = state.savedLenses[0];
      if (walls.length < 2 || !lens || !state.hasTypeGeometry) throw new Error('Authored model lacks visibility controls');
      state.hideEntity(secondWall);
      state.setGhostExceptEntities(new Set([firstWall]));
      state.isolateEntity(firstWall);
      state.setClassFilter([firstWall], 'IfcWallStandardCase');
      state.setStoreySelection(firstStorey);
      state.setLevelDisplayMode('exploded');
      state.setModelVisibility(model.id, false);
      state.setActiveLens(lens.id);
      state.setLensHiddenIds(new Set([firstWall]));
      if (state.typeVisibility.site) state.toggleTypeVisibility('site');
      state.setTypeViewMode('types');
      state.setHostHiddenIfcTypes(new Set(['IfcBeam']));
      const before = globalThis.__ifc_lite_visibility_reasons__();
      state.showAll();
      return {
        before,
        after: globalThis.__ifc_lite_visibility_reasons__(),
        modelVisible: globalThis.__ifc_lite_viewer_store__.getState().models.get(model.id)?.visible,
      };
    });
    expect(reasons.before).toEqual([
      { id: 'hidden', resetPolicy: 'cleared' },
      { id: 'isolation', resetPolicy: 'cleared' },
      { id: 'ghost', resetPolicy: 'cleared' },
      { id: 'classFilter', resetPolicy: 'cleared' },
      { id: 'storey', resetPolicy: 'cleared' },
      { id: 'exploded', resetPolicy: 'cleared' },
      { id: 'modelHidden', resetPolicy: 'cleared' },
      { id: 'lens', resetPolicy: 'kept' },
      { id: 'typeVisibility', resetPolicy: 'kept' },
      { id: 'typeViewMode', resetPolicy: 'kept' },
      { id: 'hostTypes', resetPolicy: 'kept' },
    ]);
    expect(reasons.after).toEqual(reasons.before.filter(({ resetPolicy }) => resetPolicy === 'kept'));
    expect(reasons.modelVisible).toBe(true);
    // The lens can deactivate in the asynchronous lens sync after Show All;
    // these three persisted controls remain active and must have visible HUD chips.
    const keptChipIds = ['typeVisibility', 'typeViewMode', 'hostTypes'];
    const keptChips = page.locator('[data-hud-region="top-left"] [data-visibility-reason]');
    await expect(keptChips).toHaveCount(keptChipIds.length);
    for (const [index, id] of keptChipIds.entries()) {
      await expect(keptChips.nth(index)).toHaveAttribute('data-visibility-reason', id);
      await expect(keptChips.nth(index)).toHaveAttribute('title',
        'Show all keeps this setting. Change it in its control.');
      await expect(keptChips.nth(index)).toBeVisible();
    }
    await attachScreenshot(page, testInfo, `visibility-${federated ? 'two' : 'one'}-models-reset.png`);
  });
}

test('#5895 Site visibility removes single-model IfcGeographicElement terrain', async ({ page }) => {
  let softwareDeviceLost = false;
  page.on('console', (message) => {
    if (/\[WebGPU\] Device lost:|\[Renderer\] GPU device lost/.test(message.text())) softwareDeviceLost = true;
  });
  await openViewer(page);
  await load(page, TERRAIN, 1);
  const terrain = await modelIds(page, 0, 'IFCGEOGRAPHICELEMENT');
  expect(terrain.length).toBeGreaterThan(0);
  await expect.poll(() => sceneOwners(page, terrain)).toHaveLength(terrain.length);
  if (softwareDeviceLost && process.env.E2E_GPU_STRICT === '0') {
    test.skip(true, 'Hosted software WebGPU device was lost before the Site visibility reshape');
  }
  await setTypeVisibility(page, 'site', false);
  try {
    await expect.poll(() => sceneOwners(page, terrain), { timeout: 30_000 }).toEqual([]);
  } catch (error) {
    if (softwareDeviceLost && process.env.E2E_GPU_STRICT === '0') {
      test.skip(true, 'Hosted software WebGPU device was lost during the Site visibility reshape');
    }
    throw error;
  }
});
