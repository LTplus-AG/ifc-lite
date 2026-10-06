/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Frame statistics and the `browser-frames` row shape shared by both
 * frame-time rigs (#6960). Pure: no browser, no Playwright.
 *
 * Rows are flat `{ fixture, scenario, metric, value }` so a future ratchet
 * family (`browser-frames`, M4 #6959) can key a ceiling on
 * `fixture/scenario/metric` without knowing either rig.
 */

import type { FrameRecord } from './frame-probe.js';

/** 120 Hz: the frame budget both rigs judge against. */
export const FRAME_BUDGET_MS = 1000 / 120;

export interface BrowserFramesRow {
  fixture: string;
  scenario: string;
  metric: string;
  value: number;
}

/** Nearest-rank percentile (p in [0, 100]); NaN for an empty input. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

const round = (value: number, digits = 3) => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/** One driven frame of the deterministic rig: CDP side joined with the page record. */
export interface DrivenFrame {
  /** Main-thread task time (ms, renderer main thread CPU) between this frame and the previous one. */
  mainThreadMs: number;
  /** Script share of `mainThreadMs`. */
  scriptMs: number;
  /** 120 Hz slots skipped before this frame because the previous one overran. */
  skippedSlots: number;
  /** The page's rAF record for this frame, or null when no rAF callback ran. */
  page: FrameRecord | null;
}

/** Deterministic-rig rows for one scenario. GPU time is deliberately absent. */
export function drivenFrameRows(fixture: string, scenario: string, frames: readonly DrivenFrame[]): BrowserFramesRow[] {
  const main = frames.map((frame) => frame.mainThreadMs);
  const raf = frames.map((frame) => frame.page?.cbMs ?? 0);
  const rendered = frames.filter((frame) => (frame.page?.presents ?? 0) > 0);
  const metrics: Record<string, number> = {
    frames: frames.length,
    rendered_frames: rendered.length,
    idle_frames: frames.length - rendered.length,
    frames_without_raf: frames.filter((frame) => frame.page === null).length,
    frames_over_budget: main.filter((ms) => ms > FRAME_BUDGET_MS).length,
    missed_vsyncs: sum(frames.map((frame) => frame.skippedSlots)),
    main_thread_ms_total: round(sum(main)),
    main_thread_ms_p50: round(percentile(main, 50)),
    main_thread_ms_p95: round(percentile(main, 95)),
    main_thread_ms_max: round(Math.max(0, ...main)),
    script_ms_total: round(sum(frames.map((frame) => frame.scriptMs))),
    raf_js_ms_total: round(sum(raf)),
    raf_js_ms_p95: round(percentile(raf, 95)),
    gpu_submits: sum(frames.map((frame) => (frame.page?.submits ?? 0) + (frame.page?.outsideSubmits ?? 0))),
    gpu_draws: sum(frames.map((frame) => frame.page?.draws ?? 0)),
    gpu_write_kib: round(sum(frames.map((frame) => (frame.page?.writeBytes ?? 0) + (frame.page?.outsideWriteBytes ?? 0))) / 1024, 1),
  };
  return Object.entries(metrics).map(([metric, value]) => ({ fixture, scenario, metric, value }));
}

/** Real-GPU rows for one scenario: rAF cadence plus per-rendered-frame GPU work. */
export function realGpuFrameRows(fixture: string, scenario: string, frames: readonly FrameRecord[]): BrowserFramesRow[] {
  const deltas: number[] = [];
  for (let i = 1; i < frames.length; i++) deltas.push(frames[i].ts - frames[i - 1].ts);
  const rendered = frames.filter((frame) => frame.presents > 0);
  const workDone = rendered.map((frame) => frame.workDoneMs).filter((ms): ms is number => ms !== null);
  const perRendered = (pick: (frame: FrameRecord) => number) => (rendered.length ? sum(rendered.map(pick)) / rendered.length : Number.NaN);
  const metrics: Record<string, number> = {
    frames: frames.length,
    rendered_frames: rendered.length,
    raf_delta_ms_p50: round(percentile(deltas, 50)),
    raf_delta_ms_p95: round(percentile(deltas, 95)),
    raf_delta_ms_max: round(deltas.length ? Math.max(...deltas) : Number.NaN),
    frames_over_budget: deltas.filter((ms) => ms > FRAME_BUDGET_MS * 1.5).length,
    raf_js_ms_p95: round(percentile(frames.map((frame) => frame.cbMs), 95)),
    submits_per_rendered_frame: round(perRendered((frame) => frame.submits), 2),
    draws_per_rendered_frame: round(perRendered((frame) => frame.draws), 1),
    work_done_ms_p50: round(percentile(workDone, 50)),
    work_done_ms_p95: round(percentile(workDone, 95)),
  };
  return Object.entries(metrics).map(([metric, value]) => ({ fixture, scenario, metric, value }));
}

/** Spread of one metric across repeated runs: [min, max] and max/min ratio. */
export function rowSpread(runs: readonly (readonly BrowserFramesRow[])[]): Array<BrowserFramesRow & { min: number; max: number; ratio: number }> {
  const groups = new Map<string, number[]>();
  for (const run of runs) for (const row of run) {
    const key = `${row.fixture}\u0000${row.scenario}\u0000${row.metric}`;
    groups.set(key, [...(groups.get(key) ?? []), row.value]);
  }
  return [...groups].map(([key, values]) => {
    const [fixture, scenario, metric] = key.split('\u0000');
    const min = Math.min(...values), max = Math.max(...values);
    return { fixture, scenario, metric, value: percentile(values, 50), min, max, ratio: min > 0 ? round(max / min) : max === 0 ? 1 : Number.POSITIVE_INFINITY };
  });
}
