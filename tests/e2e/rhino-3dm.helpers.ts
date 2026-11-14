/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The export dialog's drivers and the fixture paths, shared by both Rhino
 * `.3dm` specs, plus the browser-side store readers only the import spec
 * asserts on (`rhino-import.e2e.spec.ts`, and
 * docs/architecture/rhino-3dm-import.md, "Testing").
 *
 * Every reader here reads the production store the viewer itself renders from
 * — `models`, each model's `ifcDataStore` and `geometryResult` — so an
 * assertion built on it is an assertion about what the app holds after a real
 * load, not about a parallel parse in the test process.
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
  var __ifc_lite_viewer_store__: { getState(): ViewerState };
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
/**
 * How long a load or a `.3dm` download may take. Well inside the 240 s test
 * timeout, so a slow step reports itself instead of the generic timeout; four
 * tests share one 13-minute CI shard. Both Rhino specs read it from here.
 */
export const STEP_TIMEOUT_MS = 120_000;
/** Git-tracked Archicad house: project, site, two storeys, walls, slabs, windows, spaces. */
export const IFC_MODEL = join(ROOT, 'apps/viewer/public/_fixtures/AC20-FZK-Haus.ifc');
/** 79 KB git-tracked sample, for a step that needs an IFC but not a big one. */
export const SMALL_IFC = join(ROOT, 'apps/viewer/public/samples/hello-wall.ifc');
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
  /** How many boxes came from `instancedGeometryAabbs` rather than from `meshes`. */
  instancedBoxes: number;
  /** World AABB per IFC GlobalId, unioned over every mesh that entity drew. */
  boxes: Record<string, WorldBox>;
  /** The class each boxed GlobalId carries in this model's entity table. */
  classes: Record<string, string>;
  /** Every distinct `MeshData.color`, and each point cloud's first point colour. */
  colours: number[][];
  /** Storey name to elevation in metres, from the model's own spatial hierarchy. */
  storeys: Record<string, number | null>;
  /** The spatial hierarchy's root: its class, name and GlobalId. */
  root: { ifcClass: string; name: string; globalId: string } | null;
  /** Direct children of the root, as the hierarchy panel lists them. */
  rootChildren: { ifcClass: string; name: string }[];
}

/**
 * Per-model world boxes, colours and counts, read in the page.
 *
 * The box walk is the test's own, not the renderer's `__ifc_lite_scene_owner__`
 * hook, for two reasons. `Scene.addMeshData` registers a colour-merged batch
 * under every entity in it, so the hook's per-entity box pools the whole batch
 * and could not answer per GlobalId; and the hook needs a live device, while
 * this comparison has to gate under hosted software WebGPU too.
 *
 * Self-contained: `page.evaluate` serialises this function, so it may not
 * close over anything in the test process.
 */
function readModels(): ModelSnapshot[] {
  const state = globalThis.__ifc_lite_viewer_store__.getState();
  const snapshots: ModelSnapshot[] = [];
  for (const [modelId, model] of state.models) {
    const store = model.ifcDataStore;
    const boxes: Record<string, WorldBox> = {};
    const classes: Record<string, string> = {};
    const colours = new Map<string, number[]>();
    let meshCount = 0;
    let triangles = 0;
    // Both id spaces here are the federated one: `mesh.expressId` and the keys
    // of `instancedGeometryAabbs` are both shifted by `idOffset` on load. The
    // class is recorded as the id resolves, so nothing has to walk the entity
    // table afterwards to label the boxes.
    const boxFor = (globalExpressId: number): WorldBox | null => {
      const expressId = globalExpressId - model.idOffset;
      const globalId = store?.entities.getGlobalId(expressId) ?? '';
      if (!globalId) return null;
      const existing = boxes[globalId];
      if (existing) return existing;
      classes[globalId] = store!.entities.getTypeName(expressId);
      return (boxes[globalId] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    };
    for (const mesh of model.geometryResult?.meshes ?? []) {
      meshCount++;
      triangles += mesh.indices.length / 3;
      colours.set(mesh.color.join(','), [...mesh.color]);
      const [ox, oy, oz] = mesh.origin ?? [0, 0, 0];
      const positions = mesh.positions;
      // A colour-merged batch carries one entity per vertex; an ordinary mesh
      // is one entity whole. Reading `entityIds` where it exists keeps a
      // merged batch from pooling several elements into one box, which is
      // exactly what the renderer's own per-entity box cannot do.
      const perVertex = mesh.entityIds;
      const perEntity = perVertex ? new Map<number, WorldBox | null>() : null;
      const own = perVertex ? null : boxFor(mesh.expressId);
      // An ordinary mesh whose entity carries no GlobalId has nothing to widen.
      if (!perVertex && !own) continue;
      // Walk the indices, not the vertex buffer: a vertex no triangle uses is
      // not drawn, so it must not widen the box the overlay compares.
      for (const vertex of mesh.indices) {
        const i = vertex * 3;
        let box = own;
        if (perVertex) {
          const id = perVertex[vertex];
          if (!perEntity!.has(id)) perEntity!.set(id, boxFor(id));
          box = perEntity!.get(id)!;
        }
        if (!box) continue;
        const x = positions[i] + ox, y = positions[i + 1] + oy, z = positions[i + 2] + oz;
        if (x < box[0]) box[0] = x;
        if (y < box[1]) box[1] = y;
        if (z < box[2]) box[2] = z;
        if (x > box[3]) box[3] = x;
        if (y > box[4]) box[4] = y;
        if (z > box[5]) box[5] = z;
      }
    }
    // An entity whose whole mesh set went to the GPU-instanced shard is absent
    // from `meshes` and carries its world box here instead (`MeshData.origin`
    // and the RTC offset already folded in). Without these, FZK's 42 instanced
    // balustrade members would read as geometry the IFC does not have.
    let instancedBoxes = 0;
    for (const [globalExpressId, aabb] of model.geometryResult?.instancedGeometryAabbs ?? []) {
      if (![...aabb.min, ...aabb.max].every((value) => Number.isFinite(value))) continue;
      const box = boxFor(globalExpressId);
      if (!box) continue;
      if (!Number.isFinite(box[0])) instancedBoxes++;
      // Unioned, not assigned: the map is documented as holding entities whose
      // WHOLE mesh set went to the instanced shard, but a partly instanced
      // entity would otherwise come back with only the half that drew meshes.
      for (let axis = 0; axis < 3; axis++) {
        box[axis] = Math.min(box[axis], aabb.min[axis]);
        box[axis + 3] = Math.max(box[axis + 3], aabb.max[axis]);
      }
    }
    // A box nothing ever widened is not a comparison, it is an absence: both
    // sides being all-Infinity makes every gap NaN, which no tolerance catches.
    for (const [globalId, box] of Object.entries(boxes)) {
      if (Number.isFinite(box[0])) continue;
      delete boxes[globalId];
      delete classes[globalId];
    }
    for (const cloud of model.geometryResult?.pointClouds ?? []) {
      const rgb = [...(cloud.chunk.colors ?? []).slice(0, 3)];
      if (rgb.length === 3) colours.set(`cloud:${rgb.join(',')}`, rgb);
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
      instancedBoxes,
      boxes,
      classes,
      colours: [...colours.values()],
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

/** How many models the viewer holds, without walking any geometry. */
export async function modelCount(page: Page): Promise<number> {
  return page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().models.size);
}

/** Each loaded model's `loadPath`, without walking any geometry. */
export async function loadPaths(page: Page): Promise<(string | null)[]> {
  return page.evaluate(() => [...globalThis.__ifc_lite_viewer_store__.getState().models.values()]
    .map((model) => model.loadPath ?? null));
}

export interface Overlay {
  /** GlobalIds that drew geometry in both models. */
  matched: string[];
  /** GlobalIds boxed in the first model only, and in the second only. */
  onlyFirst: string[];
  onlySecond: string[];
  /** The worst single corner-coordinate gap over every matched entity, in metres. */
  worstGap: number;
  /** The matched entity, axis and corner that gap sits on. */
  worstAt: { globalId: string; axis: 'x' | 'y' | 'z'; corner: 'min' | 'max'; first: number; second: number } | null;
  /** The worst gap per axis, so a swapped or flipped up axis is named rather than merely large. */
  perAxis: { x: number; y: number; z: number };
}

const AXES = ['x', 'y', 'z'] as const;

/**
 * Compare two models' per-GlobalId world boxes: the same place, the same size
 * and the same up axis all fail here as a corner gap, and the axis the worst
 * gap sits on says which.
 */
export function overlayOf(first: ModelSnapshot, second: ModelSnapshot): Overlay {
  const matched = Object.keys(first.boxes).filter((globalId) => second.boxes[globalId]);
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
    onlyFirst: Object.keys(first.boxes).filter((globalId) => !second.boxes[globalId]),
    onlySecond: Object.keys(second.boxes).filter((globalId) => !first.boxes[globalId]),
    worstGap,
    worstAt,
    perAxis,
  };
}

/** The viewer, loaded and instrumented, with nothing opened yet. */
async function openViewer(page: Page): Promise<Journey> {
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

/** The viewer with `file` opened from disk the way a user opens it. */
export async function openViewerWith(page: Page, file: string, stage: string): Promise<Journey> {
  const journey = await openViewer(page);
  await journey.gpu.raceLoss(stage, async () => {
    await page.locator('#file-input-open').setInputFiles(file);
    await waitForModels(page, 1);
  });
  return journey;
}

/** Wait until exactly `count` models are loaded, settled and carrying geometry. */
export async function waitForModels(page: Page, count: number): Promise<void> {
  await page.waitForFunction((n) => {
    const state = globalThis.__ifc_lite_viewer_store__?.getState();
    if (!state) return false;
    return state.models.size === n && !state.loading && !state.geometryStreamingActive &&
      [...state.models.values()].every((model) => model.ifcDataStore &&
        ((model.geometryResult?.meshes.length ?? 0) > 0 || (model.geometryResult?.pointClouds?.length ?? 0) > 0));
  }, count, { timeout: STEP_TIMEOUT_MS });
}

/** Run `export:3dm` from the command palette and return the Rhino dialog. */
export async function openRhinoExportDialog(page: Page): Promise<Locator> {
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
export async function chooseExportOption(page: Page, dialog: Locator, label: string, option: string): Promise<void> {
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
  if (coordinates === 'world') await chooseExportOption(page, dialog, 'Coordinates', 'World (as in the IFC file)');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: STEP_TIMEOUT_MS }),
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

/** One entity of `modelId` by its IFC GlobalId, with the class and ids it carries. */
export async function entityByGlobalId(page: Page, modelId: string, globalId: string):
Promise<{ expressId: number; globalExpressId: number; ifcClass: string; name: string } | null> {
  return page.evaluate(({ id, wanted }) => {
    const model = globalThis.__ifc_lite_viewer_store__.getState().models.get(id)!;
    const store = model.ifcDataStore!;
    for (const expressId of store.entities.expressId) {
      if (!expressId || store.entities.getGlobalId(expressId) !== wanted) continue;
      return {
        expressId,
        globalExpressId: expressId + model.idOffset,
        ifcClass: store.entities.getTypeName(expressId),
        name: store.entities.getName(expressId),
      };
    }
    return null;
  }, { id: modelId, wanted: globalId });
}

/** The property sets the store answers for one entity, as the panel reads them. */
export async function propertySets(page: Page, modelId: string, expressId: number): Promise<Record<string, Record<string, string>>> {
  return page.evaluate(({ id, entity }) => {
    const store = globalThis.__ifc_lite_viewer_store__.getState().models.get(id)!.ifcDataStore!;
    const out: Record<string, Record<string, string>> = {};
    for (const set of store.getProperties(entity)) {
      out[set.name] = Object.fromEntries(set.properties.map((property) => [property.name, String(property.value)]));
    }
    return out;
  }, { id: modelId, entity: expressId });
}

/** What the viewer currently hides in `modelId`: every entity, by federated id. */
export async function hidden(page: Page, modelId: string): Promise<{ globalExpressId: number; ifcClass: string; name: string }[]> {
  return page.evaluate((id) => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const model = state.models.get(id)!;
    const store = model.ifcDataStore!;
    // `hiddenEntities` spans the federation, so an id outside this model's
    // own range would resolve against the wrong entity table.
    return [...state.hiddenEntities]
      .filter((globalExpressId) => globalExpressId > model.idOffset && globalExpressId <= model.idOffset + model.maxExpressId)
      .map((globalExpressId) => {
        const expressId = globalExpressId - model.idOffset;
        return { globalExpressId, ifcClass: store.entities.getTypeName(expressId), name: store.entities.getName(expressId) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, modelId);
}
