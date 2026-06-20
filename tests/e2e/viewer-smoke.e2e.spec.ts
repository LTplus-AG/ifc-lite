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

// GitHub-hosted runners only offer WebGPU over SwiftShader, and that
// device is unstable under load (partial createBuffer failures +
// "Instance dropped in popErrorScope" device loss) on both the
// headless shell and real Chrome. E2E_GPU_STRICT=0 (set by the CI job)
// keeps the CPU-side pipeline assertions gating while skipping the
// checks that need a healthy GPU device: the pick pass, screenshot
// density, and zero-GPU-error strictness. Locally (real GPU) everything
// runs. Flip the env in .github/workflows/test.yml if runner WebGPU
// ever stabilizes.
const GPU_STRICT = process.env.E2E_GPU_STRICT !== '0';

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
    // Collect uncaught errors across the WHOLE interaction flow (pick,
    // Escape, section plane) — asserted at the end of the test.
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    const viewer = new ViewerBenchmarkPage(page);
    await viewer.setup();
    await viewer.loadFile(join(process.cwd(), FIXTURE));

    // ── 1. Geometry made it through the real WASM pipeline ──────────
    const meshes = await waitForMeshCount(viewer, page, 120000);
    expect(meshes).toBeGreaterThanOrEqual(EXPECTED_MESHES * (1 - MESH_TOLERANCE));
    expect(meshes).toBeLessThanOrEqual(EXPECTED_MESHES * (1 + MESH_TOLERANCE));

    // Rendered-content check via PNG compression density. WebGPU
    // canvases can't be pixel-sampled through a 2D context, so use the
    // screenshot's bytes-per-pixel: a near-uniform (blank) canvas
    // compresses to ~0.004 B/px, a rendered building to ≥0.02 B/px.
    // Pixel count comes from the PNG's own IHDR header, so the check is
    // resolution- and devicePixelRatio-independent.
    await page.waitForTimeout(1500); // let the camera fit + first frames land
    const canvas = page.locator('canvas').first();
    await expect(canvas, 'render canvas mounted').toBeVisible();
    if (GPU_STRICT) {
      const canvasShot = await canvas.screenshot();
      const pngWidth = canvasShot.readUInt32BE(16);
      const pngHeight = canvasShot.readUInt32BE(20);
      const bytesPerPixel = canvasShot.byteLength / (pngWidth * pngHeight);
      expect(
        bytesPerPixel,
        `screenshot density ${bytesPerPixel.toFixed(4)} B/px (${canvasShot.byteLength}B @ ${pngWidth}x${pngHeight}) — a blank canvas sits near 0.004`,
      ).toBeGreaterThan(0.01);
    } else {
      console.log('[e2e] E2E_GPU_STRICT=0 — skipping screenshot-density check (software WebGPU)');
    }

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
    // GPU-dependent: the pick pass renders ID buffers on the device.
    if (GPU_STRICT) {
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
    } else {
      console.log('[e2e] E2E_GPU_STRICT=0 — skipping pick-pass checks (software WebGPU)');
    }

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

    if (GPU_STRICT) {
      // The canvas surviving in the DOM isn't enough — verify the clipped
      // scene still PAINTS (a frame-loop stall or blanked output after
      // enabling the clip would pass the DOM check).
      const clippedShot = await canvas.screenshot();
      const w = clippedShot.readUInt32BE(16);
      const h = clippedShot.readUInt32BE(20);
      const clippedDensity = clippedShot.byteLength / (w * h);
      expect(
        clippedDensity,
        `post-clip screenshot density ${clippedDensity.toFixed(4)} B/px — renderer blanked after section enable?`,
      ).toBeGreaterThan(0.01);
    }

    await storeAction(page, 'state.setSectionPlaneEnabled(false)');

    // ── 4. No uncaught page errors during the whole flow ─────────────
    const relevantErrors = GPU_STRICT
      ? pageErrors
      : pageErrors.filter(
          (e) =>
            !/popErrorScope|GPUDevice|GPUAdapter|device.*lost|createBuffer/i.test(e),
        );
    expect(
      relevantErrors,
      `uncaught page errors during the flow:\n${relevantErrors.join('\n')}`,
    ).toEqual([]);
  });

  test('page reports no uncaught errors on a clean load', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    // The geometry-stream stall watchdog surfaces as a console.error, not a
    // pageerror — catch it explicitly. A healthy load must never trip it
    // (worker liveness heartbeats + bounded batches keep events flowing).
    const stallErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && /Geometry stream stalled/.test(msg.text())) {
        stallErrors.push(msg.text());
      }
    });

    const viewer = new ViewerBenchmarkPage(page);
    await viewer.setup();
    await viewer.loadFile(join(process.cwd(), FIXTURE));
    await waitForMeshCount(viewer, page, 120000);
    await page.waitForTimeout(2000); // let post-load work (metadata, spatial) settle

    expect(stallErrors, `stream watchdog fired:\n${stallErrors.join('\n')}`).toEqual([]);

    // Under software WebGPU (CI) the device itself is unstable — losing
    // it mid-upload throws device-class errors that say nothing about
    // our code. Filter those when not strict; everything else still fails.
    const relevant = GPU_STRICT
      ? errors
      : errors.filter(
          (e) =>
            !/popErrorScope|GPUDevice|GPUAdapter|device.*lost|createBuffer/i.test(e),
        );
    expect(relevant, `uncaught page errors:\n${relevant.join('\n')}`).toEqual([]);
  });
});
