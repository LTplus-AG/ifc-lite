/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #5819: exercise the Radix menu's actual browser focus and keyboard behavior over an authored IFC. */
import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rendererColorFrame } from './federation-control-triplet.rendering';
import type { ViewerState } from '../../apps/viewer/src/store';

declare global {
  var __ifc_lite_viewer_store__: { getState(): ViewerState };
  var __ifc_lite_copied_global_id__: string | undefined;
  var __ifc_lite_duplicate_remeshed__: number[] | undefined;
  var __ifc_lite_duplicate_unsubscribe__: (() => void) | undefined;
}

async function openWallMenu(page: Page, selectWall = false): Promise<number> {
  return page.evaluate((select) => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const [modelId, model] = [...state.models][0];
    const entities = model.ifcDataStore!.entities;
    const wall = [...entities.expressId].find((id) => entities.getTypeName(id) === 'IfcWall');
    if (wall == null) throw new Error('authored sample has no IfcWall');
    const globalId = state.toGlobalId(modelId, wall);
    if (select) state.setSelectedEntityIds([globalId]);
    state.openContextMenu(globalId, 320, 240);
    return globalId;
  }, selectWall);
}

async function clickEntityAction(page: Page, label: string, selectWall = false): Promise<number> {
  const globalId = await openWallMenu(page, selectWall);
  const menu = page.getByRole('menu', { name: 'Entity actions' });
  await menu.getByRole('menuitem', { name: label, exact: true }).click();
  await expect(menu).toBeHidden();
  return globalId;
}

test('authored IFC entity menu exposes actions, arrow navigation, submenu and focus return (#5819)', async ({ page }, info) => {
  await page.goto('/?model=/samples/building-architecture.ifc');
  await page.waitForFunction(() => {
    const state = globalThis.__ifc_lite_viewer_store__?.getState();
    return state?.models.size === 1 && !state.loading && !state.geometryStreamingActive &&
      [...state.models.values()].every((model) => model.ifcDataStore && (model.geometryResult?.meshes.length ?? 0) > 0);
  }, undefined, { timeout: 180_000 });

  await page.getByRole('tab', { name: 'Author', exact: true }).click();
  const modelWorkspace = page.getByRole('tabpanel', { name: 'Author' }).getByRole('button', { name: 'Model', exact: true });
  await modelWorkspace.click();
  await expect(modelWorkspace).toHaveAttribute('aria-pressed', 'true');

  // The real viewport menu is opened by the picking handler, which has already
  // resolved a renderer ID. Supply that same ID to exercise the shell without
  // depending on a particular camera angle or screen-space wall pixel.
  await page.evaluate(() => {
    const opener = document.createElement('button');
    opener.id = 'context-menu-focus-origin';
    opener.textContent = 'Focus origin';
    document.body.append(opener);
    opener.focus();
  });
  await openWallMenu(page);

  const menu = page.getByRole('menu', { name: 'Entity actions' });
  await expect(menu).toBeVisible();
  const expected = [
    'Frame selection', 'Hide', 'Set Collection', 'Add to Collection',
    'Remove from Collection', 'Save Collection View', 'Select same storey',
    'Copy GlobalId', 'Export anonymized…',
  ];
  for (const label of expected) await expect(menu.getByRole('menuitem', { name: label, exact: true })).toBeVisible();

  const frame = menu.getByRole('menuitem', { name: 'Frame selection', exact: true });
  const hintContrast = await frame.locator('span').last().evaluate((hint) => {
    const channels = (color: string) => [...color.matchAll(/[\d.]+/g)].slice(0, 3).map((match) => Number(match[0]) / 255);
    const luminance = (color: string) => {
      const linear = channels(color).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    };
    const fg = luminance(getComputedStyle(hint).color);
    const bg = luminance(getComputedStyle(hint.closest('[role="menu"]')!).backgroundColor);
    return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
  });
  expect(hintContrast).toBeGreaterThanOrEqual(4.5);
  await frame.focus();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Hide', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(frame).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem').last()).toBeFocused();

  const submenu = menu.locator('[role="menuitem"][aria-haspopup="menu"]');
  await expect(submenu).toBeVisible();
  await submenu.focus();
  await page.keyboard.press('ArrowRight');
  const direction = page.getByRole('menuitem', { name: 'Duplicate +X (east)' });
  await expect(direction).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(submenu).toBeFocused();

  const selectedOnDismiss = await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const id = state.contextMenu.entityId;
    if (id == null) throw new Error('authored IFC menu has no entity owner');
    state.setSelectedEntityIds([id]);
    state.setSelectedEntityId(id);
    return id;
  });
  await page.screenshot({ path: info.outputPath('entity-context-menu-authored-ifc.png') });
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(page.locator('#context-menu-focus-origin')).toBeFocused();
  const selectionAfterDismiss = await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    return { selectedEntityId: state.selectedEntityId, selectedEntityIds: [...state.selectedEntityIds] };
  });
  expect(selectionAfterDismiss).toEqual({ selectedEntityId: selectedOnDismiss, selectedEntityIds: [selectedOnDismiss] });

  await openWallMenu(page);
  await menu.getByRole('menuitem', { name: 'Hide', exact: true }).click();
  await expect(menu).toBeHidden();
  const hidden = await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    return state.hiddenEntities.size;
  });
  expect(hidden).toBeGreaterThan(0);

  // The canvas variant uses the same Radix shell; Show all must still reach
  // the shared visibility reset after an entity action hid real geometry.
  await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().openContextMenu(null, 320, 240));
  const canvasMenu = page.getByRole('menu', { name: 'Canvas actions' });
  await canvasMenu.getByRole('menuitem', { name: 'Show all' }).click();
  await expect(canvasMenu).toBeHidden();
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().hiddenEntities.size)).toBe(0);

  // Basket commands must keep their distinct set/add/remove effects after
  // moving from ordinary buttons into Radix menu items.
  await clickEntityAction(page, 'Set Collection', true);
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().pinboardEntities.size)).toBe(1);
  await clickEntityAction(page, 'Remove from Collection', true);
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().pinboardEntities.size)).toBe(0);
  await clickEntityAction(page, 'Add to Collection', true);
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().pinboardEntities.size)).toBe(1);
  // This test covers menu dispatch, not GPU thumbnail capture. In software-GPU
  // CI the device may have been lost by an earlier smoke case, leaving the
  // thumbnail's queue.onSubmittedWorkDone() pending indefinitely. With no
  // viewport canvas, the real save command still creates the collection view.
  const viewportCanvas = await page.locator('canvas[data-viewport="main"]').elementHandle();
  if (!viewportCanvas) throw new Error('authored viewer has no viewport canvas');
  await viewportCanvas.evaluate((canvas) => canvas.removeAttribute('data-viewport'));
  await clickEntityAction(page, 'Save Collection View', true);
  await expect.poll(() => page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().basketViews.length)).toBeGreaterThan(0);
  await viewportCanvas.evaluate((canvas) => canvas.setAttribute('data-viewport', 'main'));

  await clickEntityAction(page, 'Select all IfcWall');
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().selectedEntityIds.size)).toBeGreaterThan(0);
  await clickEntityAction(page, 'Select same storey');
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().selectedEntityIds.size)).toBeGreaterThan(0);

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value: string) => { globalThis.__ifc_lite_copied_global_id__ = value; } },
    });
  });
  await clickEntityAction(page, 'Copy GlobalId');
  expect(await page.evaluate(() => globalThis.__ifc_lite_copied_global_id__?.length ?? 0)).toBeGreaterThan(0);

  const sourceId = await openWallMenu(page);
  // The direct action and the directional submenu both have the accessible
  // name “Duplicate”; pick the button that executes the default action.
  await menu.locator('button[role="menuitem"][aria-label="Duplicate"]').click();
  await expect(menu).toBeHidden();
  const duplicatedId = await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().selectedEntityId);
  expect(duplicatedId).not.toBeNull();
  expect(duplicatedId).not.toBe(sourceId);
  await openWallMenu(page);
  await menu.locator('[role="menuitem"][aria-haspopup="menu"]').hover();
  await page.getByRole('menuitem', { name: 'Duplicate −X (west)' }).click();
  await expect(menu).toBeHidden();
  const directionalId = await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().selectedEntityId);
  expect(directionalId).not.toBeNull();
  expect(directionalId).not.toBe(duplicatedId);
  const deletedId = await clickEntityAction(page, 'Delete entity');
  expect(await page.evaluate((id) => globalThis.__ifc_lite_viewer_store__.getState().hiddenEntities.has(id), deletedId)).toBe(true);

  await clickEntityAction(page, 'Export anonymized…', true);
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().anonymizedExportRequested)).toBe(true);
});


/** #6232: a real Revit assembly, copied through the actual Duplicate shortcut. */
test('Revit assembly Duplicate carries both beams and removes the full subgraph with one undo (#6232)', async ({ page }, info) => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const file = join(root, 'tests/models/various/01_Snowdon_Towers_Sample_Structural(1).ifc');
  test.skip(!existsSync(file), 'Run pnpm fixtures to fetch the real Revit Snowdon fixture');
  const bytes = await readFile(file);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  expect(sha256).toBe('fab102eb5f9152bc7053d7e4920a8b75d0d34683c834078f0735c88308eb00a4');
  const require = createRequire(join(root, 'apps/viewer/package.json'));
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
  const cacheDir = await mkdtemp(join(tmpdir(), 'ifc-duplicate-6232-'));
  const server = await createServer({ root: join(root, 'apps/viewer'), cacheDir, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  try {
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    if (!url) throw new Error('Duplicate witness viewer did not expose a URL');
    await page.goto(url);
    await page.evaluate(() => { const state = globalThis.__ifc_lite_viewer_store__.getState(); if (state.typeVisibility.ifcGrid) state.toggleTypeVisibility('ifcGrid'); });
    await page.locator('#file-input-add').setInputFiles(file);
    await page.waitForFunction(() => {
      const state = globalThis.__ifc_lite_viewer_store__?.getState();
      return state?.models.size === 1 && !state.loading && !state.geometryStreamingActive &&
        [...state.models.values()].every((m) => m.ifcDataStore && (m.geometryResult?.meshes.length ?? 0) > 0);
    }, undefined, { timeout: 180_000 });
    await page.getByRole('tab', { name: 'Author', exact: true }).click();
    await page.getByRole('tabpanel', { name: 'Author' }).getByRole('button', { name: 'Model', exact: true }).click();
    const before = await page.evaluate(async () => {
      const moduleUrl = '/src/store/index.ts';
      const module = await import(moduleUrl);
      const store: { subscribe(listener: (state: ViewerState) => void): () => void } = module.useViewerStore;
      globalThis.__ifc_lite_duplicate_remeshed__ = [];
      globalThis.__ifc_lite_duplicate_unsubscribe__ = store.subscribe((next) => {
        if (next.pendingMeshEdits) globalThis.__ifc_lite_duplicate_remeshed__ = [...new Set([...globalThis.__ifc_lite_duplicate_remeshed__!, ...next.pendingMeshEdits.ids])];
      });
      const state = globalThis.__ifc_lite_viewer_store__.getState();
      const modelId = [...state.models.keys()][0];
      const id = state.toGlobalId(modelId, 144910);
      state.setSessionStorey(142); // Actual IfcRelContainedInSpatialStructure of assembly #144910.
      state.setSelectedEntityId(id);
      return { modelId, id, undo: state.undoStacks.get(modelId)?.length ?? 0, overlayIds: state.mutationViews.get(modelId)?.getNewEntities().map((r) => r.expressId) ?? [] };
    });
    await page.keyboard.press('Control+d');
    await expect.poll(() => page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().selectedEntityId)).not.toBe(before.id);
    const copied = await page.evaluate(({ modelId, overlayIds }) => {
      const state = globalThis.__ifc_lite_viewer_store__.getState();
      const view = state.mutationViews.get(modelId)!;
      const records = view.getNewEntities().filter((r) => !overlayIds.includes(r.expressId));
      const assembly = records.find((r) => r.type === 'IfcElementAssembly');
      const parts = records.filter((r) => r.type === 'IfcBeam');
      if (!assembly) throw new Error('Duplicate created no assembly');
      const relationships = records.filter((r) => r.type === 'IfcRelAggregates');
      return { assemblyId: assembly.expressId, parts: parts.map((r) => {
        const GlobalId = r.attributes[0];
        if (typeof GlobalId !== 'string') throw new Error('Copied beam has no IFC GlobalId');
        return { id: r.expressId, source: view.getEntityAlias(r.expressId), GlobalId };
      }), relationships: relationships.map((r) => {
        const parent = r.attributes[4], children = r.attributes[5];
        if (typeof parent !== 'string' || !Array.isArray(children) || children.some((v) => typeof v !== 'string')) throw new Error('Copied aggregation has unreadable references');
        return [parent, children.map((v) => String(v))];
      }), recordIds: records.map((r) => r.expressId) };
    }, before);
    expect(copied.parts.map((p) => p.source).sort((a, b) => a! - b!)).toEqual([22347, 75395]);
    expect(copied.relationships).toEqual([[`#${copied.assemblyId}`, copied.parts.map((p) => `#${p.id}`)]]);
    expect(new Set(copied.parts.map((p) => p.GlobalId)).size).toBe(2);
    await page.waitForFunction(({ modelId, ids }) => {
      const state = globalThis.__ifc_lite_viewer_store__.getState();
      const meshes = state.models.get(modelId)?.geometryResult?.meshes ?? [];
      return ids.every((id) => globalThis.__ifc_lite_duplicate_remeshed__?.includes(state.toGlobalId(modelId, id)) && meshes.some((m) => m.expressId === state.toGlobalId(modelId, id) && m.indices.length > 0));
    }, { modelId: before.modelId, ids: copied.parts.map((p) => p.id) }, { timeout: 60_000 });
    await page.evaluate(({ modelId, parts }) => {
      const state = globalThis.__ifc_lite_viewer_store__.getState();
      const ids = [22347, 75395, ...parts.map((p) => p.id)].map((id) => state.toGlobalId(modelId, id));
      state.setSelectedEntityIds(ids);
      state.setIsolatedEntities(new Set(ids));
      setTimeout(() => state.cameraCallbacks.frameSelection?.(), 50);
    }, { modelId: before.modelId, parts: copied.parts });
    await page.waitForTimeout(500);
    const png = await rendererColorFrame(page);
    const coloredMeshPixels = await page.evaluate(async (base64) => {
      const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Cannot decode the actual renderer frame');
      context.drawImage(image, 0, 0);
      const rgba = context.getImageData(0, 0, image.width, image.height).data;
      let colored = 0;
      for (let i = 0; i < rgba.length; i += 4) if (rgba[i + 2]! > rgba[i]! * 1.2 && rgba[i + 1]! > rgba[i]! * 1.2) colored++;
      image.close();
      return colored;
    }, png.toString('base64'));
    expect(coloredMeshPixels, 'selected real beams must be visible in the renderer frame, not hidden by the workspace storey context').toBeGreaterThan(100);
    await writeFile(info.outputPath('revit-assembly-duplicate.png'), png);
    await page.evaluate((modelId) => globalThis.__ifc_lite_viewer_store__.getState().undo(modelId), before.modelId);
    const afterUndo = await page.evaluate(({ modelId, ids }) => {
      const state = globalThis.__ifc_lite_viewer_store__.getState();
      return { remaining: state.mutationViews.get(modelId)!.getNewEntities().filter((r) => ids.includes(r.expressId)).length,
        undo: state.undoStacks.get(modelId)?.length ?? 0,
        copiedMeshes: state.models.get(modelId)!.geometryResult!.meshes.filter((m) => ids.some((id) => state.toGlobalId(modelId, id) === m.expressId)).length };
    }, { modelId: before.modelId, ids: copied.recordIds });
    expect(afterUndo).toEqual({ remaining: 0, undo: before.undo, copiedMeshes: 0 });
    await page.waitForTimeout(300);
    const afterUndoPng = await rendererColorFrame(page);
    expect(afterUndoPng.equals(png), 'one undo must remove the copied beams from the submitted renderer frame').toBe(false);
    await writeFile(info.outputPath('revit-assembly-after-undo.png'), afterUndoPng);
    const remeshedGlobalIds = await page.evaluate(() => { globalThis.__ifc_lite_duplicate_unsubscribe__?.(); return globalThis.__ifc_lite_duplicate_remeshed__; });
    await writeFile(info.outputPath('revit-assembly-duplicate.json'), JSON.stringify({ fixture: { sha256, bytes: bytes.length, author: 'Autodesk Revit 2024', assemblyId: 144910, originalPartIds: [22347, 75395] }, copied, remeshedGlobalIds, coloredMeshPixels, afterUndo, browser: await page.evaluate(() => navigator.userAgent) }, null, 2));
  } finally {
    try { await server.close(); }
    finally { await rm(cacheDir, { recursive: true, force: true }); }
  }
});
