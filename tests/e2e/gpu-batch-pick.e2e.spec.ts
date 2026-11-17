/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10264 S1 hardware acceptance: on models over the pick-mesh budget the click
 * and hover pick draws the colour batches whole on the GPU. This compares that
 * pick with the exact CPU triangle raycast (the oracle) over a texel grid on
 * public fixtures, and drives a real click and hover through the viewer.
 * Opt-in: GPU_PICK_PARITY=1 on a real WebGPU adapter (see gpu-batch-pick.config.ts).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { startViewerDevServer, type ViewerDevServer } from './viewer-dev-server.js';

const FIXTURES = {
  // Over the 500-piece pick-mesh budget (FZK-Haus, at 245, is not).
  institute: 'tests/models/ara3d/C20-Institute-Var-2.ifc',
  duplex: 'tests/models/ara3d/duplex.ifc',
  textured: 'tests/models/buildingsmart/annex_e/tessellated-shape-with-style/tessellation-with-image-texture.ifc',
  georef: 'tests/models/ara3d/ISSUE_098_R8_F1_MAB_AR_M3_XX_XXX_MO_7000.IFC',
};
const LOAD_TIMEOUT = 300_000;
/** The GPU rasterises the 2^-10 m lattice; a hit point within one lattice diagonal of the CPU hit is the same surface point. */
const LATTICE_DIAGONAL_METRES = Math.sqrt(3) / 1024;

interface Hit { expressId: number; modelIndex?: number; geometryItemId?: number; world?: [number, number, number] }
interface Row { x: number; y: number; gpu: Hit | null; cpu: Hit | null; distanceMetres: number | null }
interface Report {
  canvas: { width: number; height: number };
  batches: { total: number; quantized: number };
  hydratedMeshes: { before: number; after: number };
  visiblePieces: number;
  rows: Row[];
  rect?: { gpu: number[]; cpu: number[] };
}
type Store = { getState(): Record<string, unknown> & {
  loading: boolean; geometryStreamingActive: boolean; models: Map<string, { idOffset: number; name?: string }>;
  selectedEntityId: number | null; hoverState: { entityId: number | null };
  hideEntities(ids: number[]): void; isolateEntities(ids: number[]): void; showAll(): void; clearIsolation(): void;
  setSectionPlaneAxis(axis: 'down' | 'front' | 'side'): void; setSectionPlanePosition(position: number): void; setSectionPlaneEnabled(enabled: boolean): void;
} };
type ProbeWindow = typeof globalThis & {
  __ifc_lite_viewer_store__?: Store;
  __ifc_lite_scene_settled__?: () => boolean;
  __ifc_lite_pick_parity__?: (request: { columns: number; rows: number; rect?: { x0: number; y0: number; x1: number; y1: number } }) => Promise<Report>;
  __IFC_LITE_QUANTIZED?: number;
};

let server: ViewerDevServer | undefined;
test.skip(process.env.GPU_PICK_PARITY !== '1', 'Set GPU_PICK_PARITY=1 on a real WebGPU adapter; CI SwiftShader is not acceptance evidence.');
test.beforeAll(async () => { server = await startViewerDevServer('gpu-batch-pick'); });
test.afterAll(async () => { await server?.close(); });

async function open(page: Page, init?: { quantized?: boolean }): Promise<void> {
  if (init?.quantized === false) await page.addInitScript(() => { (globalThis as ProbeWindow).__IFC_LITE_QUANTIZED = 0; });
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
      && g.__ifc_lite_pick_parity__);
  }, count, { timeout: LOAD_TIMEOUT, polling: 250 });
  await settleFrames(page);
}

/** Picks mirror the last rendered frame's clip: let a few frames land after any state change. */
async function settleFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    let n = 0;
    const tick = () => (++n >= 12 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }));
}

async function parity(page: Page, info: TestInfo, name: string, rect?: boolean): Promise<Report> {
  const report = await page.evaluate(async (withRect) => (globalThis as ProbeWindow).__ifc_lite_pick_parity__!({
    columns: 48, rows: 27, ...(withRect ? { rect: { x0: 300, y0: 250, x1: 380, y1: 310 } } : {}),
  }), rect ?? false);
  await info.attach(`${name}.json`, { body: JSON.stringify({ summary: summarize(report), ...report }, null, 2), contentType: 'application/json' });
  await info.attach(`${name}.png`, { body: await page.locator('canvas').first().screenshot(), contentType: 'image/png' });
  return report;
}

function summarize(report: Report) {
  const both = report.rows.filter((r) => r.gpu && r.cpu);
  const agree = both.filter((r) => r.gpu!.expressId === r.cpu!.expressId);
  const distances = agree.map((r) => r.distanceMetres ?? Infinity).sort((a, b) => a - b);
  return {
    samples: report.rows.length,
    bothHit: both.length,
    neither: report.rows.filter((r) => !r.gpu && !r.cpu).length,
    gpuOnly: report.rows.filter((r) => r.gpu && !r.cpu),
    cpuOnly: report.rows.filter((r) => !r.gpu && r.cpu),
    entityAgree: agree.length,
    entityDisagree: both.filter((r) => r.gpu!.expressId !== r.cpu!.expressId),
    modelDisagree: agree.filter((r) => r.cpu!.modelIndex !== undefined && r.gpu!.modelIndex !== r.cpu!.modelIndex).length,
    itemDisagree: agree.filter((r) => r.gpu!.geometryItemId !== r.cpu!.geometryItemId).length,
    gpuWithoutWorld: report.rows.filter((r) => r.gpu && !r.gpu.world).length,
    distance: { median: distances[Math.floor(distances.length / 2)] ?? null, p99: distances[Math.floor(distances.length * 0.99)] ?? null, max: distances.at(-1) ?? null },
  };
}

/**
 * The parity contract. A disagreement on the entity is accepted only as a tie
 * between coincident surfaces: both hit points within the lattice diagonal,
 * where neither pick is more right than the other. Everything else must agree
 * on entity, model and representation item, with the GPU hit point within the
 * lattice diagonal of the CPU hit point.
 */
function expectParity(report: Report, minHits: number): ReturnType<typeof summarize> {
  const s = summarize(report);
  expect(report.visiblePieces, 'the model is over the pick-mesh budget, so the batch route answers').toBeGreaterThan(500);
  expect(report.hydratedMeshes.after, 'the batch route builds no pick meshes').toBe(report.hydratedMeshes.before);
  expect(s.gpuWithoutWorld, 'every GPU hit carries its depth-reconstructed world point').toBe(0);
  expect(s.bothHit, 'enough of the grid lands on the model').toBeGreaterThanOrEqual(minHits);
  for (const row of s.entityDisagree) {
    const [gx, gy, gz] = row.gpu!.world!;
    const [cx, cy, cz] = row.cpu!.world!;
    expect(Math.hypot(gx - cx, gy - cy, gz - cz), `entity tie at ${row.x},${row.y}: ${JSON.stringify(row)}`).toBeLessThanOrEqual(LATTICE_DIAGONAL_METRES);
  }
  expect(s.gpuOnly.length + s.cpuOnly.length, `one-sided samples: ${JSON.stringify([...s.gpuOnly, ...s.cpuOnly])}`).toBeLessThanOrEqual(Math.ceil(s.samples * 0.005));
  expect(s.modelDisagree).toBe(0);
  expect(s.itemDisagree).toBe(0);
  expect(s.distance.max ?? 0, 'GPU hit point within the 1 mm lattice of the CPU hit').toBeLessThanOrEqual(LATTICE_DIAGONAL_METRES);
  return s;
}

/** The id the grid hits most often among samples both picks agree on. */
function mostHit(report: Report, count: number): number[] {
  const tally = new Map<number, number>();
  for (const r of report.rows) if (r.gpu && r.cpu && r.gpu.expressId === r.cpu.expressId) tally.set(r.gpu.expressId, (tally.get(r.gpu.expressId) ?? 0) + 1);
  return [...tally].sort((a, b) => b[1] - a[1]).slice(0, count).map(([id]) => id);
}

async function adapter(page: Page): Promise<unknown> {
  return page.evaluate(async () => {
    const a = await navigator.gpu?.requestAdapter();
    return a ? { vendor: a.info.vendor, architecture: a.info.architecture, description: a.info.description } : null;
  });
}

test('C20-Institute: click, hover, marquee, hide, isolate and section match the CPU raycast (#10264)', async ({ page }, info) => {
  await open(page);
  await load(page, FIXTURES.institute, 1);
  await info.attach('adapter.json', { body: JSON.stringify(await adapter(page)), contentType: 'application/json' });

  const base = await parity(page, info, 'institute-default', true);
  expectParity(base, 300);
  expect(base.batches.quantized, 'default viewer quantizes its batches').toBeGreaterThan(0);
  expect(base.rect!.gpu, 'GPU marquee: pixel-exact ids equal the CPU raycast at every texel centre').toEqual(base.rect!.cpu);

  // A real hover and click through the viewer's own pointer handlers.
  const target = base.rows.find((r) => r.gpu && r.cpu && r.gpu.expressId === r.cpu.expressId && r.x > 40 && r.y > 40 && r.x < base.canvas.width - 40 && r.y < base.canvas.height - 40)!;
  const box = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.move(box.x + target.x, box.y + target.y);
  await page.waitForFunction((id) => (globalThis as ProbeWindow).__ifc_lite_viewer_store__!.getState().hoverState.entityId === id, target.gpu!.expressId, { timeout: 10_000 });
  await page.mouse.click(box.x + target.x, box.y + target.y);
  await page.waitForFunction((id) => (globalThis as ProbeWindow).__ifc_lite_viewer_store__!.getState().selectedEntityId === id, target.gpu!.expressId, { timeout: 10_000 });

  const [hidden] = mostHit(base, 1);
  await page.evaluate((id) => (globalThis as ProbeWindow).__ifc_lite_viewer_store__!.getState().hideEntities([id]), hidden!);
  await settleFrames(page);
  const hide = await parity(page, info, 'institute-hidden');
  expectParity(hide, 200);
  expect(hide.rows.filter((r) => r.gpu?.expressId === hidden), 'a hidden entity is never picked').toEqual([]);

  const isolated = mostHit(base, 6).slice(1);
  await page.evaluate((ids) => {
    const s = (globalThis as ProbeWindow).__ifc_lite_viewer_store__!.getState();
    s.showAll();
    s.isolateEntities(ids);
  }, isolated);
  await settleFrames(page);
  const iso = await parity(page, info, 'institute-isolated');
  expectParity(iso, 50);
  expect(iso.rows.filter((r) => r.gpu && !isolated.includes(r.gpu.expressId)), 'only isolated entities are picked').toEqual([]);

  await page.evaluate(() => {
    const s = (globalThis as ProbeWindow).__ifc_lite_viewer_store__!.getState();
    s.showAll();
    s.setSectionPlaneAxis('down');
    s.setSectionPlanePosition(40);
    s.setSectionPlaneEnabled(true);
  });
  await settleFrames(page);
  expectParity(await parity(page, info, 'institute-section', true), 200);
});

test('C20-Institute with f32 (unquantized) batches matches the CPU raycast (#10264)', async ({ page }, info) => {
  await open(page, { quantized: false });
  await load(page, FIXTURES.institute, 1);
  const report = await parity(page, info, 'institute-f32', true);
  expect(report.batches.quantized, 'the kill switch keeps every batch on the 28-byte f32 layout').toBe(0);
  expectParity(report, 300);
  expect(report.rect!.gpu).toEqual(report.rect!.cpu);
});

test('federation: two IFC models and a textured model keep model identity (#10264)', async ({ page }, info) => {
  await open(page);
  await load(page, FIXTURES.institute, 1);
  await load(page, FIXTURES.duplex, 2);
  await load(page, FIXTURES.textured, 3);
  const report = await parity(page, info, 'federation', true);
  const s = expectParity(report, 200);
  const models = await page.evaluate(() => [...(globalThis as ProbeWindow).__ifc_lite_viewer_store__!.getState().models.values()].map((m) => ({ name: m.name, idOffset: m.idOffset })));
  await info.attach('federation-models.json', { body: JSON.stringify({ models, summary: s }), contentType: 'application/json' });
  const hitModels = new Set(report.rows.filter((r) => r.gpu?.modelIndex !== undefined).map((r) => r.gpu!.modelIndex));
  expect(hitModels.size, 'the grid hits more than one federated model').toBeGreaterThan(1);
  expect(report.rect!.gpu).toEqual(report.rect!.cpu);
});

test('georeferenced model at ~5,000 km keeps the RTC hit point (#10264)', async ({ page }, info) => {
  await open(page);
  await load(page, FIXTURES.georef, 1);
  expectParity(await parity(page, info, 'georef', true), 100);
});
