/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The small-file fast path changes when a small file is meshed, never what the
 * user gets. A spare worker makes the same `processAdaptive` call the loader
 * would make, so the scene must equal the normal pipeline's. Below 2 MiB that
 * is the single-session branch; from 2 MiB the worker pool with GPU instancing.
 * Each fixture is opened twice in fresh pages: with `?perf.fastPath=0`, and with
 * the fast path on after its spares are ready (a console line says so), and the
 * run was claimed. The comparison covers:
 * - per-element mesh bytes (flat meshes);
 * - the flat mesh count;
 * - instanced templates drawn and their GPU bytes;
 * - the instanced shards decoded;
 * - the data store's entity count.
 * A run that dropped instancing would differ in the flat count and the instanced bytes.
 *
 * Everything read back from the page is a count or a short string, never a mesh array.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const FIXTURES = [
  // Under 2 MiB: the single-session branch.
  'apps/viewer/public/samples/building-architecture.ifc',
  // 2.4 MiB: the worker pool, GPU instancing.
  'apps/viewer/public/_fixtures/AC20-FZK-Haus.ifc',
];
const LOAD_TIMEOUT_MS = 180_000;

interface LoadSummary {
  meshes: number;
  elements: [number, string][];
  instanced: { drawn: number | null; gpuBytes: number | null };
  shardsDecoded: number;
  entities: number | null;
}

async function openFixture(page: Page, fixture: string): Promise<void> {
  await page.waitForFunction(() => Boolean((globalThis as Record<string, unknown>).__ifc_lite_viewer_store__));
  const previous = await page.evaluate(() => (globalThis as Record<string, any>).__IFC_LITE_LOAD_TRACE__?.latest()?.loadId ?? null);
  await page.locator('#file-input-open').setInputFiles(join(process.cwd(), fixture));
  await page.waitForFunction((previous) => {
    const g = globalThis as Record<string, any>;
    const load = g.__IFC_LITE_LOAD_TRACE__?.latest();
    const state = g.__ifc_lite_viewer_store__.getState();
    return Boolean(load && load.loadId !== previous && load.end !== null && !state.loading && !state.geometryStreamingActive && (state.geometryResult?.meshes?.length ?? 0) > 0);
  }, previous, { timeout: LOAD_TIMEOUT_MS, polling: 250 });
}

async function summary(page: Page): Promise<LoadSummary> {
  await page.waitForFunction(() => {
    const g = globalThis as Record<string, any>;
    const load = g.__IFC_LITE_LOAD_TRACE__?.latest();
    const frame = g.__ifc_lite_render_frame__?.();
    return Boolean(load && load.end !== null && frame && frame.timestamp > load.end);
  }, null, { timeout: LOAD_TIMEOUT_MS, polling: 100 });
  return page.evaluate(() => {
    const g = globalThis as Record<string, any>;
    const load = g.__IFC_LITE_LOAD_TRACE__.latest();
    const state = g.__ifc_lite_viewer_store__.getState();
    const meshes = state.geometryResult?.meshes ?? [];
    const fnv = (h: number, bytes: Uint8Array) => { for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); } return h >>> 0; };
    const view = (a: ArrayBufferView | undefined) => (a ? new Uint8Array(a.buffer, a.byteOffset, a.byteLength) : new Uint8Array(0));
    const perElement = new Map<number, number[]>();
    for (const m of meshes) {
      let h = fnv(0x811c9dc5, view(new Float64Array(m.origin ?? [0, 0, 0])));
      h = fnv(h, view(m.positions)); h = fnv(h, view(m.normals)); h = fnv(h, view(m.indices)); h = fnv(h, view(new Float32Array(m.color)));
      (perElement.get(m.expressId) ?? perElement.set(m.expressId, []).get(m.expressId)!).push(h);
    }
    const stats = g.__ifc_lite_render_stats__?.();
    const model = state.models.get(state.activeModelId ?? '');
    return {
      meshes: meshes.length,
      elements: [...perElement].map(([id, hs]) => [id, hs.sort((a, b) => a - b).join('.')] as [number, string]),
      instanced: { drawn: stats?.frame?.instancedDrawn ?? null, gpuBytes: stats?.gpu?.instanced ?? null },
      shardsDecoded: load.spans.filter((s: { name: string }) => s.name === 'instanced.decode').length,
      entities: model?.ifcDataStore?.entityCount ?? null,
    };
  });
}

function differingElements(a: LoadSummary, b: LoadSummary): { count: number; first: number[] } {
  const other = new Map(b.elements);
  const mine = new Map(a.elements);
  const ids = new Set([...mine.keys(), ...other.keys()]);
  const differing = [...ids].filter((id) => mine.get(id) !== other.get(id));
  return { count: differing.length, first: differing.slice(0, 10) };
}

/** A fresh page; `fast` waits for the spares before the pick and records whether the run was claimed. */
async function load(context: BrowserContext, fixture: string, fast: boolean): Promise<{ summary: LoadSummary; claimed: boolean }> {
  const page = await context.newPage();
  let claimed = false;
  page.on('console', (msg) => { if (msg.text().startsWith('[fast-path] run claimed')) claimed = true; });
  const ready = fast ? page.waitForEvent('console', { predicate: (msg) => msg.text().startsWith('[fast-path] spares ready'), timeout: 60_000 }) : null;
  await page.goto(fast ? '/?perfTrace=1' : '/?perfTrace=1&perf.fastPath=0');
  await ready;
  await openFixture(page, fixture);
  const result = await summary(page);
  await page.close();
  return { summary: result, claimed };
}

for (const FIXTURE of FIXTURES) test.describe(`small-file fast path: ${FIXTURE.split('/').pop()}`, () => {
  test.skip(!existsSync(join(process.cwd(), FIXTURE)), `${FIXTURE} missing`);

  test('meshing in the spare worker yields the same scene and data as the normal pipeline', async ({ context }) => {
    const off = await load(context, FIXTURE, false);
    const on = await load(context, FIXTURE, true);
    expect(off.claimed, 'with ?perf.fastPath=0 no run is claimed').toBe(false);
    expect(on.claimed, 'with the fast path on, the load used the spare worker\'s run').toBe(true);
    expect(off.summary.elements.length, 'elements compared').toBeGreaterThan(0);
    expect(on.summary.meshes, 'flat mesh count (instanced occurrences are not flat)').toBe(off.summary.meshes);
    expect(differingElements(off.summary, on.summary), 'per-element mesh bytes').toEqual({ count: 0, first: [] });
    expect(on.summary.instanced, 'instanced templates drawn and their GPU bytes').toEqual(off.summary.instanced);
    expect(on.summary.shardsDecoded, 'instanced shards decoded').toBe(off.summary.shardsDecoded);
    expect(on.summary.entities, 'data store entities').toBe(off.summary.entities);
  });
});
