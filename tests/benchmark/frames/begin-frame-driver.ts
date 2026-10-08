/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Deterministic 120 Hz frame driver over CDP `HeadlessExperimental.beginFrame`
 * (#6960).
 *
 * Under `--enable-begin-frame-control` the browser produces a frame only when
 * told to, so the harness owns the clock. Frame times sit on one exact
 * 120 Hz grid, `t0 + k * 8.333 ms`, in one of two clocks per recording:
 *
 *   on-time   frame k is issued when wall time reaches its slot; when a frame
 *             overruns (a long task), the next takes the current slot and the
 *             skipped slots count as missed vsyncs, as on a real display.
 *             Used for the streaming load and between scenarios.
 *   lockstep  every frame takes the next slot (never issued faster than
 *             120 Hz of wall time), so the page sees exactly 8.333 ms per
 *             frame however slow SwiftShader rasterises and the camera replays
 *             the same trajectory, inertia included. Used for scripted input.
 *
 * Why not lockstep everywhere? Measured: once lockstep frame time lags wall
 * time while the main thread is saturated (a streaming load), Chrome's
 * scheduler treats the BeginFrames as missed and skips BeginMainFrame to
 * recover latency, and rAF stops firing. A settled viewer under scripted
 * input keeps up, so lockstep holds there (the spec asserts every lockstep
 * frame ran rAF).
 *
 * WHICH CHROME (verified 2026-10, Chrome 153): `HeadlessExperimental.beginFrame`
 * exists only in `chrome-headless-shell` (Playwright's default headless
 * Chromium). New-headless `chrome --headless` answers "'HeadlessExperimental.
 * beginFrame' wasn't found". The shell exposes WebGPU (SwiftShader adapter)
 * on a secure origin (`http://localhost`) with the Vulkan flags below.
 *
 * Input must not be awaited before its frame: under begin-frame control
 * `Input.dispatch*Event` acknowledges only once a frame has run, so each
 * frame sends its input and the BeginFrame together and awaits both.
 *
 * Main-thread time per frame comes from CDP `Performance.getMetrics`
 * (`TaskDuration`, renderer main-thread task wall time), minus the DevTools
 * command time the metrics call itself costs. The `threadTicks` domain would
 * give CPU time, but on chrome-headless-shell 153 it reported ~0 for a load. GPU time is NOT measured: on SwiftShader the "GPU" is
 * CPU rasterisation on other threads, and no number here describes a GPU.
 */

import type { BrowserContext, CDPSession, Page } from '@playwright/test';
import type { FrameRecord } from './frame-probe.js';
import { FRAME_BUDGET_MS, type DrivenFrame } from './frame-stats.js';
import type { CdpInput } from './frame-scenarios.js';

/** Chrome flags for the deterministic rig (chrome-headless-shell). */
export const BEGIN_FRAME_CHROME_ARGS = [
  '--enable-begin-frame-control',
  '--run-all-compositor-stages-before-draw',
  '--disable-threaded-animation',
  '--disable-threaded-scrolling',
  '--disable-checker-imaging',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-vulkan=swiftshader',
  '--disable-vulkan-surface',
  '--ignore-gpu-blocklist',
  '--enable-gpu',
];

/** CLOCK_MONOTONIC in ms: on Linux the same clock Chrome's TimeTicks read. */
export const monotonicMs = () => Number(process.hrtime.bigint()) / 1e6;

export interface RecordPlan {
  /**
   * 'on-time' (default): frame time tracks wall time on the grid, overruns
   * skip slots. 'lockstep': every frame takes the next slot, so the page sees
   * exactly 8.333 ms per frame however slow SwiftShader is; only safe while the
   * main thread keeps up (see the class comment), which scripted gestures on a
   * settled viewer do and a streaming load does not.
   */
  clock?: 'on-time' | 'lockstep';
  frames?: number;
  input?: (i: number) => readonly CdpInput[];
  until?: Promise<unknown>;
  settleIdleFrames?: number;
  maxFrames?: number;
}

interface CdpFrame { slot: number; skippedSlots: number; mainThreadMs: number; scriptMs: number }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class BeginFrameDriver {
  /** Grid origin (ms, Chrome TimeTicks) and the last slot issued. */
  private t0 = 0;
  private slot = 0;
  private lastIssueWall = 0;
  /** Set by record({ clock: 'lockstep' }): every frame takes the next slot, wall time may lag. */
  private lockstep = false;
  private lastMetrics: Record<string, number> = {};
  /** page rAF timestamp = frameTime - offset; set by calibrate(). */
  private offset: number | null = null;

  private constructor(private readonly cdp: CDPSession, private readonly page: Page) {}

  static async attach(context: BrowserContext, page: Page): Promise<BeginFrameDriver> {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable', { timeDomain: 'timeTicks' });
    const driver = new BeginFrameDriver(cdp, page);
    driver.t0 = monotonicMs();
    driver.lastMetrics = await driver.metrics();
    return driver;
  }

  private frameTime(slot: number): number {
    return this.t0 + slot * FRAME_BUDGET_MS;
  }

  private async metrics(): Promise<Record<string, number>> {
    const { metrics } = await this.cdp.send('Performance.getMetrics');
    return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
  }

  /** Issue one BeginFrame (with any input for it) and measure the interval it closed. */
  async frame(inputs: readonly CdpInput[] = []): Promise<CdpFrame> {
    let slot = this.slot + 1;
    if (this.lockstep) {
      const wait = this.lastIssueWall + FRAME_BUDGET_MS - monotonicMs();
      if (wait > 0) await sleep(wait);
    } else {
      const late = monotonicMs() - this.frameTime(slot);
      if (late < 0) await sleep(-late);
      else slot = Math.max(slot, Math.floor((monotonicMs() - this.t0) / FRAME_BUDGET_MS));
    }
    this.lastIssueWall = monotonicMs();
    const skippedSlots = slot - this.slot - 1;
    this.slot = slot;
    const frameTime = this.frameTime(slot);
    const sent = inputs.map((input) => this.cdp.send(input.method, input.params as never));
    await this.cdp.send('HeadlessExperimental.beginFrame', { frameTimeTicks: frameTime, interval: FRAME_BUDGET_MS });
    await Promise.all(sent);
    const now = await this.metrics();
    const delta = (name: string) => ((now[name] ?? 0) - (this.lastMetrics[name] ?? 0)) * 1000;
    const measured = {
      slot,
      skippedSlots,
      mainThreadMs: Math.max(0, delta('TaskDuration') - delta('DevToolsCommandDuration')),
      scriptMs: delta('ScriptDuration'),
    };
    this.lastMetrics = now;
    return measured;
  }

  /** Keep frames flowing until `action` settles (navigation, file input, ...). */
  async during<T>(action: Promise<T>, maxFrames = 120 * 120): Promise<T> {
    let settled = false;
    const tracked = action.finally(() => { settled = true; });
    for (let i = 0; !settled && i < maxFrames; i++) await this.frame();
    return tracked;
  }

  private take(): Promise<FrameRecord[]> {
    return this.page.evaluate(() => {
      const probe = (globalThis as unknown as { __ifc_lite_frame_probe__?: { take(): FrameRecord[] } }).__ifc_lite_frame_probe__;
      if (!probe) throw new Error('frame probe not installed');
      return probe.take();
    });
  }

  /**
   * Learn the page's rAF time base (rAF timestamps share the
   * `performance.now()` timeline). Call after navigation, before recording.
   * Error is half a CDP round trip; record() joins on the 8.333 ms frame
   * grid, so anything under ~4 ms is exact.
   */
  async calibrate(): Promise<void> {
    const before = monotonicMs();
    const pageNow = await this.page.evaluate(() => performance.now());
    this.offset = (before + monotonicMs()) / 2 - pageNow;
  }

  /** Run frames until `idleFrames` consecutive frames presented nothing. Returns frames spent. */
  async settle(idleFrames = 30, maxFrames = 120 * 60): Promise<number> {
    // A frame with no rAF record (no viewport mounted yet) presented nothing either.
    let idle = 0, spent = 0;
    while (idle < idleFrames && spent < maxFrames) {
      for (let i = 0; i < 10; i++, spent++) await this.frame();
      idle = (await this.take()).some((record) => record.presents > 0) ? 0 : idle + 10;
    }
    if (idle < idleFrames) throw new Error(`viewer did not go idle within ${maxFrames} frames`);
    return spent;
  }

  /**
   * Record one scenario: first frames until `until` settles (if
   * given), then `frames` scripted frames (`input(i)` is frame i's input),
   * then, with `settleIdleFrames`, frames until the viewer has rendered at
   * least once and then presented nothing for that many frames in a row.
   */
  async record(plan: RecordPlan): Promise<DrivenFrame[]> {
    if (this.offset === null) throw new Error('record() before calibrate()');
    const { clock = 'on-time', frames = 0, input = () => [], until, settleIdleFrames = 0, maxFrames = 120 * 300 } = plan;
    await this.take();
    const offset = this.offset;
    const cdpFrames: CdpFrame[] = [];
    const bySlot = new Map<number, FrameRecord>();
    // Join on the slot both sides share: rAF ts + offset lies on the t0 + k * 8.333 grid.
    const collect = async () => {
      for (const record of await this.take()) bySlot.set(Math.round((record.ts + offset - this.t0) / FRAME_BUDGET_MS), record);
    };
    const step = async (inputs: readonly CdpInput[] = []) => {
      if (cdpFrames.length >= maxFrames) throw new Error(`scenario did not reach its end condition within ${maxFrames} frames`);
      cdpFrames.push(await this.frame(inputs));
    };
    let settled = until === undefined;
    until?.then(() => { settled = true; }, () => { settled = true; });
    this.lockstep = clock === 'lockstep';
    try {
      while (!settled) await step();
      await until; // surface a rejected end condition
      for (let i = 0; i < frames; i++) await step(input(i));
      while (settleIdleFrames > 0) {
        for (let i = 0; i < 10; i++) await step();
        await collect();
        const presented = cdpFrames.map((frame) => (bySlot.get(frame.slot)?.presents ?? 0) > 0);
        const last = presented.lastIndexOf(true);
        if (last !== -1 && presented.length - 1 - last >= settleIdleFrames) break;
      }
      await this.frame(); // closes the last recorded frame's page record
    } finally {
      this.lockstep = false;
    }
    await collect();
    return cdpFrames.map((frame) => ({
      mainThreadMs: frame.mainThreadMs,
      scriptMs: frame.scriptMs,
      skippedSlots: frame.skippedSlots,
      page: bySlot.get(frame.slot) ?? null,
    }));
  }
}
