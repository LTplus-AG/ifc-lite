/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test, expect, type CDPSession } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { performance as nodePerformance } from 'node:perf_hooks';
import { startViewerDevServer } from './viewer-dev-server.js';
import { decodePng } from './federation-control-triplet.rendering.js';
import { classifyViewportWitness } from './viewport-witness.js';
import { DEVICE_LOST_SIGNAL, watchGpuDeviceLoss } from './gpu-device-loss.js';
import type * as Probe from './reporter-6729.browser.js';
import type { CameraViewpoint } from '../../apps/viewer/src/store/types.js';

const FIXTURE_SHA = 'cc6fbbf632c2779891e485c3297d437b1d8555448934b8c8b5a3cce5326553a2';
const FIXTURE_BYTES = 22701;
const fixture = resolve(process.env.REPORTER_6729_IFC ?? 'test-results/reporter-6729-fixture/out_visible.ifc');
type Snapshot = ReturnType<typeof Probe.readProbe>;
type LifecycleSample = {
  stage: string; nodeNowMs: number; receivedAtEpochMs: number;
  lifecycle: ReturnType<typeof Probe.readRendererLifecycle> | null;
  processInfo: unknown; diagnosticError?: string;
};

test('authentic reduced reporter model imports and yields matched software WebGPU frames (#6729)', async ({ page, browser }, info) => {
  // Repository fixture contract: absent files skip; the dedicated workflow
  // separately requires the exact fixture and a completed, non-skipped report.
  test.skip(!existsSync(fixture), 'Reporter fixture absent; use the manual #6729 workflow to fetch its pinned public attachment');
  const bytes = readFileSync(fixture);
  expect(bytes.length).toBe(FIXTURE_BYTES);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(FIXTURE_SHA);
  expect(process.env.E2E_GPU_STRICT, 'this software functional witness must waive no GPU checks').toBe('1');
  const errors: string[] = [];
  const densityFailures: string[] = [];
  const consoleRows: Array<{ type: string; text: string; receivedAtEpochMs: number; nodeNowMs: number }> = [];
  const lifecycleSamples: LifecycleSample[] = [];
  page.on('pageerror', error => {
    errors.push(error.message);
    consoleRows.push({ type: 'pageerror', text: error.message,
      receivedAtEpochMs: Date.now(), nodeNowMs: nodePerformance.now() });
  });
  page.on('console', message => {
    consoleRows.push({ type: message.type(), text: message.text(),
      receivedAtEpochMs: Date.now(), nodeNowMs: nodePerformance.now() });
    if (DEVICE_LOST_SIGNAL.test(message.text()) || message.type() === 'error') errors.push(message.text());
  });
  // Existing real-device destruction control is available for a separately
  // authorized negative run. Strict mode never converts it to a skip.
  await watchGpuDeviceLoss(page);
  const report: {
    status: string; scope: string; fixtureSHA: string; browser: string;
    observed?: Snapshot; displayedElementCount?: string; gpuDiagnostics?: unknown; confirmedBackend?: string;
    timebase: { nodeTimeOriginMs: number; epochClock: string; browserClock: string };
    setupConfound: string; lifecycleSamples: LifecycleSample[];
    frames: Array<{ name: string; requested: CameraViewpoint; observed: Snapshot; pngSHA: string;
      rawWitness: ReturnType<typeof classifyViewportWitness>; pngWitness: ReturnType<typeof classifyViewportWitness> }>;
    errors: string[]; densityFailures: string[]; console: typeof consoleRows;
  } = {
    status: 'INCOMPLETE', scope: 'Reduced authentic fixture requested hosted software functional evidence; backend must be observed; no independent occlusion verdict, physical GPU, performance or full-original GUID acceptance',
    fixtureSHA: FIXTURE_SHA, browser: browser.version(), frames: [], errors, densityFailures, console: consoleRows,
    timebase: { nodeTimeOriginMs: nodePerformance.timeOrigin, epochClock: 'Date.now milliseconds',
      browserClock: 'samples carry browser performance.timeOrigin and performance.now; sampling times differ from event times' },
    setupConfound: 'Private Vite DEV source server; bootstrap uses React.StrictMode. This is a recorded confound, not an established loss cause.',
    lifecycleSamples,
  };
  const server = await startViewerDevServer('reporter-6729');
  const moduleUrl = `/@fs/${fileURLToPath(new URL('./reporter-6729.browser.ts', import.meta.url))}`;
  const read = () => page.evaluate(async url => {
    const probe: typeof Probe = await import(url);
    return probe.readProbe();
  }, moduleUrl);
  let cdp: CDPSession | undefined;
  const sample = async (stage: string) => {
    const row: LifecycleSample = { stage, nodeNowMs: nodePerformance.now(), receivedAtEpochMs: Date.now(),
      lifecycle: null, processInfo: null };
    lifecycleSamples.push(row);
    try {
      row.lifecycle = await page.evaluate(async url => {
        const probe: typeof Probe = await import(url);
        return probe.readRendererLifecycle();
      }, moduleUrl);
      if (!cdp) throw new Error('Browser CDP session unavailable for lifecycle sample');
      row.processInfo = await cdp.send('SystemInfo.getProcessInfo');
    } catch (error) {
      row.diagnosticError = error instanceof Error ? error.message : String(error);
      errors.push(`Lifecycle sample ${stage} failed: ${row.diagnosticError}`);
      console.warn(`Reporter #6729 lifecycle sample ${stage} failed:`, row.diagnosticError);
    }
  };
  try {
    cdp = await browser.newBrowserCDPSession();
    report.gpuDiagnostics = await cdp.send('SystemInfo.getInfo');
    expect(JSON.stringify(report.gpuDiagnostics), 'actual browser GPU diagnostics identify the requested software adapter').toMatch(/swiftshader/i);
    report.confirmedBackend = 'SOFTWARE_SWIFTSHADER_CDP_DESCRIPTOR';
    await page.goto(server.url);
    await sample('before-canonical-import');
    await page.locator('#file-input-open').setInputFiles(fixture);
    await sample('after-file-input-submission');
    await expect.poll(async () => {
      const state = await read();
      if (state.error) throw new Error(`Viewer import failed: ${state.error}`);
      return !state.loading && state.loadState === 'complete' && state.models === 1 && state.meshCount > 0 && state.camera !== null;
    }, { timeout: 120_000, message: 'canonical real IFC import completes with loaded geometry' }).toBe(true);
    report.observed = await read();
    await sample('after-cpu-load-complete');
    report.displayedElementCount = await page.getByText(/^[\d.,KkMm]+\s+elements$/).first().innerText();
    const loaded = report.observed;
    expect(loaded.error).toBeNull();
    expect(loaded.adapter, 'actual renderer adapter identity snapshot is available beside CDP diagnostics').not.toBeNull();
    expect(loaded.identities).toHaveLength(2);
    for (const nut of loaded.identities) {
      expect(nut.actualGuid, `actual source-backed ${nut.alias} identity`).toBe(nut.guid);
      expect(nut.resolved.expressId).toBe(nut.expressId);
    }
    const bounds = loaded.camera?.sceneBounds;
    expect(bounds, 'actual imported assembly supplies camera scene bounds').not.toBeNull();
    if (!bounds || !loaded.camera) throw new Error('Imported assembly camera bounds unavailable');
    const target = {
      x: (bounds.min.x + bounds.max.x) / 2,
      y: (bounds.min.y + bounds.max.y) / 2,
      z: (bounds.min.z + bounds.max.z) / 2,
    };
    const extent = Math.hypot(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z);
    expect(Number.isFinite(extent) && extent > 0).toBe(true);
    const fov = loaded.camera.fov;
    const poses = [
      { name: 'front', direction: { x: 0, y: 0, z: 1 } },
      { name: 'side', direction: { x: 1, y: 0, z: 0 } },
      { name: 'oblique', direction: { x: 1 / Math.sqrt(3), y: 1 / Math.sqrt(3), z: 1 / Math.sqrt(3) } },
    ];
    for (const pose of poses) for (const zoom of [1, 2]) {
      const distance = extent * 1.5 / zoom;
      const position = { x: target.x + pose.direction.x * distance,
        y: target.y + pose.direction.y * distance, z: target.z + pose.direction.z * distance };
      for (const projectionMode of ['perspective', 'orthographic'] as const) {
        const requested: CameraViewpoint = { position, target, up: { x: 0, y: 1, z: 0 }, fov,
          projectionMode, orthoSize: distance * Math.tan(fov / 2) };
        await page.evaluate(async ({ url, view }) => {
          const probe: typeof Probe = await import(url);
          probe.applyProbeView(view);
        }, { url: moduleUrl, view: requested });
        for (const selection of ['unselected', 'nutA', 'nutB'] as const) {
          await page.evaluate(async ({ url, selection }) => {
            const probe: typeof Probe = await import(url);
            probe.selectProbeNut(selection);
          }, { url: moduleUrl, selection });
          await expect.poll(async () => {
            const observed = (await read()).camera;
            if (!observed || observed.projectionMode !== projectionMode) return false;
            if (!Number.isFinite(observed.fov) || Math.abs(observed.fov - fov) > 1e-6
              || (projectionMode === 'orthographic' && Math.abs(observed.orthoSize - requested.orthoSize!) > 1e-6)) return false;
            return ['x', 'y', 'z'].every(axis => {
              const key = axis as keyof typeof position;
              return Math.abs(observed.position[key] - position[key]) < 1e-6
                && Math.abs(observed.target[key] - target[key]) < 1e-6
                && Math.abs(observed.up[key] - requested.up[key]) < 1e-6;
            });
          }, { timeout: 10_000, message: 'production camera reaches the requested matching pose' }).toBe(true);
          // Await painted production frames after existing selection/camera effects.
          await page.evaluate(() => new Promise<void>(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))));
          const name = `${pose.name}-zoom${zoom}-${projectionMode}-${selection}`;
          await sample(`${name}-before-capture`);
          let capture: Awaited<ReturnType<typeof Probe.captureProbeFrame>>;
          try {
            capture = await page.evaluate(async url => {
              const probe: typeof Probe = await import(url);
              return probe.captureProbeFrame();
            }, moduleUrl);
          } finally {
            await sample(`${name}-after-capture-attempt`);
          }
          expect(capture.rawFrameAvailable, 'actual raw renderer readback must exist; absence is not a deferred density failure').toBe(true);
          // Render epoch can advance between captures; actual camera geometry
          // and matrices must remain the same across both real readbacks.
          expect(capture.before.camera?.position).toEqual(capture.after.camera?.position);
          expect(capture.before.camera?.target).toEqual(capture.after.camera?.target);
          expect(capture.before.camera?.viewProjection).toEqual(capture.after.camera?.viewProjection);
          expect(capture.after.camera?.projectionMode).toBe(projectionMode);
          expect(capture.after.camera?.viewProjection.every(Number.isFinite)).toBe(true);
          expect(capture.after.rendererDiagnostics?.gpuErrors, 'actual renderer uncaptured GPU errors').toBe(0);
          expect(capture.after.rendererDiagnostics?.errors, 'actual renderer execution errors').toBe(0);
          expect(capture.after.selected).toEqual(selection === 'unselected' ? [] : [
            capture.after.identities.find(nut => nut.alias === selection)!.globalId,
          ]);
          const png = Buffer.from(capture.png.slice('data:image/png;base64,'.length), 'base64');
          writeFileSync(info.outputPath(`${name}-renderer.png`), png);
          await info.attach(`${name}-renderer`, { body: png, contentType: 'image/png' });
          await page.screenshot({ path: info.outputPath(`${name}-ui.png`), fullPage: true });
          const pngWitness = classifyViewportWitness({ frame: decodePng(png), lossEvidence: null, strict: true });
          report.frames.push({ name, requested, observed: capture.after,
            pngSHA: createHash('sha256').update(png).digest('hex'), rawWitness: capture.witness, pngWitness });
          const witness = capture.witness;
          // Retain later diagnostic views after a density failure. The same
          // classifiers and threshold still reject the whole cohort below.
          if (witness.status !== 'rendered') {
            densityFailures.push(`${name}: ${witness.summary}; presence is not an occlusion verdict`);
          }
          if (pngWitness.status !== 'rendered') {
            densityFailures.push(`${name} retained PNG: ${pngWitness.summary}`);
          }
          expect(errors, `no unhandled/GPU failures at ${name}`).toEqual([]);
        }
      }
    }
    expect(report.frames).toHaveLength(36);
    errors.push(...densityFailures);
    expect(densityFailures, 'all unchanged raw/PNG density classifications must pass; diagnostic retention grants no waiver').toEqual([]);
    report.status = 'FUNCTIONAL_FRAMES_CAPTURED_OCCLUSION_VERDICT_PENDING';
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    // Preserve partial observations and failures, never convert a failed run
    // into successful acceptance or discard a device-loss report.
    await sample('terminal-before-server-close');
    if (cdp) {
      try { await cdp.detach(); }
      catch (error) {
        errors.push(`Browser CDP detach failed: ${error instanceof Error ? error.message : String(error)}`);
        console.warn('Reporter #6729 browser CDP detach failed:', error);
      }
    }
    if (errors.length > 0) report.status = 'INCOMPLETE';
    const body = JSON.stringify(report, null, 2);
    writeFileSync(info.outputPath('reporter-6729-report.json'), body);
    await info.attach('reporter-6729-report', { body, contentType: 'application/json' });
    await server.close();
  }
});
