/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * W2 (load hillclimb, reopen lane): a primary cold load of a cacheable file
 * leaves its finished scene beside its cache entry once it settles, so the
 * FIRST reopen draws that scene instead of streaming the cache hit. Before
 * W2 only a streamed hit wrote one, so only the second reopen adopted it.
 *
 * Everything read back from the page is a count, a name or a size: never a
 * mesh array, a store map or an IndexedDB value.
 *
 * Two readiness conditions keep this deterministic on a software GPU (CI's
 * SwiftShader), where the product is slow but correct:
 * - The viewport, and with it quantized-batch admission, starts with the first
 *   file. On a slow GPU admission can land after the cold load's finalize; the
 *   batches are then f32 while the policy says quantized, and the writer refuses
 *   the capture (`policy-changed`, correct). The cold page therefore opens a
 *   small uncached fixture first and waits for the viewer's admission line.
 * - Frame stats describe the LAST rendered frame. Adoption uploads every batch
 *   at once, and on a software GPU the frame pacer holds the next frame (#5865)
 *   until the queue drains: the frame on record at "interactive" can predate
 *   the adoption. Output is read from a frame rendered after the load ended.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

// The two smallest cached ("source" tier, >= 10 MiB) fixtures: C20-Institute 10.3 MiB, ISSUE_129 11.5 MiB.
const FIXTURES = ['tests/models/ara3d/C20-Institute-Var-2.ifc', 'tests/models/ara3d/ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc'];
const LOAD_TIMEOUT_MS = 180_000;
// Below the 10 MiB cache tier, so it leaves no entry: it only starts the viewport.
const WARM_UP_FIXTURE = 'tests/models/ara3d/AC20-FZK-Haus.ifc';

interface LoadSummary {
  spans: string[];
  meshes: number;
  snapshotWrite: { ended: boolean; outcome: unknown } | null;
  /** Per element: one hash of its meshes' origin, positions, normals, indices and colour bytes, order-independent. */
  elements: [number, string][];
  instanced: { drawn: number | null; gpuBytes: number | null };
}

/** Open the fixture in a fresh page and wait until the load is complete and the store settled. */
async function openFixture(page: Page, fixture: string): Promise<void> {
  if (page.url() === 'about:blank') await page.goto('/?perfTrace=1');
  await page.waitForFunction(() => Boolean((globalThis as Record<string, unknown>).__ifc_lite_viewer_store__));
  // A page that already loaded a file still holds that load's (finished) trace: wait for this one.
  const previous = await page.evaluate(() => (globalThis as Record<string, any>).__IFC_LITE_LOAD_TRACE__?.latest()?.loadId ?? null);
  await page.locator('#file-input-open').setInputFiles(join(process.cwd(), fixture));
  await page.waitForFunction((previous) => {
    const g = globalThis as Record<string, any>;
    const load = g.__IFC_LITE_LOAD_TRACE__?.latest();
    const state = g.__ifc_lite_viewer_store__.getState();
    return Boolean(load && load.loadId !== previous && load.end !== null && !state.loading && !state.geometryStreamingActive && (state.geometryResult?.meshes?.length ?? 0) > 0);
  }, previous, { timeout: LOAD_TIMEOUT_MS, polling: 250 });
}

/** Open a fixture in a fresh page whose renderer has already settled quantized admission. */
async function admittedPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  const admitted = page.waitForEvent('console', { predicate: (msg) => msg.text().startsWith('[Viewport] quantized vertices'), timeout: LOAD_TIMEOUT_MS });
  await openFixture(page, WARM_UP_FIXTURE);
  await admitted;
  return page;
}

async function summary(page: Page): Promise<LoadSummary> {
  // A frame rendered after the load ended (both on the page's performance clock).
  await page.waitForFunction(() => {
    const g = globalThis as Record<string, any>;
    const load = g.__IFC_LITE_LOAD_TRACE__?.latest();
    const frame = g.__ifc_lite_render_frame__?.();
    return Boolean(load && load.end !== null && frame && frame.timestamp > load.end);
  }, null, { timeout: LOAD_TIMEOUT_MS, polling: 100 });
  return page.evaluate(async () => {
    const g = globalThis as Record<string, any>;
    const load = g.__IFC_LITE_LOAD_TRACE__.latest();
    const write = load.spans.find((s: { name: string }) => s.name === 'cache.writeSceneSnapshot');
    const meshes = g.__ifc_lite_viewer_store__.getState().geometryResult?.meshes ?? [];
    const fnv = (h: number, bytes: Uint8Array) => { for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); } return h >>> 0; };
    const view = (a: ArrayBufferView | undefined) => (a ? new Uint8Array(a.buffer, a.byteOffset, a.byteLength) : new Uint8Array(0));
    const perElement = new Map<number, number[]>();
    for (const m of meshes) {
      let h = fnv(0x811c9dc5, view(new Float64Array(m.origin ?? [0, 0, 0])));
      h = fnv(h, view(m.positions)); h = fnv(h, view(m.normals)); h = fnv(h, view(m.indices)); h = fnv(h, view(new Float32Array(m.color)));
      (perElement.get(m.expressId) ?? perElement.set(m.expressId, []).get(m.expressId)!).push(h);
    }
    const stats = g.__ifc_lite_render_stats__?.();
    return {
      spans: [...new Set<string>(load.spans.map((s: { name: string }) => s.name))],
      meshes: meshes.length,
      snapshotWrite: write ? { ended: write.end !== null, outcome: write.attrs?.outcome ?? null } : null,
      elements: [...perElement].map(([id, hs]) => [id, hs.sort((a, b) => a - b).join('.')] as [number, string]),
      instanced: { drawn: stats?.frame?.instancedDrawn ?? null, gpuBytes: stats?.gpu?.instanced ?? null },
    };
  });
}

/** Elements whose meshes differ between two loads (at most ten ids), and how many there are. */
function differingElements(a: LoadSummary, b: LoadSummary): { count: number; first: number[] } {
  const other = new Map(b.elements);
  const ids = new Set([...a.elements.map(([id]) => id), ...other.keys()]);
  const mine = new Map(a.elements);
  const differing = [...ids].filter((id) => mine.get(id) !== other.get(id));
  return { count: differing.length, first: differing.slice(0, 10) };
}

/** Per cache entry: whether it carries a scene snapshot, and its size. */
async function cachedEntries(page: Page): Promise<{ snapshotBytes: number | null }[]> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('ifc-lite-cache');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const all = open.result.transaction('models').objectStore('models').getAll();
      all.onerror = () => reject(all.error);
      all.onsuccess = () => {
        open.result.close();
        resolve(all.result.map((e: { sceneSnapshot?: Blob }) => ({ snapshotBytes: e.sceneSnapshot ? e.sceneSnapshot.size : null })));
      };
    };
  }));
}

for (const FIXTURE of FIXTURES) test.describe(`cold load scene snapshot (W2): ${FIXTURE.split('/').pop()}`, () => {
  test.skip(!existsSync(join(process.cwd(), FIXTURE)), `${FIXTURE} missing — run \`pnpm fixtures\``);

  test('a cold load leaves a snapshot on its entry, and the first reopen adopts it with identical output', async ({ context }) => {
    test.skip(!existsSync(join(process.cwd(), WARM_UP_FIXTURE)), `${WARM_UP_FIXTURE} missing — run \`pnpm fixtures\``);
    const cold = await admittedPage(context);
    await openFixture(cold, FIXTURE);
    // The deferred write is an open `cache.writeSceneSnapshot` span until it lands.
    await cold.waitForFunction(() => {
      const load = (globalThis as Record<string, any>).__IFC_LITE_LOAD_TRACE__.latest();
      return load.spans.some((s: { name: string; end: number | null }) => s.name === 'cache.writeSceneSnapshot' && s.end !== null);
    }, null, { timeout: 120_000, polling: 250 });
    const coldLoad = await summary(cold);
    expect(coldLoad.spans, 'the cold load streamed and finalized').toContain('scene.finalize');
    expect(coldLoad.snapshotWrite).toEqual({ ended: true, outcome: 'written' });
    const entries = await cachedEntries(cold);
    expect(entries).toHaveLength(1);
    expect(entries[0].snapshotBytes, 'the entry carries the cold load\'s scene').toBeGreaterThan(0);
    await cold.close();

    const reopen = await context.newPage();
    await openFixture(reopen, FIXTURE);
    const warm = await summary(reopen);
    expect(warm.spans, 'the first reopen is a cache hit').toContain('cache.storeReady');
    expect(warm.spans, 'the first reopen drew the stored scene').toContain('scene.snapshotAdopted');
    expect(warm.spans, 'and did not stream and finalize the hit').not.toContain('scene.finalize');
    expect(warm.meshes, 'the reopen restored every mesh of the cold load').toBe(coldLoad.meshes);
    expect(coldLoad.elements.length, 'elements compared').toBeGreaterThan(0);
    expect(differingElements(coldLoad, warm), 'per-element output (origin, positions, normals, indices, colour) equals the cold load').toEqual({ count: 0, first: [] });
    expect(warm.instanced, 'instanced output: templates drawn and their GPU bytes').toEqual(coldLoad.instanced);
    await reopen.close();
  });
});
