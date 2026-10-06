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

import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { BeginFrameDriver } from './begin-frame-driver.js';
import { frameProbeInitScript } from './frame-probe.js';
import { drivenFrameRows, FRAME_BUDGET_MS, type BrowserFramesRow, type DrivenFrame } from './frame-stats.js';
import { homeKey, hoverSweep, orbitGesture, type CanvasRect } from './frame-scenarios.js';

const ROOT = process.cwd();
const FIXTURES = [
  { name: 'AC20-FZK-Haus', path: 'tests/models/ara3d/AC20-FZK-Haus.ifc' },
  { name: 'Snowdon', path: 'tests/models/various/01_Snowdon_Towers_Sample_Structural(1).ifc' },
];
const OUT = resolve(ROOT, process.env.FRAME_RIG_OUT ?? 'test-results/browser-frames.json');
const ORBIT_FRAMES = 120, INERTIA_FRAMES = 90, HOVER_FRAMES = 120, TAIL_FRAMES = 30, IDLE_FRAMES = 30;

const rows: BrowserFramesRow[] = [];

test.describe.configure({ mode: 'serial' });

for (const fixture of FIXTURES) {
  test(`${fixture.name}: streaming load, orbit and hover at 120 Hz BeginFrame (#6960)`, async ({ browser }) => {
    const file = join(ROOT, fixture.path);
    test.skip(!existsSync(file), `${fixture.path} missing; run \`pnpm fixtures\``);

    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    try {
      await context.addInitScript({ content: frameProbeInitScript({ workDone: false }) });
      const page = await context.newPage();
      const driver = await BeginFrameDriver.attach(context, page);

      await driver.during(page.goto('/'));
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
        rows.push(...drivenFrameRows(fixture.name, scenario, frames));
      }
      // The gesture must actually have rendered: an orbit that draws nothing
      // measured nothing. Not every frame: the viewer's adaptive throttle
      // caps continuous rendering at 40/30 fps once SwiftShader renders run
      // slow, which is the app's real behaviour on a slow device.
      expect(orbitFrames.filter((frame) => (frame.page?.presents ?? 0) > 0).length, 'orbit rendered frames').toBeGreaterThan(ORBIT_FRAMES / 8);
      expect(load.some((frame) => (frame.page?.presents ?? 0) > 0), 'streaming load rendered').toBe(true);
    } finally {
      await context.close();
    }
  });
}

test.afterAll(async ({ browser }) => {
  if (rows.length === 0) return;
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({
    family: 'browser-frames',
    rig: 'deterministic-begin-frame',
    schema: 1,
    frameBudgetMs: FRAME_BUDGET_MS,
    browser: `chrome-headless-shell ${browser.version()}`,
    gpuTime: 'excluded: WebGPU runs on SwiftShader (CPU rasteriser); no metric here measures GPU execution',
    mainThread: 'CDP Performance.getMetrics TaskDuration in threadTicks (renderer main-thread CPU), minus DevTools command time',
    rows,
  }, null, 2));
  console.log(`[frame-rig] wrote ${rows.length} rows to ${OUT}`);
});
