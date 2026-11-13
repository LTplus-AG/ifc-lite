/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The browser-side readers and journey steps `rhino-import.e2e.spec.ts` drives
 * the viewer with (spec: docs/architecture/rhino-3dm-import.md, "Testing").
 *
 * Everything here reads the production store the viewer itself renders from —
 * `models`, each model's `ifcDataStore` and `geometryResult` — so an assertion
 * built on it is an assertion about what the app holds after a real load, not
 * about a parallel parse in the test process.
 */

import { expect, test, type Page, type Locator } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ViewerState } from '../../apps/viewer/src/store';
import { DEVICE_LOST_SIGNAL, GPU_STRICT, watchGpuDeviceLoss, type GpuDeviceLossWatch } from './gpu-device-loss';

declare global {
  // The viewer's own singleton (store/index.ts), the convention every viewer
  // spec reads page state through. Absent until the app's first render.
  // eslint-disable-next-line no-var -- a `declare global` binding has to be `var`.
  var __ifc_lite_viewer_store__: { getState(): ViewerState } | undefined;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
/** Git-tracked Archicad house: project, site, two storeys, walls, slabs, windows, spaces. */
export const IFC_MODEL = join(ROOT, 'apps/viewer/public/_fixtures/AC20-FZK-Haus.ifc');
/** McNeel's own Rhino 8 sample, fetched by `pnpm fixtures` (never re-hosted). */
export const FOREIGN_3DM = join(ROOT, 'tests/models/rhino/mcneel-rhino3dm/file3dm_stuff.3dm');

/** A wall of the FZK house whose `Pset_WallCommon` the import has to carry across. */
export const FZK_WALL = { globalId: '2XPyKWY018sA1ygZKgQPtU', ifcClass: 'IfcWallStandardCase' } as const;

export interface Journey {
  page: Page;
  gpu: GpuDeviceLossWatch;
  /** Console errors and uncaught page errors; device-loss noise excluded under hosted GPU. */
  errors: string[];
}

/** Six numbers: min x, y, z then max x, y, z, in the viewer's Y-up world metres. */
export type WorldBox = [number, number, number, number, number, number];

export interface ModelSnapshot {
  modelId: string;
  name: string;
  loadPath: string | null;
  schemaVersion: string;
  sourceKind: string | null;
  entityCount: number;
  meshCount: number;
  triangles: number;
  /** How many GlobalIds `boxes` holds. */
  boxedEntities: number;
  /** How many of those came from `instancedGeometryAabbs` rather than `meshes`. */
  instancedBoxes: number;
  /** World AABB per IFC GlobalId, unioned over every mesh that entity drew. */
  boxes: Record<string, WorldBox>;
  /** The class each boxed GlobalId carries in this model's entity table. */
  classes: Record<string, string>;
  /** Storey name to elevation in metres, from the model's own spatial hierarchy. */
  storeys: Record<string, number | null>;
  /** The spatial hierarchy's root: its class, name and GlobalId. */
  root: { ifcClass: string; name: string; globalId: string } | null;
  /** Direct children of the root, as the hierarchy panel lists them. */
  rootChildren: { ifcClass: string; name: string }[];
}

/**
 * Per-model world boxes and counts, read in the page.
 *
 * Self-contained: `page.evaluate` serialises this function, so it may not
 * close over anything in the test process.
 */
function readModels(): ModelSnapshot[] {
  const state = globalThis.__ifc_lite_viewer_store__!.getState();
  const snapshots: ModelSnapshot[] = [];
  for (const [modelId, model] of state.models) {
    const store = model.ifcDataStore;
    const boxes: Record<string, WorldBox> = {};
    let meshCount = 0;
    let triangles = 0;
    const widen = (globalId: string, x: number, y: number, z: number) => {
      if (!globalId) return;
      const box = (boxes[globalId] ??= [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
      const point = [x, y, z];
      for (let axis = 0; axis < 3; axis++) {
        if (point[axis] < box[axis]) box[axis] = point[axis];
        if (point[axis] > box[axis + 3]) box[axis + 3] = point[axis];
      }
    };
    // Both id spaces here are the federated one: `mesh.expressId` and the keys
    // of `instancedGeometryAabbs` are both shifted by `idOffset` on load.
    const globalIdOf = (globalExpressId: number) =>
      store?.entities.getGlobalId(globalExpressId - model.idOffset) ?? '';
    for (const mesh of model.geometryResult?.meshes ?? []) {
      meshCount++;
      triangles += mesh.indices.length / 3;
      const origin = mesh.origin ?? [0, 0, 0];
      const positions: Float32Array = mesh.positions;
      // A colour-merged batch carries one entity per vertex; an ordinary mesh
      // is one entity whole. Reading `entityIds` where it exists keeps a
      // merged batch from pooling several elements into one box.
      const perVertex: Uint32Array | undefined = mesh.entityIds;
      const own = perVertex ? '' : globalIdOf(mesh.expressId);
      for (let i = 0, vertex = 0; i < positions.length; i += 3, vertex++) {
        widen(perVertex ? globalIdOf(perVertex[vertex]) : own,
          positions[i] + origin[0], positions[i + 1] + origin[1], positions[i + 2] + origin[2]);
      }
    }
    // An entity whose whole mesh set went to the GPU-instanced shard is absent
    // from `meshes` and carries its world box here instead (`MeshData.origin`
    // and the RTC offset already folded in). Without these, FZK's 42 instanced
    // balustrade members would read as geometry the IFC does not have.
    let instancedBoxes = 0;
    for (const [globalExpressId, aabb] of model.geometryResult?.instancedGeometryAabbs ?? []) {
      const globalId = globalIdOf(globalExpressId);
      if (!globalId || boxes[globalId]) continue;
      if (![...aabb.min, ...aabb.max].every((v) => Number.isFinite(v))) continue;
      boxes[globalId] = [...aabb.min, ...aabb.max] as WorldBox;
      instancedBoxes++;
    }
    const classes: Record<string, string> = {};
    for (const globalId of Object.keys(boxes)) classes[globalId] = '';
    if (store) {
      for (const expressId of store.entities.expressId) {
        if (!expressId) continue;
        const globalId = store.entities.getGlobalId(expressId);
        if (globalId && globalId in classes) classes[globalId] = store.entities.getTypeName(expressId);
      }
    }
    const hierarchy = store?.spatialHierarchy ?? null;
    const storeys: Record<string, number | null> = {};
    if (hierarchy) {
      for (const [expressId, elevation] of hierarchy.storeyElevations) {
        storeys[store!.entities.getName(expressId)] = elevation ?? null;
      }
    }
    snapshots.push({
      modelId,
      name: model.name,
      loadPath: model.loadPath ?? null,
      schemaVersion: model.schemaVersion,
      sourceKind: store?.sourceKind ?? null,
      entityCount: store?.entityCount ?? 0,
      meshCount,
      triangles,
      boxedEntities: Object.keys(boxes).length,
      instancedBoxes,
      boxes,
      classes,
      storeys,
      root: hierarchy ? {
        ifcClass: store!.entities.getTypeName(hierarchy.project.expressId),
        name: hierarchy.project.name,
        globalId: store!.entities.getGlobalId(hierarchy.project.expressId),
      } : null,
      rootChildren: hierarchy
        ? hierarchy.project.children.map((node) => ({ ifcClass: store!.entities.getTypeName(node.expressId), name: node.name }))
        : [],
    });
  }
  return snapshots;
}

export async function modelSnapshots(page: Page): Promise<ModelSnapshot[]> {
  return page.evaluate(readModels);
}

export interface Overlay {
  /** GlobalIds that drew geometry in both models. */
  matched: string[];
  /** GlobalIds boxed in the first model only, and in the second only. */
  onlyFirst: string[];
  onlySecond: string[];
  /** The worst single corner-coordinate gap over every matched entity, in metres. */
  worstGap: number;
  /** The matched entity and axis that gap sits on. */
  worstAt: { globalId: string; axis: 'x' | 'y' | 'z'; corner: 'min' | 'max'; first: number; second: number } | null;
  /** The worst gap per axis, so a swapped or flipped up axis is named rather than merely large. */
  perAxis: { x: number; y: number; z: number };
  /** Both models' whole-geometry boxes, for a quick place-and-size read. */
  firstBounds: WorldBox;
  secondBounds: WorldBox;
}

const AXES = ['x', 'y', 'z'] as const;

function union(boxes: WorldBox[]): WorldBox {
  const out: WorldBox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const box of boxes) {
    for (let axis = 0; axis < 3; axis++) {
      out[axis] = Math.min(out[axis], box[axis]);
      out[axis + 3] = Math.max(out[axis + 3], box[axis + 3]);
    }
  }
  return out;
}

/**
 * Compare two models' per-GlobalId world boxes: the same place, the same size
 * and the same up axis all fail here as a corner gap, and the axis the worst
 * gap sits on says which.
 */
export function overlayOf(first: ModelSnapshot, second: ModelSnapshot): Overlay {
  const matched = Object.keys(first.boxes).filter((globalId) => second.boxes[globalId]).sort();
  const perAxis = { x: 0, y: 0, z: 0 };
  let worstGap = 0;
  let worstAt: Overlay['worstAt'] = null;
  for (const globalId of matched) {
    const a = first.boxes[globalId];
    const b = second.boxes[globalId];
    for (let axis = 0; axis < 3; axis++) {
      for (const corner of [0, 3] as const) {
        const gap = Math.abs(a[axis + corner] - b[axis + corner]);
        const name = AXES[axis];
        if (gap > perAxis[name]) perAxis[name] = gap;
        if (gap > worstGap) {
          worstGap = gap;
          worstAt = { globalId, axis: name, corner: corner === 0 ? 'min' : 'max', first: a[axis + corner], second: b[axis + corner] };
        }
      }
    }
  }
  return {
    matched,
    onlyFirst: Object.keys(first.boxes).filter((globalId) => !second.boxes[globalId]).sort(),
    onlySecond: Object.keys(second.boxes).filter((globalId) => !first.boxes[globalId]).sort(),
    worstGap,
    worstAt,
    perAxis,
    firstBounds: union(Object.values(first.boxes)),
    secondBounds: union(Object.values(second.boxes)),
  };
}

/**
 * Open the built viewer, record console and page errors from the first byte,
 * and open the tracked AC20 house from disk the way a user does.
 */
export async function openViewerWithIfc(page: Page): Promise<Journey> {
  const journey = await openViewer(page);
  await journey.gpu.raceLoss('open the AC20 house', async () => {
    await page.locator('#file-input-open').setInputFiles(IFC_MODEL);
    await waitForModels(page, 1);
  });
  return journey;
}

/** The viewer, loaded and instrumented, with nothing opened yet. */
export async function openViewer(page: Page): Promise<Journey> {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (!GPU_STRICT && DEVICE_LOST_SIGNAL.test(text)) return;
    errors.push(`console: ${text}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.stack ?? error.message}`));
  page.context().on('response', (response) => {
    if (response.status() >= 400) errors.push(`http ${response.status()}: ${response.url()}`);
  });
  // Vercel Web Analytics is served by the Vercel edge only; `vite preview` 404s it.
  await page.route('**/_vercel/insights/script.js', (route) => route.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.addInitScript(() => {
    localStorage.setItem('ifclite.extensions.privacy-disclosure.v2', 'e2e acknowledged');
  });
  const gpu = await watchGpuDeviceLoss(page);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/');
  await page.waitForFunction(() => !!globalThis.__ifc_lite_viewer_store__, undefined, { timeout: 120_000 });
  return { page, gpu, errors };
}

/** Wait until exactly `count` models are loaded, settled and carrying geometry. */
export async function waitForModels(page: Page, count: number): Promise<void> {
  await page.waitForFunction((n) => {
    const state = globalThis.__ifc_lite_viewer_store__?.getState();
    if (!state) return false;
    return state.models.size === n && !state.loading && !state.geometryStreamingActive &&
      [...state.models.values()].every((model) => model.ifcDataStore &&
        ((model.geometryResult?.meshes.length ?? 0) > 0 || (model.geometryResult?.pointClouds?.length ?? 0) > 0));
  }, count, { timeout: 180_000 });
}

/** Run `export:3dm` from the command palette and return the Rhino dialog. */
async function openRhinoExportDialog(page: Page): Promise<Locator> {
  await expect(page.getByRole('button', { name: /Commands…|More actions/ }).first()).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Command palette', exact: true });
  await expect(palette).toBeVisible();
  await palette.getByRole('combobox', { name: 'Search commands', exact: true }).fill('rhino');
  const row = palette.getByRole('option', { name: /Rhino \(\.3dm\)/ });
  await expect(row).toHaveCount(1);
  await row.click();
  const dialog = page.getByRole('dialog', { name: 'Export Rhino (.3dm)', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Pick `option` in the dialog's Radix select labelled `label`. */
async function choose(page: Page, dialog: Locator, label: string, option: string): Promise<void> {
  await dialog.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: label, exact: true })).toHaveText(option);
}

/**
 * Export the loaded model to `.3dm` through the dialog, in the given
 * coordinate mode, and return the downloaded bytes.
 */
export async function exportTo3dm(page: Page, coordinates: 'local' | 'world', name: string): Promise<Buffer> {
  const dialog = await openRhinoExportDialog(page);
  if (coordinates === 'world') await choose(page, dialog, 'Coordinates', 'World (as in the IFC file)');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 180_000 }),
    dialog.getByRole('button', { name: 'Export', exact: true }).click(),
  ]);
  const path = test.info().outputPath(name);
  await download.saveAs(path);
  await expect(dialog.getByText('Success', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
  return readFile(path);
}

/** Add `bytes` as a federated model and wait for the federation to settle. */
export async function addModel(page: Page, bytes: Buffer, name: string, total: number): Promise<void> {
  await page.locator('#file-input-add').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: bytes });
  await waitForModels(page, total);
}

/** Every entity the store holds, by GlobalId, with the class and name it carries. */
export async function entitiesByGlobalId(page: Page, modelId: string): Promise<Record<string, { expressId: number; globalExpressId: number; ifcClass: string; name: string }>> {
  return page.evaluate((id) => {
    const model = globalThis.__ifc_lite_viewer_store__!.getState().models.get(id)!;
    const store = model.ifcDataStore!;
    const out: Record<string, { expressId: number; globalExpressId: number; ifcClass: string; name: string }> = {};
    for (const expressId of store.entities.expressId) {
      if (!expressId) continue;
      const globalId = store.entities.getGlobalId(expressId);
      if (!globalId) continue;
      out[globalId] = {
        expressId,
        globalExpressId: expressId + model.idOffset,
        ifcClass: store.entities.getTypeName(expressId),
        name: store.entities.getName(expressId),
      };
    }
    return out;
  }, modelId);
}

/** The property sets the store answers for one entity, as the panel reads them. */
export async function propertySets(page: Page, modelId: string, expressId: number): Promise<Record<string, Record<string, string>>> {
  return page.evaluate(({ id, entity }) => {
    const store = globalThis.__ifc_lite_viewer_store__!.getState().models.get(id)!.ifcDataStore!;
    const out: Record<string, Record<string, string>> = {};
    for (const set of store.getProperties(entity)) {
      out[set.name] = Object.fromEntries(set.properties.map((property) => [property.name, String(property.value)]));
    }
    return out;
  }, { id: modelId, entity: expressId });
}

/** What the viewer currently hides in `modelId`: each entity's class and name. */
export async function hidden(page: Page, modelId: string): Promise<{ ifcClass: string; name: string }[]> {
  return page.evaluate((id) => {
    const state = globalThis.__ifc_lite_viewer_store__!.getState();
    const model = state.models.get(id)!;
    const store = model.ifcDataStore!;
    return [...state.hiddenEntities]
      .map((globalExpressId) => {
        const expressId = globalExpressId - model.idOffset;
        return { ifcClass: store.entities.getTypeName(expressId), name: store.entities.getName(expressId) };
      })
      .filter((entity) => entity.name !== '')
      .sort((a, b) => a.name.localeCompare(b.name));
  }, modelId);
}

/**
 * Bring a deep hierarchy row into the panel by searching for it: the panel
 * projects a fully expanded tree while a search is active, so this reaches a
 * row under a collapsed storey without clicking chevrons down to it.
 */
export async function findInHierarchy(page: Page, query: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Search hierarchy', exact: true }).fill(query);
}
