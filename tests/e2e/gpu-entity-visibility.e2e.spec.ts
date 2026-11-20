/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10264 S2 hardware acceptance: hide, isolate and storey isolation draw a
 * partly hidden colour batch whole and discard its hidden entities on the GPU
 * (colour and shadow passes), instead of cutting a sub-batch from the CPU copy
 * of the geometry. (Type visibility is not covered: it filters the mesh list
 * before upload, see docs/architecture/viewer-cpu-geometry.md.)
 *
 * Oracle: the frame the old CPU path drew is the frame of the visible pieces
 * alone. So each scenario captures the production colour frame (A), then
 * removes every hidden flat piece from the scene and rebuilds its batches,
 * keeping the same visibility and view, and captures again (B). A must equal
 * B: same visible colour, selection highlight, shadow and section cut, no
 * hidden entity drawn, no visible batchmate missing. A third frame without the
 * filter (C) must differ from A, so the comparison is not vacuous. Picks under
 * the same visibility must never return a hidden entity.
 *
 * Grid axes, annotation text and structural glyphs are off for every test
 * (`open()`): they load in idle time after the model and raced the captures
 * (#10853). The cost is that IfcAnnotation/IfcGrid meshes are not uploaded,
 * so no scenario here exercises them as hidden or visible batchmates.
 *
 * #10767 (last test) uses its own oracle: after a model move, the frame with
 * instanced state carried through the move must equal the frame with the same
 * state written again at the moved position.
 *
 * Opt-in: GPU_PICK_PARITY=1 on a real WebGPU adapter (gpu-batch-pick.config.ts).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { startViewerDevServer, type ViewerDevServer } from './viewer-dev-server.js';

const FIXTURES = {
  institute: 'tests/models/ara3d/C20-Institute-Var-2.ifc',
  duplex: 'tests/models/ara3d/duplex.ifc',
  georef: 'tests/models/ara3d/ISSUE_098_R8_F1_MAB_AR_M3_XX_XXX_MO_7000.IFC',
  tower: 'tests/models/ara3d/ISSUE_053_20181220Holter_Tower_10.ifc',
};
const LOAD_TIMEOUT = 300_000;

interface Visibility { hiddenIds: number[]; isolatedIds: number[] | null }
interface Diff { width: number; height: number; differing: number; strong: number; maxChannel: number; diffPng: string }
interface PickRow { gpu: { expressId: number } | null; cpu: { expressId: number } | null; annotation: boolean }
interface SceneHandle {
  getAllMeshDataExpressIds(): number[];
  isInstancedEntity(id: number): boolean;
  getBatchedMeshes(): Array<{ quantized?: unknown }>;
  removeMeshesForEntities(ids: Iterable<number>): number;
  rebuildPendingBatches(device: unknown, pipeline: unknown): void;
  releaseGeometryData(): void;
  getMeshDataPieces(id: number): unknown[] | undefined;
  getInstancedEntityIds(): Iterable<number>;
}
interface RendererHandle { getScene(): SceneHandle; requestRender(): void; device: { getDevice(): unknown }; pipeline: unknown }
type Store = { getState(): Record<string, unknown> & {
  loading: boolean; geometryStreamingActive: boolean; models: Map<string, { idOffset: number; ifcDataStore?: { entityIndex: { byType: Map<string, number[]> } } }>;
  hideEntities(ids: number[]): void; isolateEntities(ids: number[]): void; showAll(): void; clearIsolation(): void;
  setStoreysSelection(ids: number[]): void; setGhostExceptEntities(ids: Set<number> | null): void; setSelectedEntityId(id: number | null): void;
  setEnvShadowsEnabled(enabled: boolean): void;
  setSectionPlaneAxis(axis: 'down' | 'front' | 'side'): void; setSectionPlanePosition(position: number): void; setSectionPlaneEnabled(enabled: boolean): void;
} };
type ProbeWindow = typeof globalThis & {
  __ifc_lite_viewer_store__?: Store;
  __ifc_lite_scene_settled__?: () => boolean;
  __ifc_lite_capture_color_frame__?: () => Promise<string | null>;
  __ifc_lite_render_visibility__?: () => Visibility;
  __ifc_lite_pick_parity__?: (request: { columns: number; rows: number }) => Promise<{ rows: PickRow[] }>;
  __IFC_LITE_QUANTIZED?: number;
};

let server: ViewerDevServer | undefined;
test.skip(process.env.GPU_PICK_PARITY !== '1', 'Set GPU_PICK_PARITY=1 on a real WebGPU adapter; CI SwiftShader is not acceptance evidence.');
test.beforeAll(async () => { server = await startViewerDevServer('gpu-entity-visibility'); });
test.afterAll(async () => { await server?.close(); });

async function open(page: Page, quantized = true): Promise<void> {
  // Grid axes, annotation text and structural glyphs load after the model, in idle time, and can
  // land between two captures (#10853). No test here is about them, so they are off for all.
  await page.addInitScript(() => {
    for (const key of ['ifc-lite-ifc-annotations-visible', 'ifc-lite-ifc-grid-visible', 'ifc-lite-structural-glyphs-visible']) localStorage.setItem(key, 'false');
  });
  if (!quantized) await page.addInitScript(() => { (globalThis as ProbeWindow).__IFC_LITE_QUANTIZED = 0; });
  await page.goto(server!.url);
  await page.waitForFunction(() => Boolean((globalThis as ProbeWindow).__ifc_lite_viewer_store__), null, { timeout: 120_000 });
}

async function load(page: Page, file: string, count: number): Promise<void> {
  test.skip(!existsSync(join(process.cwd(), file)), `${file} missing — run \`pnpm fixtures\``);
  await page.locator(count === 1 ? '#file-input-open' : '#file-input-add').setInputFiles(join(process.cwd(), file));
  await page.waitForFunction((expected) => {
    const g = globalThis as ProbeWindow;
    const s = g.__ifc_lite_viewer_store__?.getState();
    return Boolean(s && !s.loading && !s.geometryStreamingActive && s.models.size === expected && g.__ifc_lite_scene_settled__?.()
      && g.__ifc_lite_capture_color_frame__ && g.__ifc_lite_pick_parity__);
  }, count, { timeout: LOAD_TIMEOUT, polling: 250 });
  await settle(page);
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    let n = 0;
    const tick = () => (++n >= 20 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }));
}

/**
 * One store call. `ids` passes the scenario's ids as an array, `set` as a
 * Set, `set0` the first as a Set, `rest` all but the first, `id0`/`id1` one
 * of them, `none` null; anything else is passed as given.
 */
type Step = [method: string, ...args: Array<'ids' | 'set' | 'id0' | 'id1' | 'set0' | 'rest' | 'none' | boolean | number | string>];

async function act(page: Page, steps: Step[], ids: number[] = []): Promise<void> {
  await page.evaluate(([list, a]) => {
    const store = (globalThis as ProbeWindow).__ifc_lite_viewer_store__!.getState() as unknown as Record<string, (...args: unknown[]) => void>;
    const value = (arg: unknown): unknown => {
      switch (arg) {
        case 'ids': return a;
        case 'set': return new Set(a);
        case 'set0': return new Set(a.slice(0, 1));
        case 'rest': return a.slice(1);
        case 'id0': return a[0];
        case 'id1': return a[1];
        case 'none': return null;
        default: return arg;
      }
    };
    for (const [method, ...args] of list) store[method]!(...args.map(value));
  }, [steps, ids] as const);
  await settle(page);
}

async function capture(page: Page, info: TestInfo, name: string, attach = true): Promise<string> {
  const png = await page.evaluate(() => (globalThis as ProbeWindow).__ifc_lite_capture_color_frame__!());
  expect(png, `${name}: the renderer returned its colour frame`).toBeTruthy();
  if (attach) await info.attach(`${name}.png`, { body: Buffer.from(png!.split(',')[1]!, 'base64'), contentType: 'image/png' });
  return png!;
}

/** Per-pixel comparison of two captured frames, in the page. */
async function diff(page: Page, a: string, b: string): Promise<Diff> {
  return page.evaluate(async ([x, y]) => {
    const pixels = async (url: string) => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, bitmap.width, bitmap.height);
    };
    const [p, q] = await Promise.all([pixels(x), pixels(y)]);
    if (p.width !== q.width || p.height !== q.height) throw new Error(`frames differ in size: ${p.width}x${p.height} vs ${q.width}x${q.height}`);
    const out = new ImageData(p.width, p.height);
    let differing = 0;
    let strong = 0;
    let maxChannel = 0;
    for (let i = 0; i < p.data.length; i += 4) {
      const d = Math.max(Math.abs(p.data[i]! - q.data[i]!), Math.abs(p.data[i + 1]! - q.data[i + 1]!), Math.abs(p.data[i + 2]! - q.data[i + 2]!));
      maxChannel = Math.max(maxChannel, d);
      if (d > 48) strong++;
      if (d > 2) { differing++; out.data[i] = 255; out.data[i + 3] = 255; } else { out.data[i] = out.data[i + 1] = out.data[i + 2] = p.data[i]! >> 2; out.data[i + 3] = 255; }
    }
    const canvas = new OffscreenCanvas(p.width, p.height);
    canvas.getContext('2d')!.putImageData(out, 0, 0);
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { width: p.width, height: p.height, differing, strong, maxChannel, diffPng: `data:image/png;base64,${btoa(binary)}` };
  }, [a, b] as const);
}

/** The flat entities the current visibility hides (the pieces the old CPU path left out). */
async function hiddenFlat(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    const g = globalThis as ProbeWindow;
    const module = '/src/hooks/useBCF.ts'; // the dev server's own module instance
    const { getGlobalRenderer }: { getGlobalRenderer(): RendererHandle | null } = await import(module);
    const v = g.__ifc_lite_render_visibility__!();
    const hidden = new Set(v.hiddenIds);
    const isolated = v.isolatedIds ? new Set(v.isolatedIds) : null;
    return getGlobalRenderer()!.getScene().getAllMeshDataExpressIds().filter((id) => hidden.has(id) || (isolated !== null && !isolated.has(id)));
  });
}

/**
 * Reference frame: drop the hidden flat pieces from the scene and rebuild
 * their batches, same visibility. Entities that also have instanced
 * occurrences are kept (their flat pieces stay under the GPU test): removing
 * one hides its occurrences by flag but forgets them in the scene's hidden
 * set, and the perspective fast path then draws them again. Returns how many
 * such mixed entities stayed.
 */
async function removePieces(page: Page, ids: number[]): Promise<number> {
  const kept = await page.evaluate(async (hidden) => {
    const module = '/src/hooks/useBCF.ts';
    const { getGlobalRenderer }: { getGlobalRenderer(): RendererHandle | null } = await import(module);
    const renderer = getGlobalRenderer()!;
    const scene = renderer.getScene();
    const flatOnly = hidden.filter((id) => !scene.isInstancedEntity(id));
    scene.removeMeshesForEntities(flatOnly);
    scene.rebuildPendingBatches(renderer.device.getDevice(), renderer.pipeline);
    renderer.requestRender();
    return hidden.length - flatOnly.length;
  }, ids);
  await settle(page);
  return kept;
}

async function picksNeverHidden(page: Page, info: TestInfo, name: string, hidden: number[], cpuExact = true): Promise<number> {
  const report = await page.evaluate(() => (globalThis as ProbeWindow).__ifc_lite_pick_parity__!({ columns: 40, rows: 24 }));
  await info.attach(`${name}-picks.json`, { body: JSON.stringify(report), contentType: 'application/json' });
  const set = new Set(hidden);
  const mesh = report.rows.filter((r) => !r.annotation);
  expect(mesh.filter((r) => r.gpu && set.has(r.gpu.expressId)), `${name}: no hidden entity is picked`).toEqual([]);
  const both = mesh.filter((r) => r.gpu && r.cpu);
  expect(mesh.filter((r) => r.gpu).length, `${name}: the grid lands on visible geometry`).toBeGreaterThan(0);
  if (!cpuExact) return both.length; // a released scene's CPU raycast has boxes only
  expect(both.length, `${name}: the grid compares actual GPU and CPU hits`).toBeGreaterThan(0);
  expect(mesh.filter((r) => r.gpu && !r.cpu), `${name}: no GPU-only hits`).toEqual([]);
  expect(mesh.filter((r) => r.cpu && !r.gpu), `${name}: no CPU-only hits`).toEqual([]);
  // Ties between coincident surfaces are S1's documented tolerance; anything more is a visibility bug.
  expect(both.filter((r) => r.gpu!.expressId !== r.cpu!.expressId).length, `${name}: GPU and CPU pick the same visible entity`).toBeLessThanOrEqual(Math.ceil(both.length * 0.02));
  return both.length;
}

interface Scenario { name: string; steps: Step[]; ids?: (page: Page) => Promise<number[]>; independent?: boolean }

/** Capture A (GPU visibility), check picks, capture B (pieces removed), compare; C is the unfiltered frame. */
async function compareScenario(page: Page, info: TestInfo, scenario: Scenario, unfiltered: string): Promise<Record<string, unknown>> {
  const ids = scenario.ids ? await scenario.ids(page) : [];
  await act(page, scenario.steps, ids);
  const hidden = await hiddenFlat(page);
  expect(hidden.length, `${scenario.name}: the scenario hides flat geometry`).toBeGreaterThan(0);
  const a = await capture(page, info, `${scenario.name}-A-gpu-visibility`);
  const picked = await picksNeverHidden(page, info, scenario.name, hidden);
  const mixedKept = await removePieces(page, hidden);
  if (scenario.independent) expect(mixedKept, `${scenario.name}: every hidden flat piece is removed from the reference`).toBe(0);
  // Removal rebuilds batches but leaves the instanced occurrences' hidden flags
  // as they were; clear and re-apply the scenario so B gets them from scratch.
  await act(page, [['showAll'], ['clearStoreySelection'], ['setGhostExceptEntities', 'none']]);
  await act(page, scenario.steps, ids);
  const b = await capture(page, info, `${scenario.name}-B-visible-pieces-only`);
  const ab = await diff(page, a, b);
  const ac = await diff(page, a, unfiltered);
  await info.attach(`${scenario.name}-A-vs-B-diff.png`, { body: Buffer.from(ab.diffPng.split(',')[1]!, 'base64'), contentType: 'image/png' });
  const row = { scenario: scenario.name, hiddenFlat: hidden.length, mixedKept, picksCompared: picked, pixels: ab.width * ab.height,
    differingAB: ab.differing, strongAB: ab.strong, maxChannelAB: ab.maxChannel, differingAC: ac.differing, strongAC: ac.strong };
  await info.attach(`${scenario.name}.json`, { body: JSON.stringify(row, null, 2), contentType: 'application/json' });
  const pixels = ab.width * ab.height;
  expect(ac.strong, `${scenario.name}: the filter changed the frame (not a vacuous comparison)`).toBeGreaterThan(200);
  // Geometry present in one frame and absent in the other moves a pixel far
  // (>48/255). The reference rebuilds the batches it removed pieces from,
  // which reorders overlapping translucent draws: a faint blend difference,
  // bounded separately and reported.
  expect(ab.strong, `${scenario.name}: GPU visibility draws what the visible pieces alone draw`).toBeLessThanOrEqual(Math.ceil(pixels * 0.0005));
  expect(ab.differing, `${scenario.name}: translucent draw-order differences only`).toBeLessThanOrEqual(Math.ceil(pixels * 0.01));
  return row;
}

async function adapter(page: Page): Promise<unknown> {
  return page.evaluate(async () => {
    const a = await navigator.gpu?.requestAdapter();
    return a ? { vendor: a.info.vendor, architecture: a.info.architecture, description: a.info.description } : null;
  });
}

const firstStorey = async (page: Page): Promise<number[]> => page.evaluate(() => {
  const s = (globalThis as ProbeWindow).__ifc_lite_viewer_store__!.getState();
  const [model] = [...s.models.values()];
  const storeys = model?.ifcDataStore?.entityIndex.byType.get('IFCBUILDINGSTOREY') ?? [];
  return storeys.slice(0, 1).map((id) => id + (model?.idOffset ?? 0));
});

/** The three flat entities the unfiltered pick grid hits most: on screen by construction. */
const spreadIds = async (page: Page, minId = 0, count = 3): Promise<number[]> => {
  const report = await page.evaluate(() => (globalThis as ProbeWindow).__ifc_lite_pick_parity__!({ columns: 40, rows: 24 }));
  const flat = new Set(await page.evaluate(async () => {
    const module = '/src/hooks/useBCF.ts';
    const { getGlobalRenderer }: { getGlobalRenderer(): RendererHandle | null } = await import(module);
    return getGlobalRenderer()!.getScene().getAllMeshDataExpressIds();
  }));
  const tally = new Map<number, number>();
  for (const r of report.rows) if (!r.annotation && r.gpu && r.gpu.expressId >= minId && flat.has(r.gpu.expressId)) tally.set(r.gpu.expressId, (tally.get(r.gpu.expressId) ?? 0) + 1);
  const ids = [...tally].sort((x, y) => y[1] - x[1]).slice(0, count).map(([id]) => id);
  expect(ids.length, 'the grid meets the required flat entities').toBe(count);
  return ids;
};

const SCENARIOS: Scenario[] = [
  { name: 'hide-with-shadows-and-selection', independent: true, ids: spreadIds, steps: [['setEnvShadowsEnabled', true], ['setSelectedEntityId', 'id0'], ['hideEntities', 'rest']] },
  { name: 'isolate-three', ids: spreadIds, steps: [['isolateEntities', 'ids']] },
  { name: 'storey-isolation', ids: firstStorey, steps: [['setStoreysSelection', 'ids']] },
  { name: 'xray-with-hide', independent: true, ids: spreadIds, steps: [['setGhostExceptEntities', 'set0'], ['hideEntities', 'rest']] },
  { name: 'section-with-hide', independent: true, ids: spreadIds, steps: [['setSectionPlaneAxis', 'down'], ['setSectionPlanePosition', 43], ['setSectionPlaneEnabled', true], ['hideEntities', 'ids']] },
];

for (const quantized of [true, false]) {
  for (const scenario of SCENARIOS) {
    if (!quantized && scenario.name !== 'isolate-three' && scenario.name !== 'hide-with-shadows-and-selection') continue;
    test(`C20-Institute ${quantized ? 'quantized' : 'f32'}: ${scenario.name} draws what the visible pieces draw (#10264 S2)`, async ({ page }, info) => {
      await open(page, quantized);
      await load(page, FIXTURES.institute, 1);
      await info.attach('adapter.json', { body: JSON.stringify(await adapter(page)), contentType: 'application/json' });
      const batches = await page.evaluate(async () => {
        const module = '/src/hooks/useBCF.ts';
        const { getGlobalRenderer }: { getGlobalRenderer(): RendererHandle | null } = await import(module);
        const all = getGlobalRenderer()!.getScene().getBatchedMeshes();
        return { total: all.length, quantized: all.filter((b) => b.quantized).length };
      });
      expect(batches.quantized > 0, 'batch layout follows the quantization switch').toBe(quantized);
      // C: the same view and state without the scenario's filter.
      const c = await capture(page, info, `${scenario.name}-C-unfiltered`);
      await compareScenario(page, info, scenario, c);
    });
  }
}

test('federation (two models): hide in the second model draws what the visible pieces draw (#10264 S2)', async ({ page }, info) => {
  await open(page);
  await load(page, FIXTURES.institute, 1);
  await load(page, FIXTURES.duplex, 2);
  const second = await page.evaluate(() => [...(globalThis as ProbeWindow).__ifc_lite_viewer_store__!.getState().models.values()].map((m) => m.idOffset));
  await info.attach('models.json', { body: JSON.stringify(second), contentType: 'application/json' });
  const c = await capture(page, info, 'federation-C-unfiltered');
  await compareScenario(page, info, { name: 'federation-hide', independent: true, steps: [['hideEntities', 'ids']], ids: async (p) => {
    const offsets = second.slice().sort((x, y) => x - y);
    expect(offsets).toHaveLength(2);
    const targets = await spreadIds(p, offsets[1]!, 2);
    expect(targets, 'the federation scenario must hide two distinct second-model entities').toHaveLength(2);
    return targets;
  } }, c);
});

test('georeferenced model at ~5,000 km: isolate draws what the visible pieces draw (#10264 S2)', async ({ page }, info) => {
  await open(page);
  await load(page, FIXTURES.georef, 1);
  const c = await capture(page, info, 'georef-C-unfiltered');
  await compareScenario(page, info, { name: 'georef-isolate', steps: [['isolateEntities', 'ids']], ids: spreadIds }, c);
});

test('after the scene releases its CPU geometry, hide and isolate draw the same frame (#10264 S2)', async ({ page }, info) => {
  await open(page);
  await load(page, FIXTURES.institute, 1);
  const ids = await spreadIds(page);
  await act(page, [['setEnvShadowsEnabled', true], ['hideEntities', 'ids']], ids);
  const before = await capture(page, info, 'released-hide-before-release');
  const released = await page.evaluate(async (probe) => {
    const module = '/src/hooks/useBCF.ts';
    const { getGlobalRenderer }: { getGlobalRenderer(): RendererHandle | null } = await import(module);
    const renderer = getGlobalRenderer()!;
    renderer.getScene().releaseGeometryData(); // evidence only: the viewer never releases (S4 is not enabled)
    renderer.requestRender();
    return renderer.getScene().getMeshDataPieces(probe) === undefined;
  }, ids[0]!);
  expect(released, 'the scene holds no CPU pieces to cut a subset from').toBe(true);
  await settle(page);
  const after = await capture(page, info, 'released-hide-after-release');
  const same = await diff(page, before, after);
  await info.attach('released-hide-diff.json', { body: JSON.stringify({ ...same, diffPng: undefined }), contentType: 'application/json' });
  expect(same.differing, 'the same draws, from the same buffers').toBe(0);
  await picksNeverHidden(page, info, 'released-hide', ids, false);

  // A visibility change after the release still draws the isolated entities, from their batches.
  await act(page, [['showAll'], ['isolateEntities', 'ids']], ids);
  await capture(page, info, 'released-isolate');
  await picksNeverHidden(page, info, 'released-isolate', await hiddenFlat(page), false);
});

/** Pixels that differ between `a` and `b` (> 2/255; strong > 48/255) inside the mask where `on` and `off` differ. */
async function diffWithin(page: Page, a: string, b: string, on: string, off: string): Promise<{ mask: number; differing: number; strong: number }> {
  return page.evaluate(async (urls) => {
    const data = await Promise.all(urls.map(async (url) => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob());
      const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    }));
    const [pa, pb, pon, poff] = data as [Uint8ClampedArray, Uint8ClampedArray, Uint8ClampedArray, Uint8ClampedArray];
    if (new Set(data.map((d) => d.length)).size !== 1) throw new Error('frames differ in size');
    const d = (p: Uint8ClampedArray, q: Uint8ClampedArray, i: number) => Math.max(Math.abs(p[i]! - q[i]!), Math.abs(p[i + 1]! - q[i + 1]!), Math.abs(p[i + 2]! - q[i + 2]!));
    let mask = 0, differing = 0, strong = 0;
    for (let i = 0; i < pa.length; i += 4) {
      if (d(pon, poff, i) <= 2) continue;
      mask++;
      const delta = d(pa, pb, i);
      if (delta > 2) differing++;
      if (delta > 48) strong++;
    }
    return { mask, differing, strong };
  }, [a, b, on, off]);
}

/** A still frame: wait until two frames 20 animation frames apart match. */
async function stillCapture(page: Page, info: TestInfo, name: string): Promise<string> {
  const grab = () => capture(page, info, name, false);
  let frame = await grab();
  let still = false;
  for (let i = 0; i < 20 && !still; i++) {
    await settle(page);
    const next = await grab();
    still = (await diff(page, frame, next)).differing === 0;
    frame = next;
  }
  expect(still, `${name}: the frame settles`).toBe(true);
  await info.attach(`${name}.png`, { body: Buffer.from(frame.split(',')[1]!, 'base64'), contentType: 'image/png' });
  return frame;
}

test('deleted instanced occurrences stay off the frame and the picks with nothing else hidden (#10639)', async ({ page }, info) => {
  await open(page);
  await load(page, FIXTURES.institute, 1);
  await info.attach('adapter.json', { body: JSON.stringify(await adapter(page)), contentType: 'application/json' });
  const overlays = await page.evaluate(() => {
    const visibility = (globalThis as ProbeWindow).__ifc_lite_viewer_store__!.getState().typeVisibility as Record<string, boolean>;
    return [visibility.ifcAnnotations, visibility.ifcGrid, visibility.structuralGlyphs];
  });
  expect(overlays, 'grid, annotation and glyph overlays are off').toEqual([false, false, false]);
  // Instanced-only entities: deleting them leaves no flat piece, so only the
  // instance flag (and the discarding shader) can keep them off the frame.
  const ids = await page.evaluate(async () => {
    const module = '/src/hooks/useBCF.ts';
    const { getGlobalRenderer }: { getGlobalRenderer(): RendererHandle | null } = await import(module);
    const scene = getGlobalRenderer()!.getScene();
    return [...scene.getInstancedEntityIds()].filter((id) => !scene.getMeshDataPieces(id)?.length);
  });
  expect(ids.length, 'the fixture has instanced-only entities').toBeGreaterThan(0);
  // Where those occurrences are on screen: the frame with only them isolated against an empty
  // isolation. The mask also holds their lighting footprint (shadow, AO), which is small here.
  await act(page, [['isolateEntities', 'ids']], ids);
  const only = await stillCapture(page, info, 'delete-M-occurrences-only');
  await act(page, [['clearIsolation']]);
  await act(page, [['isolateEntities', 'ids']], [2 ** 30]); // an id with no geometry: nothing is drawn
  const none = await stillCapture(page, info, 'delete-M-nothing');
  await act(page, [['clearIsolation'], ['showAll']]);

  const c = await stillCapture(page, info, 'delete-C-before');
  // B: the same occurrences hidden through the ordinary instanced hide path.
  await act(page, [['hideEntities', 'ids']], ids);
  const b = await stillCapture(page, info, 'delete-B-hidden');
  const shown = await diffWithin(page, b, c, only, none);
  await act(page, [['showAll']]);
  // A: delete them with nothing else hidden, the state #10639 drew them again in. This drives the
  // renderer's removal directly; the viewer's delete action reaches the same removeMeshesForEntities.
  await page.evaluate(async (deleted) => {
    const module = '/src/hooks/useBCF.ts';
    const { getGlobalRenderer }: { getGlobalRenderer(): RendererHandle | null } = await import(module);
    const renderer = getGlobalRenderer()!;
    renderer.getScene().removeMeshesForEntities(deleted);
    renderer.requestRender();
  }, ids);
  const a = await stillCapture(page, info, 'delete-A-deleted');
  const ab = await diff(page, a, b);
  const abInside = await diffWithin(page, a, b, only, none);
  const ac = await diffWithin(page, a, c, only, none);
  await info.attach('delete-A-vs-B-diff.png', { body: Buffer.from(ab.diffPng.split(',')[1]!, 'base64'), contentType: 'image/png' });
  const pixels = ab.width * ab.height;
  const row = { deleted: ids.length, pixels, occurrenceMask: shown.mask, occurrencesShown: shown.differing, occurrencesShownStrong: shown.strong,
    occurrencesGoneOnDelete: ac.differing, differingAB: ab.differing, strongAB: ab.strong, differingABInMask: abInside.differing };
  await info.attach('delete.json', { body: JSON.stringify(row, null, 2), contentType: 'application/json' });
  // Only instanced-occurrence pixels count toward "on screen" (#10853): hiding them must change
  // their own pixels, and so must deleting them.
  expect(shown.mask, 'the occurrence mask is non-empty').toBeGreaterThan(100);
  // The "nothing" frame must really draw nothing: then the mask is the occurrences' own footprint
  // (plus their lighting), a small part of the frame (4.8 % on Institute).
  expect(shown.mask, 'the occurrence mask is not the whole model (the empty isolation drew nothing)').toBeLessThan(pixels * 0.1);
  expect(shown.strong, 'the occurrences are on screen (hiding them strongly changes their pixels)').toBeGreaterThan(50);
  expect(ac.strong, 'deleting them strongly changes their pixels (not a vacuous comparison)').toBeGreaterThan(50);
  expect(abInside.differing, 'a deleted occurrence draws nothing a hidden one does not').toBeLessThanOrEqual(Math.floor(shown.differing * 0.05));
  // Same whole-frame bound as the S2 scenarios (compareScenario): geometry appearing moves pixels > 48/255.
  expect(ab.strong, 'and nothing else in the frame moves').toBeLessThanOrEqual(Math.ceil(pixels * 0.0005));
  await picksNeverHidden(page, info, 'deleted', ids);
  // A later visibility change must not bring them back: hide surviving instanced entities (a frame
  // renders with the instanced hidden set non-empty), then show all again, which empties it.
  const survivors = await page.evaluate(async () => {
    const module = '/src/hooks/useBCF.ts';
    const { getGlobalRenderer }: { getGlobalRenderer(): RendererHandle | null } = await import(module);
    return [...getGlobalRenderer()!.getScene().getInstancedEntityIds()].slice(0, 3);
  });
  expect(survivors.length, 'instanced entities survive the delete').toBeGreaterThan(0);
  await act(page, [['hideEntities', 'ids']], survivors);
  await stillCapture(page, info, 'delete-A2-survivors-hidden');
  await act(page, [['showAll']]);
  const a3 = await stillCapture(page, info, 'delete-A3-after-visibility-change');
  const again = await diffWithin(page, a3, b, only, none);
  expect(again.differing, 'still absent after a visibility change').toBeLessThanOrEqual(Math.floor(shown.differing * 0.05));
  expect((await diff(page, a3, b)).strong, 'and nothing else in the frame moves').toBeLessThanOrEqual(Math.ceil(pixels * 0.0005));
});

type StoreCall = [method: string, ...args: unknown[]];
/** Store calls in the page. Map and Set do not cross page.evaluate, so they travel tagged and are rebuilt there. */
async function storeCalls(page: Page, calls: StoreCall[]): Promise<void> {
  const tag = (value: unknown): unknown => value instanceof Map ? { __map: [...value].map(([k, v]) => [k, tag(v)]) }
    : value instanceof Set ? { __set: [...value] }
    : Array.isArray(value) ? value.map(tag)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, tag(v)])) : value;
  await page.evaluate((list) => {
    const untag = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(untag);
      if (!value || typeof value !== 'object') return value;
      const o = value as Record<string, unknown>;
      if ('__map' in o) return new Map((o.__map as [unknown, unknown][]).map(([k, v]) => [k, untag(v)]));
      if ('__set' in o) return new Set(o.__set as unknown[]);
      return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, untag(v)]));
    };
    const st = (globalThis as ProbeWindow).__ifc_lite_viewer_store__!.getState() as unknown as Record<string, (...a: unknown[]) => void>;
    for (const [method, ...args] of list as StoreCall[]) st[method]!(...args.map(untag));
  }, calls.map(([method, ...args]) => [method, ...args.map(tag)]));
}

/**
 * #10767 oracle: a model move re-uploads whole instance buffers, which used to
 * drop state written to the GPU only. At the MOVED position, the frame with the
 * state carried through the move (M) must equal the frame after the same state
 * is cleared and written again (R). The state must be visible before the move,
 * and the move must change the frame, so neither comparison is vacuous.
 */
test('a model move and rotation keep instanced hide, selection, colour override and X-Ray (#10767)', async ({ page }, info) => {
  await open(page);
  await load(page, FIXTURES.tower, 1);
  await info.attach('adapter.json', { body: JSON.stringify(await adapter(page)), contentType: 'application/json' });
  // Every instanced-only entity (no flat pieces): only the instance path draws them, and on the
  // tower they are the facade members, so each state moves thousands of pixels.
  const ids = await page.evaluate(async () => {
    const module = '/src/hooks/useBCF.ts';
    const { getGlobalRenderer }: { getGlobalRenderer(): RendererHandle | null } = await import(module);
    const scene = getGlobalRenderer()!.getScene();
    return [...scene.getInstancedEntityIds()].filter((id) => !scene.getMeshDataPieces(id)?.length);
  });
  expect(ids.length, 'the fixture has instanced-only entities').toBeGreaterThan(100);
  const modelId = await page.evaluate(() => [...(globalThis as ProbeWindow).__ifc_lite_viewer_store__!.getState().models.keys()][0]!);
  const states: Array<{ name: string; set: StoreCall[]; clear: StoreCall[] }> = [
    { name: 'hide', set: [['hideEntities', ids]], clear: [['showAll']] },
    { name: 'select', set: [['setSelectedEntityIds', ids]], clear: [['setSelectedEntityIds', []]] },
    // The overlay compositor is the shared colour-override path (lens, animation, compare). Single model, idOffset 0.
    { name: 'colour', set: [['registerOverlayLayer', { id: 'e2e-10767', priority: 50, hiddenIds: null, colorOverrides: new Map(ids.map((id) => [id, [1, 0, 0, 1]])) }]],
      clear: [['removeOverlayLayer', 'e2e-10767']] },
    { name: 'xray', set: [['setGhostExceptEntities', new Set<number>()]], clear: [['setGhostExceptEntities', null]] },
  ];
  // A move draws a preview frame before it is applied, as during a drag.
  const moves: Record<'move' | 'rotate', { preview: StoreCall[]; apply: StoreCall[] }> = {
    move: { preview: [['openReposition', [modelId]], ['previewModelTranslation', [5, 0, 0]]], apply: [['applyModelTranslation'], ['closeReposition']] },
    rotate: { preview: [['setModelRotation', [modelId], { angle: Math.PI / 2, pivot: [0, 0, 0] }]], apply: [] },
  };
  const rows: Record<string, unknown>[] = [];
  const check = async (name: string, state: { set: StoreCall[]; clear: StoreCall[] }, kind: 'move' | 'rotate') => {
    const plain = await stillCapture(page, info, `${name}-0-plain`);
    await storeCalls(page, state.set);
    try {
      const before = await stillCapture(page, info, `${name}-1-state`);
      const shown = await diff(page, before, plain);
      await storeCalls(page, moves[kind].preview);
      await settle(page);
      await storeCalls(page, moves[kind].apply);
      const carried = await stillCapture(page, info, `${name}-2-moved-carried`);
      const moved = await diff(page, carried, before);
      await storeCalls(page, state.clear);
      const movedPlain = await stillCapture(page, info, `${name}-3-moved-cleared`);
      await storeCalls(page, state.set);
      const rewritten = await stillCapture(page, info, `${name}-4-moved-rewritten`);
      const visible = await diff(page, rewritten, movedPlain);
      const lost = await diff(page, carried, rewritten);
      await info.attach(`${name}-carried-vs-rewritten-diff.png`, { body: Buffer.from(lost.diffPng.split(',')[1]!, 'base64'), contentType: 'image/png' });
      rows.push({ name, shownDiffering: shown.differing, movedDiffering: moved.differing, visibleAfterMove: visible.differing, lostDiffering: lost.differing, lostStrong: lost.strong });
      expect(shown.differing, `${name}: the state is on screen`).toBeGreaterThan(200);
      expect(moved.differing, `${name}: the move changed the frame`).toBeGreaterThan(1000);
      expect(visible.differing, `${name}: the state is still on screen after the move`).toBeGreaterThan(200);
      // Losing the state repaints thousands of facade pixels; allow only edge noise.
      expect(lost.differing, `${name}: the moved frame keeps the state (carried = rewritten)`).toBeLessThanOrEqual(50);
    } finally {
      await storeCalls(page, [...state.clear, ['undoModelTranslation']]);
      await settle(page);
    }
  };
  for (const kind of ['move', 'rotate'] as const) for (const state of states) await check(`${kind}-${state.name}`, state, kind);
  await info.attach('move.json', { body: JSON.stringify({ instancedOnly: ids.length, rows }, null, 2), contentType: 'application/json' });
});
