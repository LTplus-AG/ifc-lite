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
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const FIXTURE = 'tests/models/ara3d/C20-Institute-Var-2.ifc'; // 10.3 MiB: the smallest cached ("source") tier fixture
const LOAD_TIMEOUT_MS = 180_000;

interface LoadSummary {
  spans: string[];
  meshes: number;
  snapshotWrite: { ended: boolean; outcome: unknown } | null;
}

/** Open the fixture in a fresh page and wait until the load is complete and the store settled. */
async function openFixture(page: Page): Promise<void> {
  await page.goto('/?perfTrace=1');
  await page.waitForFunction(() => Boolean((globalThis as Record<string, unknown>).__ifc_lite_viewer_store__));
  await page.locator('#file-input-open').setInputFiles(join(process.cwd(), FIXTURE));
  await page.waitForFunction(() => {
    const g = globalThis as Record<string, any>;
    const load = g.__IFC_LITE_LOAD_TRACE__?.latest();
    const state = g.__ifc_lite_viewer_store__.getState();
    return Boolean(load && load.end !== null && !state.loading && !state.geometryStreamingActive && (state.geometryResult?.meshes?.length ?? 0) > 0);
  }, null, { timeout: LOAD_TIMEOUT_MS, polling: 250 });
}

async function summary(page: Page): Promise<LoadSummary> {
  return page.evaluate(() => {
    const g = globalThis as Record<string, any>;
    const load = g.__IFC_LITE_LOAD_TRACE__.latest();
    const write = load.spans.find((s: { name: string }) => s.name === 'cache.writeSceneSnapshot');
    return {
      spans: [...new Set<string>(load.spans.map((s: { name: string }) => s.name))],
      meshes: g.__ifc_lite_viewer_store__.getState().geometryResult?.meshes?.length ?? 0,
      snapshotWrite: write ? { ended: write.end !== null, outcome: write.attrs?.outcome ?? null } : null,
    };
  });
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

test.describe('cold load scene snapshot (W2)', () => {
  test.skip(!existsSync(join(process.cwd(), FIXTURE)), `${FIXTURE} missing — run \`pnpm fixtures\``);

  test('a cold load leaves a snapshot on its entry, and the first reopen adopts it without streaming', async ({ context }) => {
    const cold = await context.newPage();
    await openFixture(cold);
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
    await openFixture(reopen);
    const warm = await summary(reopen);
    expect(warm.spans, 'the first reopen is a cache hit').toContain('cache.storeReady');
    expect(warm.spans, 'the first reopen drew the stored scene').toContain('scene.snapshotAdopted');
    expect(warm.spans, 'and did not stream and finalize the hit').not.toContain('scene.finalize');
    expect(warm.meshes, 'the reopen restored every mesh of the cold load').toBe(coldLoad.meshes);
    await reopen.close();
  });
});
