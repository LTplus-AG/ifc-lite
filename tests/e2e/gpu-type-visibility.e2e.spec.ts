/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10264 hardware acceptance for type visibility without a CPU re-upload.
 * Every mesh, the initially hidden IfcSpace and IfcOpeningElement geometry
 * included, is uploaded once; a class toggle only changes the entity ids the
 * GPU hide table discards (the S2 path).
 *
 * Each scenario checks, on a real adapter:
 * - the toggled class is in the scene while hidden, and a toggle keeps every
 *   colour batch and its vertex buffer object (nothing is re-uploaded);
 * - the type-hidden frame equals the frame of the visible pieces alone (the
 *   pieces the old filter would have uploaded), with shadows on;
 * - showing the class changes the frame (not vacuous), hiding it again
 *   restores the first frame, and picks never return a hidden entity;
 * - after the test-only `Scene.releaseGeometryData()`, showing a class that
 *   was hidden from the start draws what a scene that kept its CPU copy draws.
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
};
const LOAD_TIMEOUT = 300_000;

interface Diff { width: number; height: number; differing: number; strong: number; maxChannel: number; diffPng: string }
interface PickRow { gpu: { expressId: number } | null; cpu: { expressId: number } | null; annotation: boolean }
interface SceneHandle {
  getAllMeshDataExpressIds(): number[];
  isInstancedEntity(id: number): boolean;
  getBatchedMeshes(): Array<{ vertexBuffer: unknown }>;
  removeMeshesForEntities(ids: Iterable<number>): number;
  rebuildPendingBatches(device: unknown, pipeline: unknown): void;
  releaseGeometryData(): void;
  getMeshDataPieces(id: number): unknown[] | undefined;
}
interface RendererHandle { getScene(): SceneHandle; requestRender(): void; device: { getDevice(): unknown }; pipeline: unknown }
type Store = { getState(): Record<string, unknown> & {
  loading: boolean; geometryStreamingActive: boolean; models: Map<string, { idOffset: number }>;
  typeVisibility: Record<string, boolean>; hasTypeGeometry: boolean;
} };
type ProbeWindow = typeof globalThis & {
  __ifc_lite_viewer_store__?: Store;
  __ifc_lite_scene_settled__?: () => boolean;
  __ifc_lite_capture_color_frame__?: () => Promise<string | null>;
  __ifc_lite_render_visibility__?: () => { hiddenIds: number[]; isolatedIds: number[] | null };
  __ifc_lite_pick_parity__?: (request: { columns: number; rows: number }) => Promise<{ rows: PickRow[] }>;
  __type_visibility_batches__?: unknown[];
};

let server: ViewerDevServer | undefined;
test.skip(process.env.GPU_PICK_PARITY !== '1', 'Set GPU_PICK_PARITY=1 on a real WebGPU adapter; CI SwiftShader is not acceptance evidence.');
test.beforeAll(async () => { server = await startViewerDevServer('gpu-type-visibility'); });
test.afterAll(async () => { await server?.close(); });

async function open(page: Page): Promise<void> {
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

/** Call store actions by name, then let the frame settle. */
async function store(page: Page, calls: Array<[string, ...unknown[]]>): Promise<void> {
  await page.evaluate((list) => {
    const s = (globalThis as ProbeWindow).__ifc_lite_viewer_store__!.getState() as unknown as Record<string, (...args: unknown[]) => void>;
    for (const [method, ...args] of list) s[method]!(...args);
  }, calls);
  await settle(page);
}

async function capture(page: Page, info: TestInfo, name: string): Promise<string> {
  const png = await page.evaluate(() => (globalThis as ProbeWindow).__ifc_lite_capture_color_frame__!());
  expect(png, `${name}: the renderer returned its colour frame`).toBeTruthy();
  await info.attach(`${name}.png`, { body: Buffer.from(png!.split(',')[1]!, 'base64'), contentType: 'image/png' });
  return png!;
}

/** A frame once two successive captures agree (overlays arrive a few frames after load). */
async function stillFrame(page: Page, info: TestInfo, name: string): Promise<string> {
  let frame = (await page.evaluate(() => (globalThis as ProbeWindow).__ifc_lite_capture_color_frame__!()))!;
  for (let i = 0; i < 20; i++) {
    await settle(page);
    const next = (await page.evaluate(() => (globalThis as ProbeWindow).__ifc_lite_capture_color_frame__!()))!;
    if ((await diff(page, frame, next)).differing === 0) return capture(page, info, name);
    frame = next;
  }
  throw new Error(`${name}: the frame did not settle`);
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

/** The scene's flat entities of these IFC classes, by the store's own entity index. */
async function flatOfClasses(page: Page, classes: string[]): Promise<number[]> {
  return page.evaluate(async (upper) => {
    const module = '/src/hooks/useBCF.ts'; // the dev server's own module instance
    const { getGlobalRenderer }: { getGlobalRenderer(): RendererHandle | null } = await import(module);
    const s = (globalThis as ProbeWindow).__ifc_lite_viewer_store__!.getState() as unknown as {
      models: Map<string, { idOffset: number; ifcDataStore?: { entityIndex: { byType: Map<string, number[]> } } }> };
    const wanted = new Set<number>();
    for (const model of s.models.values()) {
      for (const type of upper) for (const id of model.ifcDataStore?.entityIndex.byType.get(type) ?? []) wanted.add(id + model.idOffset);
    }
    return [...new Set(getGlobalRenderer()!.getScene().getAllMeshDataExpressIds())].filter((id) => wanted.has(id));
  }, classes);
}

/** Remember every colour batch and its vertex buffer object; `same` compares against them. */
async function batchIdentity(page: Page, mode: 'record' | 'same'): Promise<{ batches: number; same: boolean }> {
  return page.evaluate(async (m) => {
    const module = '/src/hooks/useBCF.ts';
    const { getGlobalRenderer }: { getGlobalRenderer(): RendererHandle | null } = await import(module);
    const g = globalThis as ProbeWindow;
    const now = getGlobalRenderer()!.getScene().getBatchedMeshes().flatMap((b) => [b, b.vertexBuffer]);
    if (m === 'record') { g.__type_visibility_batches__ = now; return { batches: now.length / 2, same: true }; }
    const before = g.__type_visibility_batches__ ?? [];
    return { batches: now.length / 2, same: before.length === now.length && before.every((x, i) => x === now[i]) };
  }, mode);
}

async function picksNeverHidden(page: Page, info: TestInfo, name: string, hidden: number[]): Promise<number> {
  const report = await page.evaluate(() => (globalThis as ProbeWindow).__ifc_lite_pick_parity__!({ columns: 40, rows: 24 }));
  await info.attach(`${name}-picks.json`, { body: JSON.stringify(report), contentType: 'application/json' });
  const set = new Set(hidden);
  const mesh = report.rows.filter((r) => !r.annotation);
  expect(mesh.filter((r) => r.gpu && set.has(r.gpu.expressId)), `${name}: no type-hidden entity is picked (GPU)`).toEqual([]);
  expect(mesh.filter((r) => r.cpu && set.has(r.cpu.expressId)), `${name}: no type-hidden entity is picked (CPU raycast)`).toEqual([]);
  expect(mesh.filter((r) => r.gpu).length, `${name}: the grid lands on visible geometry`).toBeGreaterThan(0);
  return mesh.filter((r) => r.gpu).length;
}

/** The frame of the visible pieces alone: drop the type-hidden pieces and rebuild, the old upload's scene. */
async function visiblePiecesOnly(page: Page, info: TestInfo, name: string, hidden: number[]): Promise<string> {
  await page.evaluate(async (ids) => {
    const module = '/src/hooks/useBCF.ts';
    const { getGlobalRenderer }: { getGlobalRenderer(): RendererHandle | null } = await import(module);
    const renderer = getGlobalRenderer()!;
    const scene = renderer.getScene();
    scene.removeMeshesForEntities(ids.filter((id) => !scene.isInstancedEntity(id)));
    scene.rebuildPendingBatches(renderer.device.getDevice(), renderer.pipeline);
    renderer.requestRender();
  }, hidden);
  await settle(page);
  return stillFrame(page, info, name);
}

const SPACES_AND_OPENINGS = ['IFCSPACE', 'IFCOPENINGELEMENT', 'IFCOPENINGSTANDARDCASE'];

async function adapter(page: Page): Promise<unknown> {
  return page.evaluate(async () => {
    const a = await navigator.gpu?.requestAdapter();
    return a ? { vendor: a.info.vendor, architecture: a.info.architecture, description: a.info.description } : null;
  });
}

/**
 * The toggle round trip on the loaded scene: hidden by default, shown, hidden
 * again, with the batches kept. Returns the frames for the caller's oracle.
 */
async function roundTrip(page: Page, info: TestInfo, name: string, hidden: number[]): Promise<{ off: string; on: string; row: Record<string, unknown> }> {
  const visibility = await page.evaluate(() => (globalThis as ProbeWindow).__ifc_lite_render_visibility__!());
  const rendered = new Set(visibility.hiddenIds);
  expect(hidden.filter((id) => !rendered.has(id)), `${name}: the viewport hides every uploaded space and opening`).toEqual([]);
  const user = await page.evaluate(() => [...((globalThis as ProbeWindow).__ifc_lite_viewer_store__!.getState().hiddenEntities as Set<number>)]);
  expect(user, `${name}: the user's hidden set stays empty`).toEqual([]);
  const off = await stillFrame(page, info, `${name}-1-default-hidden`);
  await picksNeverHidden(page, info, `${name}-default`, hidden);
  await batchIdentity(page, 'record');
  await store(page, [['toggleTypeVisibility', 'spaces'], ['toggleTypeVisibility', 'openings']]);
  const on = await stillFrame(page, info, `${name}-2-shown`);
  const shown = await batchIdentity(page, 'same');
  await store(page, [['toggleTypeVisibility', 'spaces'], ['toggleTypeVisibility', 'openings']]);
  const back = await stillFrame(page, info, `${name}-3-hidden-again`);
  const kept = await batchIdentity(page, 'same');
  const onOff = await diff(page, on, off);
  const backOff = await diff(page, back, off);
  await info.attach(`${name}-shown-vs-hidden-diff.png`, { body: Buffer.from(onOff.diffPng.split(',')[1]!, 'base64'), contentType: 'image/png' });
  const row = { scenario: name, typeHiddenFlat: hidden.length, batches: kept.batches, batchesKeptOnShow: shown.same, batchesKeptOnHide: kept.same,
    strongShownVsHidden: onOff.strong, differingHiddenAgain: backOff.differing };
  expect(shown.same && kept.same, `${name}: no toggle replaces a batch or its vertex buffer`).toBe(true);
  expect(onOff.strong, `${name}: showing the classes changes the frame (not vacuous)`).toBeGreaterThan(200);
  expect(backOff.differing, `${name}: hiding them again restores the first frame`).toBe(0);
  return { off, on, row };
}

test('C20-Institute: spaces and openings toggle on the GPU over one upload, with shadows (#10264)', async ({ page }, info) => {
  await open(page);
  await load(page, FIXTURES.institute, 1);
  await info.attach('adapter.json', { body: JSON.stringify(await adapter(page)), contentType: 'application/json' });
  await store(page, [['setEnvShadowsEnabled', true]]);
  const hidden = await flatOfClasses(page, SPACES_AND_OPENINGS);
  expect(hidden.length, 'the initially hidden spaces and openings are in the scene').toBeGreaterThan(0);
  const { off, row } = await roundTrip(page, info, 'institute', hidden);
  const reference = await visiblePiecesOnly(page, info, 'institute-4-visible-pieces-only', hidden);
  const oracle = await diff(page, off, reference);
  await info.attach('institute-hidden-vs-pieces-diff.png', { body: Buffer.from(oracle.diffPng.split(',')[1]!, 'base64'), contentType: 'image/png' });
  const pixels = oracle.width * oracle.height;
  await info.attach('institute.json', { body: JSON.stringify({ ...row, pixels, strongVsPieces: oracle.strong, differingVsPieces: oracle.differing,
    hasTypeGeometry: await page.evaluate(() => (globalThis as ProbeWindow).__ifc_lite_viewer_store__!.getState().hasTypeGeometry) }, null, 2), contentType: 'application/json' });
  // Same bound as S2's hide oracle: geometry present in one frame and absent in the other moves a pixel far.
  expect(oracle.strong, 'type-hidden draws what the visible pieces alone draw').toBeLessThanOrEqual(Math.ceil(pixels * 0.0005));
  expect(oracle.differing, 'translucent draw-order differences only').toBeLessThanOrEqual(Math.ceil(pixels * 0.01));
});

test('federation (two models): spaces and openings of both toggle over one upload (#10264)', async ({ page }, info) => {
  await open(page);
  await load(page, FIXTURES.institute, 1);
  await load(page, FIXTURES.duplex, 2);
  const offsets = await page.evaluate(() => [...(globalThis as ProbeWindow).__ifc_lite_viewer_store__!.getState().models.values()].map((m) => m.idOffset).sort((a, b) => a - b));
  const hidden = await flatOfClasses(page, SPACES_AND_OPENINGS);
  const second = hidden.filter((id) => id >= offsets[1]!);
  expect(second.length, 'the second model contributes hidden spaces or openings').toBeGreaterThan(0);
  expect(hidden.length - second.length, 'the first model contributes hidden spaces or openings').toBeGreaterThan(0);
  const { off, row } = await roundTrip(page, info, 'federation', hidden);
  const reference = await visiblePiecesOnly(page, info, 'federation-4-visible-pieces-only', hidden);
  const oracle = await diff(page, off, reference);
  const pixels = oracle.width * oracle.height;
  await info.attach('federation.json', { body: JSON.stringify({ ...row, offsets, secondModelHidden: second.length, pixels,
    strongVsPieces: oracle.strong, differingVsPieces: oracle.differing }, null, 2), contentType: 'application/json' });
  expect(oracle.strong, 'type-hidden draws what the visible pieces alone draw').toBeLessThanOrEqual(Math.ceil(pixels * 0.0005));
  expect(oracle.differing, 'translucent draw-order differences only').toBeLessThanOrEqual(Math.ceil(pixels * 0.01));
});

test('after the test-only CPU release, classes hidden from the start toggle on and off (#10264)', async ({ page, browser }, info) => {
  // Reference: a scene that keeps its CPU copy, shown.
  const reference = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  let shownRef: string;
  try {
    await open(reference);
    await load(reference, FIXTURES.institute, 1);
    await store(reference, [['setEnvShadowsEnabled', true]]);
    await stillFrame(reference, info, 'reference-1-default-hidden');
    await store(reference, [['toggleTypeVisibility', 'spaces'], ['toggleTypeVisibility', 'openings']]);
    shownRef = await stillFrame(reference, info, 'reference-2-shown');
  } finally {
    await reference.close();
  }
  // Released: the classes were never shown before the release.
  await open(page);
  await load(page, FIXTURES.institute, 1);
  await store(page, [['setEnvShadowsEnabled', true]]);
  const hidden = await flatOfClasses(page, SPACES_AND_OPENINGS);
  expect(hidden.length).toBeGreaterThan(0);
  const before = await stillFrame(page, info, 'released-1-default-hidden');
  const released = await page.evaluate(async (probe) => {
    const module = '/src/hooks/useBCF.ts';
    const { getGlobalRenderer }: { getGlobalRenderer(): RendererHandle | null } = await import(module);
    const renderer = getGlobalRenderer()!;
    renderer.getScene().releaseGeometryData(); // evidence only: the viewer never releases (S4 is not enabled)
    renderer.requestRender();
    return renderer.getScene().getMeshDataPieces(probe) === undefined;
  }, hidden[0]!);
  expect(released, 'the scene holds no CPU pieces of the hidden classes').toBe(true);
  await settle(page);
  await batchIdentity(page, 'record');
  await store(page, [['toggleTypeVisibility', 'spaces'], ['toggleTypeVisibility', 'openings']]);
  const shown = await stillFrame(page, info, 'released-2-shown');
  await store(page, [['toggleTypeVisibility', 'spaces'], ['toggleTypeVisibility', 'openings']]);
  const back = await stillFrame(page, info, 'released-3-hidden-again');
  const kept = await batchIdentity(page, 'same');
  const vsRef = await diff(page, shown, shownRef);
  const vsBefore = await diff(page, shown, before);
  const restored = await diff(page, back, before);
  await info.attach('released-shown-vs-reference-diff.png', { body: Buffer.from(vsRef.diffPng.split(',')[1]!, 'base64'), contentType: 'image/png' });
  const pixels = vsRef.width * vsRef.height;
  await info.attach('released.json', { body: JSON.stringify({ typeHiddenFlat: hidden.length, batches: kept.batches, batchesKept: kept.same, pixels,
    strongShownVsHidden: vsBefore.strong, strongShownVsReference: vsRef.strong, differingShownVsReference: vsRef.differing,
    differingHiddenAgain: restored.differing }, null, 2), contentType: 'application/json' });
  expect(kept.same, 'the released scene keeps its batches and vertex buffers').toBe(true);
  expect(vsBefore.strong, 'the never-shown classes appear after the release').toBeGreaterThan(200);
  expect(vsRef.strong, 'and draw what a scene with its CPU copy draws').toBeLessThanOrEqual(Math.ceil(pixels * 0.0005));
  expect(vsRef.differing, 'up to translucent draw order').toBeLessThanOrEqual(Math.ceil(pixels * 0.01));
  expect(restored.differing, 'hiding them again restores the first frame').toBe(0);
  await picksNeverHidden(page, info, 'released-hidden-again', hidden);
});
