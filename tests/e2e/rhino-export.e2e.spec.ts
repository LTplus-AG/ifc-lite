/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Real-browser journey for the Rhino `.3dm` export
 * (spec: docs/architecture/rhino-3dm-export.md).
 *
 * Unit tests run the dialog against an in-process fake worker and the adapter
 * in Node. This drives the built viewer the way a user does: open a model from
 * disk, run `export:3dm` from the command palette, click Export, and read the
 * downloaded bytes back with McNeel's rhino3dm in Node. It is the only test
 * that proves the Vite worker chunk, the wasm scene builder inside it and the
 * lazily fetched rhino3dm wasm work together in a browser.
 *
 * The export is CPU-only (Web Worker + wasm). Only the model load touches the
 * GPU, so the load is raced against hosted-GPU device loss like the other
 * viewer specs, and device-loss console lines are not counted as export errors
 * under `E2E_GPU_STRICT=0`.
 */

import { test, expect, type Page, type Request } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEVICE_LOST_SIGNAL, GPU_STRICT, watchGpuDeviceLoss } from './gpu-device-loss';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
// Git-tracked copy of the Archicad house: project, site, building and two
// storeys with walls, slabs, windows and spaces, so every layer level is real.
const MODEL = join(ROOT, 'apps/viewer/public/_fixtures/AC20-FZK-Haus.ifc');
const PROJECT = 'Projekt-FZK-Haus';
const IFC_GUID = /^[0-9A-Za-z_$]{22}$/;
/** The lazily loaded rhino3dm runtime: its wasm and its emscripten JS chunk. */
const RHINO3DM_ASSET = /\/assets\/rhino3dm[^/]*\.(wasm|js)(\?|$)/;

// English labels below: pin the browser language the viewer's Auto locale follows (#9061).
test.use({ locale: 'en-US' });

interface RhinoRuntime {
  File3dm: { fromByteArray(bytes: Uint8Array): Rhino3dmFile | null };
  UnitSystem: Record<string, unknown>;
}
interface Rhino3dmFile {
  archiveVersion: number;
  settings(): { modelUnitSystem: unknown };
  layers(): { count: number; get(i: number): { fullPath: string } };
  objects(): { count: number; get(i: number): Rhino3dmObject };
  strings(): { count: number; get(i: number): [string, string] };
  delete(): void;
}
interface Rhino3dmObject {
  attributes(): { layerIndex: number; getUserString(key: string): string | null };
  geometry(): { getBoundingBox?(accurate: boolean): { min: number[]; max: number[]; delete(): void } } & { constructor: { name: string } };
}

let runtime: Promise<RhinoRuntime> | undefined;
/** rhino3dm is a dependency of @ifc-lite/rhino3dm, not of the repo root. */
function loadRhino(): Promise<RhinoRuntime> {
  const require = createRequire(join(ROOT, 'packages/rhino3dm/package.json'));
  const factory = require('rhino3dm') as () => Promise<RhinoRuntime>;
  return (runtime ??= factory());
}

interface ReadBack {
  archiveVersion: number;
  unitSystem: string;
  layerPaths: string[];
  objectCount: number;
  documentStrings: Record<string, string>;
  /** One entry per object: its layer path and the user text this spec reads. */
  objects: { layer: string; globalId: string | null; ifcClass: string | null; extent: number | null }[];
}

/** Parse the downloaded bytes with rhino3dm and pull out what the assertions need. */
async function readBack(bytes: Uint8Array): Promise<ReadBack> {
  const rhino = await loadRhino();
  const file = rhino.File3dm.fromByteArray(bytes);
  if (!file) throw new Error('rhino3dm could not read the downloaded .3dm');
  try {
    const layers = file.layers();
    const layerPaths = Array.from({ length: layers.count }, (_, i) => layers.get(i).fullPath);
    const unit = file.settings().modelUnitSystem;
    const unitSystem = Object.keys(rhino.UnitSystem).find((name) => rhino.UnitSystem[name] === unit) ?? String(unit);
    const strings = file.strings();
    const documentStrings = Object.fromEntries(Array.from({ length: strings.count }, (_, i) => strings.get(i)));
    const table = file.objects();
    const objects = Array.from({ length: table.count }, (_, i) => {
      const obj = table.get(i);
      const attrs = obj.attributes();
      const geometry = obj.geometry();
      let extent: number | null = null;
      if (geometry.constructor.name === 'Mesh' && geometry.getBoundingBox) {
        const box = geometry.getBoundingBox(true);
        try { extent = Math.max(...box.max.map((v, axis) => v - box.min[axis])); } finally { box.delete(); }
      }
      return {
        layer: layerPaths[attrs.layerIndex] ?? `#${attrs.layerIndex}`,
        globalId: attrs.getUserString('IFC::GlobalId'),
        ifcClass: attrs.getUserString('IFC::Class'),
        extent,
      };
    });
    return { archiveVersion: file.archiveVersion, unitSystem, layerPaths, objectCount: table.count, documentStrings, objects };
  } finally {
    file.delete();
  }
}

interface Journey {
  page: Page;
  /** Every request the page and its workers made, in order. */
  requests: { url: string; afterExportClick: boolean; referer: string }[];
  /** Console errors and uncaught page errors, device-loss noise excluded under hosted GPU. */
  errors: string[];
}

/**
 * Open the built viewer, record requests and errors from the first byte, and
 * open the tracked AC20 house from disk the way a user does.
 */
async function openModel(page: Page): Promise<Journey & { markExportClick(): void }> {
  const journey: Journey = { page, requests: [], errors: [] };
  let exportClicked = false;
  // `context` sees dedicated-worker requests as well as the page's own.
  page.context().on('request', (request: Request) => {
    journey.requests.push({ url: request.url(), afterExportClick: exportClicked, referer: request.headers().referer ?? '' });
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (!GPU_STRICT && DEVICE_LOST_SIGNAL.test(text)) return;
    journey.errors.push(`console: ${text}`);
  });
  page.on('pageerror', (error) => journey.errors.push(`pageerror: ${error.stack ?? error.message}`));
  page.context().on('response', (response) => {
    if (response.status() >= 400) journey.errors.push(`http ${response.status()}: ${response.url()}`);
  });
  // Vercel Web Analytics is served by the Vercel edge only; `vite preview` 404s it.
  await page.route('**/_vercel/insights/script.js', (route) => route.fulfill({ contentType: 'text/javascript', body: '' }));

  await page.addInitScript(() => {
    localStorage.setItem('ifclite.extensions.privacy-disclosure.v2', 'e2e acknowledged');
    // The progress row comes and goes inside one export; record every state it showed.
    const seen: string[] = [];
    (globalThis as Record<string, unknown>).__rhinoProgress__ = seen;
    const observe = () => new MutationObserver(() => {
      for (const row of document.querySelectorAll<HTMLElement>('[data-rhino-export-progress]')) {
        const entry = `${row.dataset.rhinoExportProgress}|${row.querySelector('output')?.textContent?.trim() ?? ''}`;
        if (seen[seen.length - 1] !== entry) seen.push(entry);
      }
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    if (document.documentElement) observe();
    else document.addEventListener('DOMContentLoaded', observe);

    // React may paint only some of the worker's progress updates when the
    // write is fast, so also record what the export worker actually sent.
    const received: string[] = [];
    (globalThis as Record<string, unknown>).__rhinoWorkerProgress__ = received;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (!String(url).includes('rhinoExport.worker')) return;
        this.addEventListener('message', (event: MessageEvent) => {
          const data = event.data as { type?: string; done?: number; total?: number; phase?: string } | null;
          if (data?.type === 'progress') received.push(`${data.done}/${data.total}`);
          else if (data?.type) received.push(data.phase ? `${data.type}:${data.phase}` : data.type);
        });
      }
    };
  });

  const gpu = await watchGpuDeviceLoss(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await gpu.raceLoss('open the AC20 house for Rhino export', async () => {
    await page.goto('/');
    await page.locator('#file-input-open').setInputFiles(MODEL);
    await page.waitForFunction(() => {
      const state = (globalThis as Record<string, any>).__ifc_lite_viewer_store__?.getState();
      return state?.models.size === 1 && !state.loading && !state.geometryStreamingActive &&
        [...state.models.values()].every((m: any) => m.ifcDataStore && m.sourceFile);
    }, undefined, { timeout: 180_000 });
  });
  return { ...journey, markExportClick: () => { exportClicked = true; } };
}

/** Run `export:3dm` from the command palette and return the Rhino dialog. */
async function openRhinoDialog(page: Page) {
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
async function choose(page: Page, dialog: ReturnType<Page['getByRole']>, label: string, option: string) {
  await dialog.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: label, exact: true })).toHaveText(option);
}

/** Click Export, wait for the download and the finished dialog, return the file. */
async function exportAndDownload(journey: Journey & { markExportClick(): void }, dialog: ReturnType<Page['getByRole']>, name: string) {
  const { page } = journey;
  const started = Date.now();
  journey.markExportClick();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 180_000 }),
    dialog.getByRole('button', { name: 'Export', exact: true }).click(),
  ]);
  const path = test.info().outputPath(name);
  await download.saveAs(path);
  await expect(dialog.getByText('Success', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/^Exported Rhino \.3dm \(\d+ KB\)$/)).toBeVisible();
  const elapsedMs = Date.now() - started;
  test.info().annotations.push({ type: 'export-ms', description: String(elapsedMs) });
  const { progress, workerProgress } = await page.evaluate(() => {
    const g = globalThis as Record<string, unknown>;
    return { progress: g.__rhinoProgress__ as string[], workerProgress: g.__rhinoWorkerProgress__ as string[] };
  });
  return { download, path, bytes: new Uint8Array(await readFile(path)), progress, workerProgress, elapsedMs };
}

test.describe('Rhino .3dm export in the built viewer', () => {
  test.skip(!existsSync(MODEL), 'apps/viewer/public/_fixtures/AC20-FZK-Haus.ifc is missing');

  test('default export writes the spatial tree as layers with IFC user text', async ({ page }) => {
    const journey = await openModel(page);
    const dialog = await openRhinoDialog(page);
    expect(journey.requests.filter((r) => RHINO3DM_ASSET.test(r.url) || /rhinoExport\.worker/.test(r.url))).toEqual([]);

    // Defaults, as the user sees them before touching anything.
    await expect(dialog.getByRole('combobox', { name: 'Units', exact: true })).toHaveText('Source unit');
    await expect(dialog.getByRole('combobox', { name: 'Layers', exact: true })).toHaveText('Storey, then class');
    await expect(dialog.getByRole('combobox', { name: '3dm version', exact: true })).toHaveText('Rhino 8');
    await expect(dialog.getByText('AC20-FZK-Haus.3dm')).toBeVisible();

    const { download, path, bytes, progress, workerProgress, elapsedMs } = await exportAndDownload(journey, dialog, 'ac20-default.3dm');
    const screenshot = test.info().outputPath('rhino-export-dialog-finished.png');
    await dialog.screenshot({ path: screenshot });
    test.info().annotations.push({ type: 'screenshot', description: screenshot });
    console.log(`[rhino-export] default: ${bytes.byteLength} bytes in ${elapsedMs} ms at ${path}`);
    console.log(`[rhino-export] dialog progress ${JSON.stringify(progress)}`);
    console.log(`[rhino-export] worker messages ${JSON.stringify(workerProgress)}`);
    console.log(`[rhino-export] screenshot ${screenshot}`);
    // Exporter warnings are listed (collapsed) under the result; record their text.
    const warnings = await dialog.locator('details li').allTextContents();
    console.log(`[rhino-export] exporter warnings ${JSON.stringify(warnings)}`);

    expect(download.suggestedFilename()).toBe('AC20-FZK-Haus.3dm');
    // React may batch phase updates; require objects in the DOM and serialization on the wire.
    expect(progress.some((p) => /^objects\|Writing objects: [\d,]+ of [\d,]+$/.test(p)), JSON.stringify(progress)).toBe(true);
    expect(workerProgress).toContain('phase:serialize');
    // And the worker sent per-object progress up to the last object, in order.
    const counts = workerProgress.filter((m) => /^\d+\/\d+$/.test(m)).map((m) => m.split('/').map(Number));
    expect(counts.length, JSON.stringify(workerProgress)).toBeGreaterThan(2);
    const total = counts[0][1];
    expect(counts.every(([done, t], i) => t === total && (i === 0 || done > counts[i - 1][0]))).toBe(true);
    expect(counts[0][0]).toBe(0);
    expect(counts[counts.length - 1][0]).toBe(total);
    expect(workerProgress[workerProgress.length - 1]).toBe('complete');

    const file = await readBack(bytes);
    expect(file.archiveVersion).toBe(80);
    expect(file.unitSystem).toBe('Meters'); // AC20's project length unit is METRE
    expect(file.objectCount).toBeGreaterThan(0);
    expect(file.documentStrings['IFC::Exporter']).toMatch(/^ifc-lite /);

    const elementLayers = file.layerPaths.filter((p) => p !== 'IFC block geometry' && !p.startsWith('IFC block geometry::'));
    for (const p of elementLayers) expect(p.split('::')[0], p).toBe(PROJECT);
    const storeyWalls = file.layerPaths.filter((p) => /^Projekt-FZK-Haus::Gelaende::FZK-Haus::(Erdgeschoss|Dachgeschoss)::IfcWall/.test(p));
    expect(storeyWalls, file.layerPaths.join('\n')).not.toHaveLength(0);

    const walls = file.objects.filter((o) => storeyWalls.includes(o.layer));
    expect(walls.length).toBeGreaterThan(0);
    for (const wall of walls) {
      expect(wall.globalId, wall.layer).toMatch(IFC_GUID);
      expect(wall.ifcClass, wall.layer).toMatch(/^IfcWall/);
    }
    // Metres: a house wall spans metres, not thousands.
    const wallExtent = Math.max(...walls.map((w) => w.extent ?? 0));
    expect(wallExtent).toBeGreaterThan(1);
    expect(wallExtent).toBeLessThan(100);

    expect(journey.errors).toEqual([]);
  });

  test('millimetres, class layers and Rhino 7 arrive in the file', async ({ page }) => {
    const journey = await openModel(page);
    const dialog = await openRhinoDialog(page);
    await choose(page, dialog, 'Units', 'Millimeters');
    await choose(page, dialog, 'Layers', 'Class');
    await choose(page, dialog, '3dm version', 'Rhino 7');

    const { bytes } = await exportAndDownload(journey, dialog, 'ac20-mm-class-v7.3dm');
    const file = await readBack(bytes);
    expect(file.archiveVersion).toBe(70);
    expect(file.unitSystem).toBe('Millimeters');
    expect(file.objectCount).toBeGreaterThan(0);

    // Class scheme: <project>::<IfcClass>, no spatial levels in between.
    const elementLayers = file.layerPaths.filter((p) => p !== 'IFC block geometry' && !p.startsWith('IFC block geometry::'));
    expect(elementLayers).toContain(PROJECT);
    for (const p of elementLayers.filter((p) => p !== PROJECT)) expect(p, p).toMatch(/^Projekt-FZK-Haus::Ifc[A-Za-z]+$/);
    expect(elementLayers.some((p) => /Erdgeschoss|Gelaende|FZK-Haus::FZK-Haus/.test(p))).toBe(false);

    const walls = file.objects.filter((o) => o.layer.startsWith('Projekt-FZK-Haus::IfcWall'));
    expect(walls.length).toBeGreaterThan(0);
    for (const wall of walls) expect(wall.globalId).toMatch(IFC_GUID);
    // Millimetres: the same walls now span thousands of units.
    expect(Math.max(...walls.map((w) => w.extent ?? 0))).toBeGreaterThan(1000);

    expect(journey.errors).toEqual([]);
  });

});
