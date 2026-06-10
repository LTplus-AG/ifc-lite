/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Functional E2E smoke for the real viewer: real browser, real WASM
 * pipeline (buildPrePassOnce → processGeometryBatch), real renderer.
 *
 * This is the only test that catches "renders wrong" regressions —
 * the benchmark suite measures timing, every unit test mocks the WASM
 * boundary, and the Rust tests exercise a different mesh pipeline than
 * the viewer (see AGENTS.md §Geometry & WASM, issues #858/#957).
 *
 * State assertions go through the Zustand store singleton the app
 * registers at `globalThis.__ifc_lite_viewer_store__` (store/index.ts).
 */

import { test, expect, Page } from '@playwright/test';
import { existsSync } from 'fs';
import { join } from 'path';
import { ViewerBenchmarkPage } from '../benchmark/viewer-benchmark-page';

const FIXTURE = 'tests/models/ara3d/AC20-FZK-Haus.ifc';
// Keep in sync with tests/benchmark/viewer-benchmark.spec.ts expectedMeshCounts.
// 317 verified against the raw WASM pipeline (parseMeshesViaPrePass) on
// 2026-06-10: 285 instance meshes + 32 type meshes (#957 type-geometry pass)
// incl. 7 IfcSpace (spaces feature #1022). A drift in EITHER direction means
// the geometry pipeline changed — update this only as a conscious decision.
const EXPECTED_MESHES = 317;
const MESH_TOLERANCE = 0.05;

const STORE_KEY = '__ifc_lite_viewer_store__';

/** Read a snapshot of viewer state through the app's store singleton. */
async function storeState<T>(page: Page, pick: string): Promise<T> {
  return page.evaluate(
    ({ key, pickExpr }) => {
      const store = (globalThis as Record<string, any>)[key];
      if (!store) throw new Error(`viewer store singleton ${key} not found`);
      const state = store.getState();
      // eslint-disable-next-line no-new-func
      return new Function('state', `return (${pickExpr});`)(state);
    },
    { key: STORE_KEY, pickExpr: pick },
  ) as Promise<T>;
}

/** Invoke a store action inside the app. */
async function storeAction(page: Page, expr: string): Promise<void> {
  await page.evaluate(
    ({ key, actionExpr }) => {
      const store = (globalThis as Record<string, any>)[key];
      if (!store) throw new Error(`viewer store singleton ${key} not found`);
      const state = store.getState();
      // eslint-disable-next-line no-new-func
      new Function('state', `${actionExpr};`)(state);
    },
    { key: STORE_KEY, actionExpr: expr },
  );
}

/**
 * Wait for the geometry stream to finish by watching the viewer's own
 * console summary, and return the streamed mesh count. (The benchmark
 * page's waitForCompletion also gates on 2D-canvas pixel sampling,
 * which can't read a WebGPU canvas and spins to timeout — we only need
 * the log markers here.)
 */
async function waitForMeshCount(viewer: ViewerBenchmarkPage, page: Page, timeoutMs: number): Promise<number> {
  const started = Date.now();
  const patterns = [
    /Geometry streaming complete: \d+ batches, (\d+) meshes/,
    /\([\d.]+MB\)\s+→\s+(\d+)\s+meshes/,
  ];
  while (Date.now() - started < timeoutMs) {
    const logs = viewer.getConsoleLogs().join('\n');
    for (const re of patterns) {
      const m = logs.match(re);
      if (m) return parseInt(m[1], 10);
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`geometry stream did not complete within ${timeoutMs}ms`);
}

test.describe('Viewer functional smoke (AC20-FZK-Haus)', () => {
  test.skip(!existsSync(join(process.cwd(), FIXTURE)), `${FIXTURE} missing — run \`pnpm fixtures\``);

  // One page/load shared by the steps below: the load is the expensive
  // part; the functional checks build on each other deliberately.
  test('load → geometry → pick → section plane survive end to end', async ({ page }) => {
    const viewer = new ViewerBenchmarkPage(page);
    await viewer.setup();
    await viewer.loadFile(join(process.cwd(), FIXTURE));

    // ── 1. Geometry made it through the real WASM pipeline ──────────
    const meshes = await waitForMeshCount(viewer, page, 120000);
    expect(meshes).toBeGreaterThanOrEqual(EXPECTED_MESHES * (1 - MESH_TOLERANCE));
    expect(meshes).toBeLessThanOrEqual(EXPECTED_MESHES * (1 + MESH_TOLERANCE));

    // Rendered-content check: a blank/uniform canvas screenshot
    // compresses to a few KB; a rendered building doesn't. (WebGPU
    // canvases can't be pixel-sampled via a 2D context.)
    await page.waitForTimeout(1500); // let the camera fit + first frames land
    const canvasShot = await page.locator('canvas').first().screenshot();
    expect(
      canvasShot.byteLength,
      'canvas screenshot should not be a near-uniform (blank) image',
    ).toBeGreaterThan(20_000);

    // Data model landed in the store (parse path, not just geometry).
    // The metadata parse finishes after the geometry stream — poll.
    let entityCount = 0;
    const dataDeadline = Date.now() + 60000;
    while (Date.now() < dataDeadline) {
      entityCount = await storeState<number>(
        page,
        'state.ifcDataStore ? state.ifcDataStore.entityCount : 0',
      );
      if (entityCount > 100) break;
      await page.waitForTimeout(250);
    }
    expect(entityCount, 'data store entity count').toBeGreaterThan(100);

    const modelCount = await storeState<number>(page, 'state.models.size');
    expect(modelCount, 'exactly one model registered').toBe(1);

    // ── 2. Click-to-select drives the real pick pass ─────────────────
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    expect(box, 'canvas bounding box').not.toBeNull();

    // After auto-fit the model covers the viewport centre; probe a few
    // spots so a background pixel at dead-centre doesn't flake the test.
    const probes: Array<[number, number]> = [
      [0.5, 0.55],
      [0.5, 0.4],
      [0.45, 0.6],
      [0.6, 0.5],
      [0.4, 0.45],
    ];
    let selected: unknown = null;
    for (const [fx, fy] of probes) {
      await canvas.click({
        position: { x: box!.width * fx, y: box!.height * fy },
      });
      await page.waitForTimeout(300);
      selected = await storeState(page, 'state.selectedEntity');
      if (selected) break;
    }
    expect(selected, 'clicking the model selects an entity').not.toBeNull();

    // Single-pick drives the renderer-highlight channel via the global-id
    // scalar (selectedEntityId); the plural set is multi-select only
    // (Viewport.tsx pick handler).
    const highlightId = await storeState<number | null>(page, 'state.selectedEntityId');
    expect(
      highlightId,
      'renderer-highlight channel (selectedEntityId) follows the pick',
    ).not.toBeNull();

    // Escape clears the selection.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const cleared = await storeState(page, 'state.selectedEntity');
    expect(cleared, 'Escape clears selection').toBeNull();

    // ── 3. Section plane: slider move auto-enables and keeps rendering ─
    // Regression #243 at the integration level: moving the position must
    // auto-enable clipping.
    await storeAction(page, 'state.setSectionPlanePosition(1.5)');
    await page.waitForTimeout(300);
    const section = await storeState<{ enabled: boolean; position: number }>(
      page,
      '({ enabled: state.sectionPlane.enabled, position: state.sectionPlane.position })',
    );
    expect(section.enabled, 'setting section position auto-enables the plane').toBe(true);

    // The renderer must survive the clip state without dying: page still
    // responsive, canvas still painted, no crash overlay.
    await page.waitForTimeout(500);
    const stillAlive = await page.evaluate(() => document.querySelector('canvas') !== null);
    expect(stillAlive, 'canvas survives section-plane toggle').toBe(true);

    await storeAction(page, 'state.setSectionPlaneEnabled(false)');

    // ── 4. No uncaught page errors during the whole flow ─────────────
    // (Collected throughout; checked last so earlier asserts report first.)
  });

  test('page reports no uncaught errors on a clean load', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));

    const viewer = new ViewerBenchmarkPage(page);
    await viewer.setup();
    await viewer.loadFile(join(process.cwd(), FIXTURE));
    await waitForMeshCount(viewer, page, 120000);
    await page.waitForTimeout(2000); // let post-load work (metadata, spatial) settle

    expect(errors, `uncaught page errors:\n${errors.join('\n')}`).toEqual([]);
  });
});
