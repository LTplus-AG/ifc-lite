/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10264 S3 hardware acceptance: the selection highlight, its outline and the
 * hover outline of entities held by colour batches are drawn from those
 * batches' own GPU buffers, keeping only the highlighted entities on the GPU,
 * instead of from copies built out of the CPU pieces.
 *
 * Oracle: the copies route, which is the pre-S3 highlight (built from the CPU
 * pieces into buffers of its own) and still stands in when the batches cannot
 * draw. Each scenario captures the production frame (A, from the batches,
 * with no copy in the scene), then turns the batch route off in the page and
 * captures again (B, copies only), same state and view. A must equal B up to
 * the order of overlapping highlighted surfaces behind translucent geometry.
 * A frame without any highlight (C) must differ from A, so the comparison is
 * not vacuous. A last test releases the scene's CPU geometry and checks the
 * highlight survives it, which the copies route cannot do.
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
  // Tens of thousands of flat entities: the large-selection case.
  tower: 'tests/models/ara3d/ISSUE_053_20181220Holter_Tower_10.ifc',
};
const LOAD_TIMEOUT = 300_000;

interface Diff { width: number; height: number; differing: number; strong: number; maxChannel: number; diffPng: string }
/** A vs B against the unhighlighted frame C: pixels highlighted in one frame only, and shade-only differences inside both. */
interface Coverage { highlightedA: number; highlightedB: number; onlyA: number; onlyB: number; shadeInBoth: number; outside: number }
interface PickRow { gpu: { expressId: number } | null; annotation: boolean }
interface SceneHandle {
  getAllMeshDataExpressIds(): number[];
  isInstancedEntity(id: number): boolean;
  getBatchedMeshes(): Array<{ quantized?: unknown }>;
  getMeshes(): Array<{ hydrated?: boolean }>;
  releaseGeometryData(): void;
  getMeshDataPieces(id: number): unknown[] | undefined;
}
interface RendererHandle {
  getScene(): SceneHandle; requestRender(): void;
  pipeline: Record<string, unknown>;
  _selectionHighlight: { clear(): void };
  hoverBatches: { clear(): void };
  hoverMeshes: { pieces: unknown[] };
}
type Store = { getState(): Record<string, unknown> & {
  loading: boolean; geometryStreamingActive: boolean; models: Map<string, { idOffset: number }>;
} };
type ProbeWindow = typeof globalThis & {
  __ifc_lite_viewer_store__?: Store;
  __ifc_lite_scene_settled__?: () => boolean;
  __ifc_lite_capture_color_frame__?: () => Promise<string | null>;
  __ifc_lite_pick_parity__?: (request: { columns: number; rows: number }) => Promise<{ rows: PickRow[] }>;
  __ifc_lite_render_frame__?: () => { timestamp: number } | null;
  __IFC_LITE_QUANTIZED?: number;
};

let server: ViewerDevServer | undefined;
test.skip(process.env.GPU_PICK_PARITY !== '1', 'Set GPU_PICK_PARITY=1 on a real WebGPU adapter; CI SwiftShader is not acceptance evidence.');
test.beforeAll(async () => { server = await startViewerDevServer('gpu-entity-highlight'); });
test.afterAll(async () => { await server?.close(); });

async function open(page: Page, quantized = true): Promise<void> {
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

/** One store call per step; 'ids' passes the scenario's ids, 'id0' the first, 'set01' the first two as a Set, 'hover0' a hover state on the first. */
type Step = [method: string, ...args: Array<'ids' | 'id0' | 'rest' | 'set01' | 'hover0' | 'none' | boolean | number | string | number[]>];

async function act(page: Page, steps: Step[], ids: number[] = []): Promise<void> {
  await page.evaluate(([list, a]) => {
    const store = (globalThis as ProbeWindow).__ifc_lite_viewer_store__!.getState() as unknown as Record<string, (...args: unknown[]) => void>;
    const value = (arg: unknown): unknown => {
      switch (arg) {
        case 'ids': return a;
        case 'id0': return a[0];
        case 'rest': return a.slice(1);
        case 'set01': return new Set(a.slice(0, 2));
        case 'hover0': return { entityId: a[0], screenX: 0, screenY: 0 };
        case 'none': return null;
        default: return arg;
      }
    };
    for (const [method, ...args] of list) store[method]!(...args.map(value));
  }, [steps, ids] as const);
  await settle(page);
}

/** Turn the batch highlight route off (the copies route, pre-S3) or back on, and drop both highlight caches. */
async function route(page: Page, copies: boolean): Promise<void> {
  await page.evaluate(async (useCopies) => {
    const module = '/src/hooks/useBCF.ts'; // the dev server's own module instance
    const { getGlobalRenderer }: { getGlobalRenderer(): RendererHandle | null } = await import(module);
    const renderer = getGlobalRenderer()!;
    const pipeline = renderer.pipeline as Record<string, unknown> & { __s3Original?: unknown };
    if (useCopies) {
      pipeline.__s3Original ??= pipeline.getBatchSelectionPipeline;
      pipeline.getBatchSelectionPipeline = () => null;
    } else if (pipeline.__s3Original) {
      pipeline.getBatchSelectionPipeline = pipeline.__s3Original;
      delete pipeline.__s3Original;
    }
    renderer._selectionHighlight.clear();
    renderer.hoverBatches.clear();
    renderer.requestRender();
  }, copies);
  await settle(page);
}

/** Highlight copies built from CPU pieces: selection copies in the scene plus hover copies. */
async function copiesInScene(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const module = '/src/hooks/useBCF.ts';
    const { getGlobalRenderer }: { getGlobalRenderer(): RendererHandle | null } = await import(module);
    const renderer = getGlobalRenderer()!;
    return renderer.getScene().getMeshes().filter((m) => m.hydrated).length + renderer.hoverMeshes.pieces.length;
  });
}

async function capture(page: Page, info: TestInfo, name: string): Promise<string> {
  const png = await page.evaluate(() => (globalThis as ProbeWindow).__ifc_lite_capture_color_frame__!());
  expect(png, `${name}: the renderer returned its colour frame`).toBeTruthy();
  await info.attach(`${name}.png`, { body: Buffer.from(png!.split(',')[1]!, 'base64'), contentType: 'image/png' });
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

/** The flat entities the pick grid hits most, in [minId, maxId): on screen by construction. */
async function spreadIds(page: Page, count = 3, minId = 0, instanced = false, maxId = Infinity): Promise<number[]> {
  const report = await page.evaluate(() => (globalThis as ProbeWindow).__ifc_lite_pick_parity__!({ columns: 40, rows: 24 }));
  const hits = [...new Set(report.rows.flatMap((r) => (r.gpu ? [r.gpu.expressId] : [])))];
  const candidates = await page.evaluate(async ([wantInstanced, picked]) => {
    const module = '/src/hooks/useBCF.ts';
    const { getGlobalRenderer }: { getGlobalRenderer(): RendererHandle | null } = await import(module);
    const scene = getGlobalRenderer()!.getScene();
    // Instanced: any picked entity with instanced occurrences, flat pieces or not.
    // Flat: entities with flat pieces (the id list also holds instanced-only entities).
    return wantInstanced ? picked.filter((id) => scene.isInstancedEntity(id))
      : scene.getAllMeshDataExpressIds().filter((id) => (scene.getMeshDataPieces(id)?.length ?? 0) > 0);
  }, [instanced, hits] as const);
  const flat = new Set(candidates);
  const tally = new Map<number, number>();
  for (const r of report.rows) if (!r.annotation && r.gpu && r.gpu.expressId >= minId && r.gpu.expressId < maxId && flat.has(r.gpu.expressId)) tally.set(r.gpu.expressId, (tally.get(r.gpu.expressId) ?? 0) + 1);
  return [...tally].sort((x, y) => y[1] - x[1]).slice(0, count).map(([id]) => id);
}

const CLEAR: Step[] = [['setSelectedEntityId', 'none'], ['setSelectedEntityIds', []], ['clearHover'], ['showAll'], ['clearIsolation'],
  ['setGhostExceptEntities', 'none'], ['setSectionPlaneEnabled', false]];

interface Scenario { name: string; steps: Step[]; ids: number[] }

/** Which pixels each frame highlights (moved more than 48/255 from C), and where A and B differ. */
async function coverage(page: Page, a: string, b: string, c: string): Promise<Coverage> {
  return page.evaluate(async ([x, y, z]) => {
    const pixels = async (url: string) => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    };
    const [p, q, r] = await Promise.all([pixels(x), pixels(y), pixels(z)]);
    const d = (u: Uint8ClampedArray, v: Uint8ClampedArray, i: number) => Math.max(Math.abs(u[i]! - v[i]!), Math.abs(u[i + 1]! - v[i + 1]!), Math.abs(u[i + 2]! - v[i + 2]!));
    const out = { highlightedA: 0, highlightedB: 0, onlyA: 0, onlyB: 0, shadeInBoth: 0, outside: 0 };
    for (let i = 0; i < p.length; i += 4) {
      const ha = d(p, r, i) > 48, hb = d(q, r, i) > 48;
      if (ha) out.highlightedA++;
      if (hb) out.highlightedB++;
      if (d(p, q, i) <= 2) continue;
      if (ha && hb) out.shadeInBoth++; else if (ha) out.onlyA++; else if (hb) out.onlyB++; else out.outside++;
    }
    return out;
  }, [a, b, c] as const);
}

/** A (batches) vs B (copies) under the scenario; C is the frame without any highlight. */
async function compare(page: Page, info: TestInfo, scenario: Scenario): Promise<Record<string, unknown>> {
  expect(scenario.ids.length, `${scenario.name}: the scenario has entities to highlight`).toBeGreaterThan(0);
  await act(page, CLEAR);
  const highlight = ([m]: Step) => /^(setSelected|setHover)/.test(m);
  await act(page, scenario.steps.filter((step) => !highlight(step)), scenario.ids);
  const c = await capture(page, info, `${scenario.name}-C-no-highlight`);
  // Only the highlight steps: replaying isolateEntities with the same set would toggle isolation off.
  await act(page, scenario.steps.filter(highlight), scenario.ids);
  const a = await capture(page, info, `${scenario.name}-A-batches`);
  const copiesA = await copiesInScene(page);
  await route(page, true);
  const b = await capture(page, info, `${scenario.name}-B-copies`);
  const copiesB = await copiesInScene(page);
  await route(page, false);
  const ab = await diff(page, a, b);
  const ac = await diff(page, a, c);
  const cover = await coverage(page, a, b, c);
  await info.attach(`${scenario.name}-A-vs-B-diff.png`, { body: Buffer.from(ab.diffPng.split(',')[1]!, 'base64'), contentType: 'image/png' });
  const pixels = ab.width * ab.height;
  const row = { scenario: scenario.name, ids: scenario.ids.length, copiesA, copiesB, pixels, differingAB: ab.differing, strongAB: ab.strong, maxChannelAB: ab.maxChannel, differingAC: ac.differing, strongAC: ac.strong, coverage: cover };
  await info.attach(`${scenario.name}.json`, { body: JSON.stringify(row, null, 2), contentType: 'application/json' });
  expect(copiesA, `${scenario.name}: the production frame holds no copy of any piece`).toBe(0);
  expect(copiesB, `${scenario.name}: the reference really drew copies`).toBeGreaterThan(0);
  expect(ac.strong, `${scenario.name}: the highlight changed the frame (not a vacuous comparison)`).toBeGreaterThan(50);
  // The same pixels are highlighted (edge pixels may flip at the 48/255 cut)...
  expect(cover.onlyA + cover.onlyB, `${scenario.name}: the batches highlight the pixels the copies highlight`).toBeLessThanOrEqual(Math.ceil(pixels * 0.0001));
  expect(cover.outside, `${scenario.name}: nothing outside the highlight changes`).toBeLessThanOrEqual(Math.ceil(pixels * 0.0001));
  expect(ab.strong, `${scenario.name}: no large colour change`).toBeLessThanOrEqual(Math.ceil(pixels * 0.0005));
  // ...and inside it only the shade of overlapping highlighted surfaces may differ: the
  // highlight writes no depth, so where two overlap without opaque depth between them the
  // one drawn last shows, and batches draw in batch order, copies in hydration order.
  expect(cover.shadeInBoth, `${scenario.name}: shade differences stay inside the highlight's overlaps`).toBeLessThanOrEqual(Math.ceil(cover.highlightedA * 0.1));
  return row;
}

async function adapter(page: Page): Promise<unknown> {
  return page.evaluate(async () => {
    const a = await navigator.gpu?.requestAdapter();
    return a ? { vendor: a.info.vendor, architecture: a.info.architecture, description: a.info.description } : null;
  });
}

for (const quantized of [true, false]) {
  test(`C20-Institute ${quantized ? 'quantized' : 'f32'}: selection, multi-select, hover, hide, isolate, section, X-Ray (#10264 S3)`, async ({ page }, info) => {
    await open(page, quantized);
    await load(page, FIXTURES.institute, 1);
    await info.attach('adapter.json', { body: JSON.stringify(await adapter(page)), contentType: 'application/json' });
    const ids = await spreadIds(page, 6);
    expect(ids.length, 'two distinct entities at least: one is hidden while the other stays selected').toBeGreaterThanOrEqual(2);
    const layout = await page.evaluate(async () => {
      const module = '/src/hooks/useBCF.ts';
      const { getGlobalRenderer }: { getGlobalRenderer(): RendererHandle | null } = await import(module);
      const all = getGlobalRenderer()!.getScene().getBatchedMeshes();
      return { total: all.length, quantized: all.filter((b) => b.quantized).length };
    });
    await info.attach('batches.json', { body: JSON.stringify(layout), contentType: 'application/json' });
    expect(layout.quantized > 0, 'batch layout follows the quantization switch').toBe(quantized);
    const rows = [];
    rows.push(await compare(page, info, { name: 'select-one', ids, steps: [['setSelectedEntityId', 'id0']] }));
    rows.push(await compare(page, info, { name: 'multi-select', ids, steps: [['setSelectedEntityId', 'id0'], ['setSelectedEntityIds', 'ids']] }));
    rows.push(await compare(page, info, { name: 'hover', ids, steps: [['setHoverHighlightEnabled', true], ['setHoverState', 'hover0']] }));
    rows.push(await compare(page, info, { name: 'select-hide-isolate', ids, steps: [['isolateEntities', 'ids'], ['hideEntities', [ids[1]!]], ['setSelectedEntityIds', 'ids']] })); // isolate un-hides its ids, so hide after
    rows.push(await compare(page, info, { name: 'select-section', ids, steps: [['setSectionPlaneAxis', 'down'], ['setSectionPlanePosition', 43], ['setSectionPlaneEnabled', true], ['setSelectedEntityIds', 'ids']] }));
    rows.push(await compare(page, info, { name: 'select-xray', ids, steps: [['setGhostExceptEntities', 'set01'], ['setSelectedEntityIds', 'ids']] }));
    await info.attach('summary.json', { body: JSON.stringify(rows, null, 2), contentType: 'application/json' });
  });
}

test('instanced and flat entities selected together (#10264 S3)', async ({ page }, info) => {
  await open(page);
  await load(page, FIXTURES.tower, 1);
  const instanced = await spreadIds(page, 2, 0, true);
  test.skip(instanced.length === 0, 'no entity with instanced occurrences is on screen');
  const flat = (await spreadIds(page, 6)).filter((id) => !instanced.includes(id));
  expect(flat.length, 'a flat entity beside the instanced ones').toBeGreaterThan(0);
  const ids = [...instanced, ...flat.slice(0, 3)];
  await compare(page, info, { name: 'instanced-and-flat', ids, steps: [['setSelectedEntityIds', 'ids']] });
});

test('federation (two models): a selection across both models (#10264 S3)', async ({ page }, info) => {
  await open(page);
  await load(page, FIXTURES.institute, 1);
  await load(page, FIXTURES.duplex, 2);
  const offsets = await page.evaluate(() => [...(globalThis as ProbeWindow).__ifc_lite_viewer_store__!.getState().models.values()].map((m) => m.idOffset).sort((x, y) => x - y));
  expect(offsets).toHaveLength(2);
  const first = await spreadIds(page, 2, 0, false, offsets[1]!);
  const second = await spreadIds(page, 2, offsets[1]!);
  expect(first.length, 'the first model is on screen').toBeGreaterThan(0);
  expect(second.length, 'the second model is on screen').toBeGreaterThan(0);
  await compare(page, info, { name: 'federation-select', ids: [...first.slice(0, 2), ...second], steps: [['setSelectedEntityIds', 'ids']] });
});

test('georeferenced model at ~5,000 km: selection and hover (#10264 S3)', async ({ page }, info) => {
  await open(page);
  await load(page, FIXTURES.georef, 1);
  const ids = await spreadIds(page, 3);
  await compare(page, info, { name: 'georef-select', ids, steps: [['setSelectedEntityIds', 'ids']] });
  await compare(page, info, { name: 'georef-hover', ids, steps: [['setHoverHighlightEnabled', true], ['setHoverState', 'hover0']] });
});

test('a selection of 10,000 flat entities highlights from the batches and keeps rendering (#10264 S3, untimed)', async ({ page }, info) => {
  await open(page);
  await load(page, FIXTURES.tower, 1);
  const flat = await page.evaluate(async () => {
    const module = '/src/hooks/useBCF.ts';
    const { getGlobalRenderer }: { getGlobalRenderer(): RendererHandle | null } = await import(module);
    const scene = getGlobalRenderer()!.getScene();
    return scene.getAllMeshDataExpressIds().filter((id) => (scene.getMeshDataPieces(id)?.length ?? 0) > 0);
  });
  const all = flat.slice(0, 10_000);
  await info.attach('selection-size.json', { body: JSON.stringify({ flatEntities: flat.length, selected: all.length }), contentType: 'application/json' });
  expect(all.length, 'a ~10k selection').toBeGreaterThanOrEqual(9_000);
  const row = await compare(page, info, { name: 'select-10k-flat', ids: all, steps: [['setSelectedEntityIds', 'ids']] });
  // Untimed: a new frame lands while the whole selection is drawn from the batches (no speed claim).
  const frameAt = () => page.evaluate(() => (globalThis as ProbeWindow).__ifc_lite_render_frame__?.()?.timestamp ?? -1);
  const before = await frameAt();
  await act(page, [['setSelectedEntityIds', 'ids']], all);
  await page.evaluate(async () => {
    const module = '/src/hooks/useBCF.ts';
    const { getGlobalRenderer }: { getGlobalRenderer(): RendererHandle | null } = await import(module);
    getGlobalRenderer()!.requestRender();
  });
  await settle(page);
  expect(await frameAt(), 'the renderer submitted a newer frame with 10,000 entities selected').toBeGreaterThan(before);
  await info.attach('select-all-flat-row.json', { body: JSON.stringify(row), contentType: 'application/json' });
});

test('after the scene releases its CPU geometry, selection and hover still highlight (#10264 S3)', async ({ page }, info) => {
  await open(page);
  await load(page, FIXTURES.institute, 1);
  const ids = await spreadIds(page, 4);
  await act(page, [['setSelectedEntityIds', 'ids']], ids);
  const before = await capture(page, info, 'released-select-before');
  await act(page, [['setSelectedEntityIds', []], ['setHoverHighlightEnabled', true], ['setHoverState', 'hover0']], ids.slice(1));
  const hoverBefore = await capture(page, info, 'released-hover-before');
  await act(page, [['clearHover']]);
  const noHover = await capture(page, info, 'released-no-hover');
  const released = await page.evaluate(async (probe) => {
    const module = '/src/hooks/useBCF.ts';
    const { getGlobalRenderer }: { getGlobalRenderer(): RendererHandle | null } = await import(module);
    const renderer = getGlobalRenderer()!;
    renderer.getScene().releaseGeometryData(); // evidence only: the viewer never releases (S4 is not enabled)
    renderer.requestRender();
    return probe.every((id) => renderer.getScene().getMeshDataPieces(id) === undefined);
  }, ids);
  expect(released, 'the scene holds no CPU pieces to copy').toBe(true);
  // Selected after the release: only the batches can draw it.
  await act(page, [['setSelectedEntityIds', 'ids']], ids);
  const after = await capture(page, info, 'released-select-after');
  const same = await diff(page, before, after);
  await act(page, [['setSelectedEntityIds', []], ['setHoverState', 'hover0']], ids.slice(1));
  const hoverAfter = await capture(page, info, 'released-hover-after');
  const sameHover = await diff(page, hoverBefore, hoverAfter);
  const hoverShown = await diff(page, noHover, hoverAfter);
  expect(await copiesInScene(page), 'no copy stands in after the release').toBe(0);
  // The copies route after the release has nothing to draw: the highlight vanishes.
  await act(page, [['clearHover'], ['setSelectedEntityIds', 'ids']], ids);
  await route(page, true);
  const copies = await capture(page, info, 'released-select-copies-route');
  const lost = await diff(page, after, copies);
  await route(page, false);
  await info.attach('released.json', { body: JSON.stringify({ select: { ...same, diffPng: undefined }, hover: { ...sameHover, diffPng: undefined }, copiesRoute: { ...lost, diffPng: undefined } }), contentType: 'application/json' });
  expect(same.differing, 'selection: the same draws, from the same buffers').toBe(0);
  expect(sameHover.differing, 'hover: the same draws, from the same buffers').toBe(0);
  expect(hoverShown.strong, 'hover: the outline is actually drawn after the release').toBeGreaterThan(50);
  expect(lost.strong, 'the copies route has nothing to highlight once the pieces are gone').toBeGreaterThan(50);
});
