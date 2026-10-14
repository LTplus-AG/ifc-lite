#!/usr/bin/env -S npx tsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Real-GPU frame-time rig (#6960, perf charter #6954). Manual, local: it
 * drives WINDOWS Chrome from WSL (see frame-gpu-chrome.ts), because WSL's
 * Chromium only has SwiftShader. The CI-capable sibling is the deterministic
 * BeginFrame rig, tests/benchmark/frames/frame-rig.spec.ts.
 *
 *   pnpm --filter @ifc-lite/viewer build
 *   flock /tmp/ifclite-perf.lock npx tsx scripts/perf/frame-gpu-rig.mts \
 *     tests/models/ara3d/AC20-FZK-Haus.ifc --pairs 3 --branch-revision <built revision> \
 *     [--dist-base <base dist> --base-revision <base built revision>]
 *
 * Per sample: a fresh Windows Chrome (random CDP port, throwaway profile),
 * the production build served same-origin with the model at
 * `/__frame-rig/<file>` and loaded via `?model=`, then Home, a scripted CDP
 * left-drag orbit and a hover sweep, one input step per 8.333 ms of wall
 * time. The in-page probe (tests/benchmark/frames/frame-probe.ts) records rAF
 * deltas, GPUQueue.submit / draw* per frame and onSubmittedWorkDone latency
 * (queue + GPU execution, not a GPU timestamp). GPU timestamp queries
 * are opt-in through the M7 gpuFrameTiming flag (#6975). Raw pass receipts
 * accompany each scenario; --require-gpu-timing refuses absent/invalid queries.
 *
 * With --dist-base, base and branch alternate in counterbalanced pairs and
 * the summary reports the median per-pair branch/base ratio: absolute FPS
 * drifts between sessions on the same machine, so only pairs compare.
 *
 * --plan prints the sample schedule; --summarize <runs.jsonl> re-summarises
 * a previous run. Neither needs Chrome.
 */

import { requireSpanSource } from './browser-span-source.mjs';
import { chromium, type Browser, type Page } from '@playwright/test';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import type { CDPSession } from '@playwright/test';
import type { AddressInfo } from 'node:net';
import { frameProbeInitScript, type FrameProbeHandle, type FrameRecord } from '../../tests/benchmark/frames/frame-probe.ts';
import { FRAME_BUDGET_MS, realGpuFrameRows, type BrowserFramesRow } from '../../tests/benchmark/frames/frame-stats.ts';
import { hoverSweep, orbitGesture, type CanvasRect, type CdpInput } from '../../tests/benchmark/frames/frame-scenarios.ts';
import { startStaticServer } from './browser-static-server.js';
import { closeBrowserWithTimeout, raceWithTimeout } from './browser-cold-teardown.js';
import { probeMetadataRenderTrace, waitForMetadataRenderReadiness } from '../../tests/benchmark/metadata-render-readiness.js';
import { isPhysicalConsole, readPhysicalSession } from './frame-gpu-session.js';
import { readHostAdmission } from './frame-gpu-host.js';
import { collectGpuTiming, gpuTimingSnapshot } from './frame-gpu-timestamps.js';
import { findWindowsChrome, launchWindowsChrome } from './frame-gpu-chrome.js';
import { formatSummary, interleavedSchedule, summarizeSamples, type SampleRecord, type Side } from './frame-gpu-summary.js';
import { verifyNightProfile } from './frame-gpu-night-profile.js';
import { readHostProfile, requireBrowserExecutable, requireHostMatch } from './frame-gpu-night-admission.js';
import { readInputIdleReceipt, requireInputIdle } from './frame-gpu-input-idle.js';
import { readOwnedChromeOutput } from './frame-gpu-night-native.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--branch-revision', '--base-revision', '--dist-base', '--dist-branch', '--pairs', '--out-dir', '--chrome', '--orbit-frames', '--hover-frames', '--summarize', '--timeout-ms', '--sample-budget-ms', '--night-profile', '--owner-ledger']);
const flag = (name: string) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1] ?? null; };
const positional = argv.filter((arg, i) => !arg.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1] ?? ''));
const fail = (message: string): never => { console.error(`frame-gpu-rig: ${message}`); process.exit(2); };
const intFlag = (name: string, fallback: number) => {
  const value = Number(flag(name) ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fail(`${name} must be a positive integer`);
};

const REQUIRE_GPU_TIMING = argv.includes('--require-gpu-timing');
const REQUIRE_PHYSICAL = argv.includes('--require-physical-display');
const REQUIRE_HOST_IDLE = argv.includes('--require-host-idle');
const PAIRS = intFlag('--pairs', 3);
const ORBIT_FRAMES = intFlag('--orbit-frames', 240);
const HOVER_FRAMES = intFlag('--hover-frames', 240);
const TIMEOUT_MS = intFlag('--timeout-ms', 180_000);
// Explicit whole-sample cancellation; the Job lifetime includes additional
// bounded startup/retirement time and refuses values above its supported limit.
const SAMPLE_BUDGET_MS = intFlag('--sample-budget-ms', 600_000);
const DIST_BASE = flag('--dist-base') ? resolve(ROOT, flag('--dist-base')!) : null;
const DIST_BRANCH = resolve(ROOT, flag('--dist-branch') ?? 'apps/viewer/dist');

if (argv.includes('--plan')) {
  console.log(JSON.stringify(interleavedSchedule(PAIRS, DIST_BASE !== null)));
  process.exit(0);
}
const summarizeFrom = flag('--summarize');
if (summarizeFrom) {
  const samples = readFileSync(summarizeFrom, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as SampleRecord);
  const summary = summarizeSamples(samples);
  console.log(argv.includes('--json') ? JSON.stringify(summary) : formatSummary(summary));
  process.exit(0);
}

// #7005: admit every supplied build before model, host or browser work.
// Offline plan/summarize intentionally need neither source history nor builds.
const sourceRevisions = {
  branch: requireSpanSource(ROOT, flag('--branch-revision')),
  base: DIST_BASE ? requireSpanSource(ROOT, flag('--base-revision')) : null,
};
const OUT_DIR = resolve(ROOT, flag('--out-dir') ?? `scripts/perf/.frame-gpu-rig-results/run-${Date.now()}`);
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'source-revisions.json'), JSON.stringify(sourceRevisions, null, 2) + '\n');

if (positional.length !== 1) fail('pass exactly one model file');
const MODEL = isAbsolute(positional[0]) ? positional[0] : resolve(ROOT, positional[0]);
if (!existsSync(MODEL)) fail(`model not found: ${MODEL} (public fixtures: \`pnpm fixtures\`)`);
for (const dist of [DIST_BRANCH, DIST_BASE]) if (dist && !existsSync(join(dist, 'index.html'))) fail(`not a viewer build: ${dist}`);
const FIXTURE = basename(MODEL).replace(/\.[^.]+$/, '');
const CHROME = findWindowsChrome(flag('--chrome'));
const nightBytes = flag('--night-profile') ? readFileSync(resolve(flag('--night-profile')!)) : null;
const night = nightBytes ? verifyNightProfile(ROOT, nightBytes) : null;
const nightHost = night ? readHostProfile(ROOT, night.profile) : null;
if (night && (PAIRS !== 1 || DIST_BASE !== null || !REQUIRE_GPU_TIMING || !REQUIRE_PHYSICAL || !REQUIRE_HOST_IDLE
  || resolve(ROOT, night.profile.dist) !== DIST_BRANCH || resolve(ROOT, night.profile.fixture) !== MODEL || !flag('--owner-ledger'))) {
  fail('nightly invocation requires one pinned sample, all strict admissions and an owned browser ledger');
}
if (nightHost) requireBrowserExecutable(nightHost, CHROME);

const JSONL = join(OUT_DIR, 'runs.jsonl');
const MODEL_PATH = `/__frame-rig/${encodeURIComponent(basename(MODEL))}`;

let currentRoot = DIST_BRANCH;
const server = await startStaticServer({ port: 0, host: '127.0.0.1', root: () => currentRoot, extra: new Map([[MODEL_PATH, MODEL]]) });
const ORIGIN = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const take = (page: Page) => page.evaluate(() => (globalThis as unknown as { __ifc_lite_frame_probe__: { take(): FrameRecord[] } }).__ifc_lite_frame_probe__.take());

/** Poll until `idleFrames` consecutive rAF frames presented nothing. */
async function waitIdle(page: Page, idleFrames = 60, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let idle = 0;
  while (idle < idleFrames) {
    if (Date.now() > deadline) throw new Error('viewer did not go idle');
    await sleep(100);
    for (const record of await take(page)) idle = record.presents > 0 ? 0 : idle + 1;
  }
}

/** Replay a gesture at one step per 8.333 ms of wall time, then let inertia and work-done settle. */
async function replay(page: Page, cdp: CDPSession, steps: CdpInput[][], tailMs: number): Promise<FrameRecord[]> {
  await take(page);
  const start = performance.now();
  for (let i = 0; i < steps.length; i++) {
    const due = start + i * FRAME_BUDGET_MS - performance.now();
    if (due > 0) await sleep(due);
    for (const input of steps[i]) await cdp.send(input.method, input.params as never);
  }
  await sleep(tailMs);
  return take(page);
}

async function runSample(pair: number, side: Side): Promise<SampleRecord> {
  currentRoot = side === 'base' ? DIST_BASE! : DIST_BRANCH;
  const record: SampleRecord = { pair, side, ok: false, rows: [], meta: {} };
  const meta = record.meta!;
  meta.browserLaunchAttempted = false;
  let chrome: Awaited<ReturnType<typeof launchWindowsChrome>> | undefined;
  let browser: Browser | undefined;
  const cancellation = new AbortController();
  const sampleTimer = setTimeout(() => cancellation.abort(new Error('whole frame sample budget exceeded')), SAMPLE_BUDGET_MS);
  const interrupted = () => cancellation.abort(new Error('nightly controller interrupted its owned rig'));
  if (night) process.once('SIGTERM', interrupted);
  const pageErrors: string[] = [];
  try {
    if (nightBytes) verifyNightProfile(ROOT, nightBytes); // BEFORE final host/startup admission.
    if (REQUIRE_HOST_IDLE) {
      const admission = await readHostAdmission();
      meta.hostBefore = admission;
      if (!admission.quiet) throw new Error('host pre-admission refused');
    }
    const sessionBefore = readPhysicalSession();
    meta.sessionBefore = sessionBefore;
    if (REQUIRE_PHYSICAL && !isPhysicalConsole(sessionBefore)) throw new Error('physical-console admission refused');
    if (nightHost) {
      const idle = readInputIdleReceipt();
      meta.inputIdleBefore = idle;
      requireInputIdle(idle, sessionBefore.currentSession, nightHost.minimumUserIdleSeconds);
    }
    meta.browserLaunchAttempted = true;
    chrome = await launchWindowsChrome(CHROME, 1, {
      signal: cancellation.signal, runBudgetMs: SAMPLE_BUDGET_MS,
      lifetimeSeconds: Math.ceil((SAMPLE_BUDGET_MS + 30_000 + 3 * 15_000 + 2 * 15_000) / 1000) + 1,
      ...(flag('--owner-ledger') ? { ledger: resolve(flag('--owner-ledger')!) } : {}),
    });
    meta.browserOwner = chrome.owner;
    meta.browserJob = chrome.job.prepared;
    browser = await raceWithTimeout(chromium.connectOverCDP(chrome.cdpUrl), 30_000, 'connectOverCDP');
    const context = browser.contexts()[0];
    await context.addInitScript({ content: frameProbeInitScript({ workDone: true }) });
    const page = context.pages()[0] ?? await context.newPage();
    const cdp = await context.newCDPSession(page);
    const logs: string[] = [];
    page.on('console', (message) => logs.push(message.text()));
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`${ORIGIN}/?model=${MODEL_PATH}&perf.gpuFrameTiming=1&perfTrace=1`);
    await page.bringToFront(); // a background window's rAF is throttled
    await waitForMetadataRenderReadiness({
      trace: () => probeMetadataRenderTrace(page), logs: () => logs,
      canvasReady: () => page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-viewport="main"]');
        return !!canvas && canvas.width > 0 && canvas.height > 0;
      }),
      now: () => performance.now(), pause: () => sleep(50), timeoutMs: TIMEOUT_MS,
    });
    await waitIdle(page);
    const rows = record.rows;
    const settled = await page.evaluate(async () => {
      const host = globalThis as unknown as { __ifc_lite_render_stats__?: () => { frame: { drawCalls: number } | null; gpu: number; adapter?: { vendor?: string; architecture?: string } | null } };
      const stats = host.__ifc_lite_render_stats__?.();
      return { adapter: stats?.adapter ?? null,
        drawCalls: stats?.frame?.drawCalls ?? null, residentGpuBytes: stats?.gpu ?? null, dpr: devicePixelRatio,
        visibility: document.visibilityState, focused: document.hasFocus() };
    });
    Object.assign(meta, settled, { browser: browser.version() });
    if (nightHost) {
      const observed = await readOwnedChromeOutput(chrome), output = observed.output;
      const viewport = await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-viewport="main"]');
        if (!canvas) throw new Error('actual main viewport unavailable');
        return { cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight,
          pixelWidth: canvas.width, pixelHeight: canvas.height, dpr: devicePixelRatio };
      });
      meta.nativeOutputBefore = output; meta.viewportBefore = viewport;
      meta.browserExecutableWin = observed.executableWin;
      requireHostMatch(nightHost, { browserVersion: browser.version(), adapter: settled.adapter,
        viewport, output, executableWin: observed.executableWin });
    }
    if (REQUIRE_PHYSICAL && (!settled.adapter?.vendor || /swiftshader|software|llvmpipe/i.test(JSON.stringify(settled.adapter)))) {
      throw new Error('actual renderer hardware adapter identity missing or software');
    }
    if (settled.drawCalls !== null) rows.push({ fixture: FIXTURE, scenario: 'settled', metric: 'render_draw_calls', value: settled.drawCalls });
    await page.keyboard.press('Home');
    await waitIdle(page);
    await page.screenshot({ path: join(OUT_DIR, `${side}-p${pair}-home.png`) });
    const rect = await page.evaluate((): CanvasRect | null => {
      const box = document.querySelector('canvas[data-viewport="main"]')?.getBoundingClientRect();
      return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
    });
    if (!rect) throw new Error('main viewport canvas not found');
    await page.evaluate(() => (globalThis as unknown as {
      __ifc_lite_frame_probe__: FrameProbeHandle;
    }).__ifc_lite_frame_probe__.beginForegroundGuard());
    const orbitEpoch = (await gpuTimingSnapshot(page))?.epoch;
    const orbitStart = await page.evaluate(() => performance.now());
    rows.push(...realGpuFrameRows(FIXTURE, 'orbit', await replay(page, cdp, orbitGesture(rect, ORBIT_FRAMES), 1500)));
    const orbitGpu = await collectGpuTiming(page, FIXTURE, 'orbit', orbitStart, REQUIRE_GPU_TIMING, orbitEpoch);
    meta.gpuTiming = { orbit: orbitGpu.snapshot };
    rows.push(...orbitGpu.rows);
    await waitIdle(page);
    const hoverEpoch = (await gpuTimingSnapshot(page))?.epoch;
    const hoverStart = await page.evaluate(() => performance.now());
    rows.push(...realGpuFrameRows(FIXTURE, 'hover', await replay(page, cdp, hoverSweep(rect, HOVER_FRAMES), 500)));
    const hoverGpu = await collectGpuTiming(page, FIXTURE, 'hover', hoverStart, REQUIRE_GPU_TIMING, hoverEpoch);
    Object.assign(meta.gpuTiming as object, { hover: hoverGpu.snapshot });
    rows.push(...hoverGpu.rows);
    const timestampQuery = await page.evaluate(() => (globalThis as unknown as { __ifc_lite_frame_probe__: { timestampQueryRequested(): boolean } }).__ifc_lite_frame_probe__.timestampQueryRequested());
    const sessionAfter = readPhysicalSession();
    meta.sessionAfter = sessionAfter;
    if (REQUIRE_PHYSICAL && (!isPhysicalConsole(sessionAfter) || sessionBefore.currentSession !== sessionAfter.currentSession)) {
      throw new Error('physical-console session changed during measurement');
    }
    const foreground = await page.evaluate(() => (globalThis as unknown as {
      __ifc_lite_frame_probe__: FrameProbeHandle;
    }).__ifc_lite_frame_probe__.foreground());
    meta.foreground = foreground;
    if (REQUIRE_PHYSICAL && (foreground.interruptions !== 0 || foreground.visibility !== 'visible' || !foreground.focused)) {
      throw new Error('physical frame run lost foreground admission during measurement');
    }
    meta.timestampQuery = timestampQuery;
    if (nightHost) {
      const observed = await readOwnedChromeOutput(chrome), output = observed.output;
      const viewport = await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-viewport="main"]');
        if (!canvas) throw new Error('actual main viewport unavailable');
        return { cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight,
          pixelWidth: canvas.width, pixelHeight: canvas.height, dpr: devicePixelRatio };
      });
      meta.nativeOutputAfter = output; meta.viewportAfter = viewport;
      meta.browserExecutableWinAfter = observed.executableWin;
      requireHostMatch(nightHost, { browserVersion: browser.version(), adapter: settled.adapter,
        viewport, output, executableWin: observed.executableWin });
      if (pageErrors.length) throw new Error('native nightly page emitted an unhandled error');
    }
    if (REQUIRE_HOST_IDLE) {
      const admission = await readHostAdmission();
      meta.hostAfter = admission;
      if (!admission.quiet) throw new Error('host post-admission refused');
    }
    cancellation.signal.throwIfAborted();
    record.ok = true;
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    console.error(`frame-gpu-rig: ${side} pair ${pair} FAILED: ${record.error}`);
  } finally {
    clearTimeout(sampleTimer);
    meta.pageErrors = pageErrors;
    // connectOverCDP only disconnects; the canonical owned Job retires processes.
    const closeError = await closeBrowserWithTimeout(browser, 15_000);
    const disposeError = (await chrome?.dispose()) ?? null;
    for (const problem of [closeError, disposeError]) if (problem) {
      console.error(`frame-gpu-rig: cleanup: ${problem}`);
      if (problem === disposeError || night) { record.ok = false; record.error = `${record.error ?? ''} cleanup: ${problem}`.trim(); }
    }
    meta.cleanup = { closeError, disposeError };
    if (night) process.removeListener('SIGTERM', interrupted);
  }
  return record;
}

const samples: SampleRecord[] = [];
try {
  for (const { pair, side } of interleavedSchedule(PAIRS, DIST_BASE !== null)) {
    console.log(`frame-gpu-rig: pair ${pair} ${side} (${FIXTURE})`);
    const sample = await runSample(pair, side);
    samples.push(sample);
    appendFileSync(JSONL, `${JSON.stringify(sample)}\n`);
    if (night && !sample.ok) break; // Never replace a failed nightly sample.
  }
} finally {
  server.close();
}
const summary = summarizeSamples(samples);
writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify({ family: 'browser-frames', rig: 'real-gpu-windows-chrome', fixture: FIXTURE, summary }, null, 2));
console.log(formatSummary(summary));
console.log(`frame-gpu-rig: ${samples.filter((s) => s.ok).length}/${samples.length} samples ok; ${OUT_DIR}`);
process.exit(samples.every((s) => s.ok) ? 0 : 1);
