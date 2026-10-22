/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Deterministic 120 Hz frame-cost rig (#6960, perf charter #6954).
 *
 *   pnpm --filter @ifc-lite/viewer build
 *   pnpm exec playwright install chromium-headless-shell
 *   pnpm test:benchmark:frames
 *
 * Drives chrome-headless-shell frame by frame over CDP BeginFrame (see
 * begin-frame-driver.ts for why that browser and those flags) through three
 * scenarios per fixture: a streaming load from the file input, a scripted
 * left-drag orbit after Home, and a hover sweep. It records main-thread CPU
 * per frame, frames over the 8.333 ms budget and rendered-vs-idle frames, and
 * writes `browser-frames` rows ({fixture, scenario, metric, value}) to
 * FRAME_RIG_OUT (default test-results/browser-frames.json).
 *
 * GPU time is excluded by construction: the WebGPU adapter here is SwiftShader.
 * The numbers describe main-thread JS/layout cost and how much GPU work the
 * app encodes, never how fast a GPU executes it. That is the real-GPU rig's
 * job (scripts/perf/frame-gpu-rig.mts).
 */

import { test, expect, type Browser, type Page } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { BeginFrameDriver } from './begin-frame-driver.js';
import { frameProbeInitScript } from './frame-probe.js';
import { instanceDiagnosticsInitScript } from './instance-diagnostics.js';
import { drivenFrameRows, FRAME_BUDGET_MS, type BrowserFramesRow, type DrivenFrame } from './frame-stats.js';
import { readGpuHealth, type GpuHealth } from '../gpu-health.js';
import { probeMetadataRenderTrace, waitForMetadataRenderReadiness, type LoadTraceProbe } from '../metadata-render-readiness.js';
import { FRAME_FIXTURES, MAX_ATTEMPTS } from './frame-evidence.js';
import { homeKey, hoverSweep, orbitGesture, type CanvasRect } from './frame-scenarios.js';

const ROOT = process.cwd();
const FIXTURES = FRAME_FIXTURES;
const OUT = resolve(ROOT, process.env.FRAME_RIG_OUT ?? 'test-results/browser-frames.json');
// Pair with DEBUG=pw:browser for browser/GPU-process stderr (#7655).
const INSTANCE_DIAGNOSTICS = process.env.FRAME_INSTANCE_DIAGNOSTICS === '1';
const ORBIT_FRAMES = 120, INERTIA_FRAMES = 90, HOVER_FRAMES = 120, TAIL_FRAMES = 30, IDLE_FRAMES = 30;

const rows: BrowserFramesRow[] = [];
const samples: FrameSample[] = [];
// Contaminated attempts a fresh browser replaced: retained, never admitted.
const refusedAttempts: FrameSample[] = [];

interface FrameSample {
  fixture: string; attempt: number; completed: boolean; error: string | null;
  readiness: LoadTraceProbe | null; readinessError: string | null; pageErrors: string[]; gpuHealth: GpuHealth | null;
  instanceDiagnostics?: string;
}

test.describe.configure({ mode: 'serial' });

/** One full load/orbit/hover pass in its own browser; failures are recorded, not thrown. */
async function runAttempt(browser: Browser, fixture: (typeof FIXTURES)[number], file: string, attempt: number) {
  const sample: FrameSample = { fixture: fixture.name, attempt, completed: false, error: null, readiness: null,
    readinessError: null, pageErrors: [], gpuHealth: null };
  const attemptRows: BrowserFramesRow[] = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const logs: string[] = [];
  const diagnosticEvents: Array<{ wallMs: number; kind: string; text: string }> = [];
  let page: Page | null = null;
  try {
    page = await context.newPage();
    page.on('console', message => {
      logs.push(message.text());
      if (INSTANCE_DIAGNOSTICS) diagnosticEvents.push({ wallMs: Date.now(), kind: `console.${message.type()}`, text: message.text() });
    });
    page.on('pageerror', error => {
      sample.pageErrors.push(String(error));
      if (INSTANCE_DIAGNOSTICS) diagnosticEvents.push({ wallMs: Date.now(), kind: 'pageerror', text: String(error) });
    });
    if (INSTANCE_DIAGNOSTICS) {
      page.on('crash', () => diagnosticEvents.push({ wallMs: Date.now(), kind: 'page-crash', text: 'Page crashed' }));
      await context.addInitScript({ content: instanceDiagnosticsInitScript() });
    }
    await context.addInitScript({ content: frameProbeInitScript({ workDone: false }) });
    const driver = await BeginFrameDriver.attach(context, page);

    await driver.during(page.goto('/?perfTrace=1'));
    await driver.during(page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 60_000 }));
    await driver.settle();
    await driver.calibrate();

    // 1. Streaming load: from the file-input change through stream complete
    //    until the scene has rendered and gone idle (the whole J1 frame cost).
    const streamed = page.waitForEvent('console', { predicate: (m) => m.text().includes('Stream complete for'), timeout: 240_000 });
    const loading = Promise.all([page.locator('input[type="file"]').first().setInputFiles(file), streamed]);
    const load = await driver.record({ until: loading, settleIdleFrames: IDLE_FRAMES });

    // 2. Orbit: Home, settle, then a scripted left-drag and its inertia.
    for (const step of homeKey()) await driver.frame(step);
    await driver.settle();
    const rect = await page.evaluate((): CanvasRect | null => {
      const canvas = document.querySelector('canvas[data-viewport="main"]');
      if (!canvas) return null;
      const box = canvas.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    });
    expect(rect, 'main viewport canvas').not.toBeNull();
    const orbit = orbitGesture(rect!, ORBIT_FRAMES);
    const orbitFrames = await driver.record({ clock: 'lockstep', frames: orbit.length + INERTIA_FRAMES, input: (i) => orbit[i] ?? [] });
    await driver.settle();

    // 3. Hover sweep: no button held, picking under the cursor every frame.
    const hover = hoverSweep(rect!, HOVER_FRAMES);
    const hoverFrames = await driver.record({ clock: 'lockstep', frames: hover.length + TAIL_FRAMES, input: (i) => hover[i] ?? [] });

    const scenarios: Array<[string, DrivenFrame[]]> = [['streaming-load', load], ['orbit', orbitFrames], ['hover', hoverFrames]];
    for (const [scenario, frames] of scenarios) {
      // On a settled viewer the loop re-arms rAF every frame, so a gap means
      // the join (or the page) is broken and per-frame numbers lie. During a
      // load a frame without rAF is real: the viewport is not mounted yet, or
      // a long main-thread task swallowed the BeginMainFrame (a dropped frame).
      if (scenario !== 'streaming-load') {
        expect(frames.filter((frame) => frame.page === null).length, `${scenario}: frames without a rAF record`).toBe(0);
      }
      attemptRows.push(...drivenFrameRows(fixture.name, scenario, frames));
    }
    // The gesture must actually have rendered: an orbit that draws nothing
    // measured nothing. Not every frame: the viewer's adaptive throttle
    // caps continuous rendering at 40/30 fps once SwiftShader renders run
    // slow, which is the app's real behaviour on a slow device.
    expect(orbitFrames.filter((frame) => (frame.page?.presents ?? 0) > 0).length, 'orbit rendered frames').toBeGreaterThan(ORBIT_FRAMES / 8);
    expect(load.some((frame) => (frame.page?.presents ?? 0) > 0), 'streaming load rendered').toBe(true);
    // Qualification is outside every recorded scenario: keep frame windows
    // unchanged while refusing late parser/finalization failures or timeout.
    const readyPage = page;
    for (const completionMode of ['metadata-render', 'load-root'] as const) {
      await driver.during(waitForMetadataRenderReadiness({
        trace: () => probeMetadataRenderTrace(readyPage), logs: () => logs,
        canvasReady: () => readyPage.evaluate(() => {
          const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-viewport="main"]');
          return !!canvas && canvas.width > 0 && canvas.height > 0;
        }),
        now: () => performance.now(), pause: () => readyPage.waitForTimeout(50),
        timeoutMs: 120_000, completionMode,
      }));
    }
    sample.completed = true;
  } catch (error) {
    sample.error = String(error);
  } finally {
    try {
      if (page) {
        try { sample.readiness = await probeMetadataRenderTrace(page); }
        catch (error) { sample.readinessError = String(error); }
        sample.gpuHealth = await readGpuHealth(page, logs);
      }
    }
    finally {
      try {
        if (INSTANCE_DIAGNOSTICS) {
          const path = `${OUT}.fixture-${FIXTURES.indexOf(fixture)}.attempt-${attempt}.diagnostics.json`;
          mkdirSync(dirname(path), { recursive: true });
          sample.instanceDiagnostics = path;
          writeFileSync(path, JSON.stringify({
            issue: 7655, fixture: fixture.name, attempt, browser: browser.version(),
            performanceEligible: false, boundary: 'before context.close',
            capturedAt: new Date().toISOString(), events: diagnosticEvents,
          }, null, 2));
        }
      } finally { await context.close(); }
    }
  }
  return { sample, rows: attemptRows };
}

for (const fixture of FIXTURES) {
  test(`${fixture.name}: streaming load, orbit and hover at 120 Hz BeginFrame (#6960)`, async ({ playwright }) => {
    const file = join(ROOT, fixture.path);
    test.skip(!existsSync(file), `${fixture.path} missing; run \`pnpm fixtures\``);
    const { channel, headless, launchOptions } = test.info().project.use;

    // Hosted SwiftShader intermittently loses the Dawn instance mid-load and the
    // renderer re-uploads the scene (#6993/#7164). Such an attempt measured a
    // different load, so a FRESH browser replaces it, at most twice; every
    // replaced attempt is kept as evidence. Any other failure is final.
    let result: Awaited<ReturnType<typeof runAttempt>>;
    for (let attempt = 1; ; attempt++) {
      const browser = await playwright.chromium.launch({ ...launchOptions, channel, headless });
      try { result = await runAttempt(browser, fixture, file, attempt); }
      finally { await browser.close(); }
      if (!result.sample.gpuHealth?.contaminated || attempt === MAX_ATTEMPTS) break;
      refusedAttempts.push(result.sample);
    }
    samples.push(result.sample);
    rows.push(...result.rows);
    expect(result.sample.error, 'frame attempt failed').toBeNull();
    expect(result.sample.pageErrors, 'page errors contaminate frame measurements').toEqual([]);
    expect(result.sample.gpuHealth?.contaminated, 'device loss/replacement contaminates frame measurements').toBe(false);
  });
}

test.afterAll(async ({ browser }) => {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({
    family: 'browser-frames',
    rig: 'deterministic-begin-frame',
    schema: 2,
    ...(INSTANCE_DIAGNOSTICS ? { instanceDiagnostics: true, performanceEligible: false } : {}),
    frameBudgetMs: FRAME_BUDGET_MS,
    browser: `chrome-headless-shell ${browser.version()}`,
    gpuTime: 'excluded: WebGPU runs on SwiftShader (CPU rasteriser); no metric here measures GPU execution',
    mainThread: 'CDP Performance.getMetrics TaskDuration in timeTicks (renderer main-thread task wall time), minus DevTools command time',
    samples,
    refusedAttempts,
    rows,
  }, null, 2));
  console.log(`[frame-rig] wrote ${rows.length} rows to ${OUT}`);
});
