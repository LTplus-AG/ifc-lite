/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Page } from '@playwright/test';
import type { Renderer } from '@ifc-lite/renderer';
import { percentile, type BrowserFramesRow } from '../../tests/benchmark/frames/frame-stats.js';

type TimingSnapshot = ReturnType<Renderer['getGpuFrameTiming']>;

/** Existing observer seam; no access to renderer internals or fabricated fallback. */
export async function gpuTimingSnapshot(page: Page): Promise<TimingSnapshot | null> {
  return page.evaluate(() => {
    const host = globalThis as unknown as {
      __ifc_lite_render_stats__?: () => { gpuTiming?: TimingSnapshot };
    };
    return host.__ifc_lite_render_stats__?.().gpuTiming ?? null;
  });
}

/** Keep individual raw receipts as well as aggregation; never label work-done as GPU time. */
export async function collectGpuTiming(
  page: Page, fixture: string, scenario: string, start: number, required: boolean, epoch?: number,
): Promise<{ snapshot: TimingSnapshot | null; rows: BrowserFramesRow[] }> {
  const snapshot = await gpuTimingSnapshot(page);
  if (required && (!snapshot || snapshot.mode !== 'gpu-queries' || snapshot.errors !== 0)) {
    throw new Error(`per-pass GPU timing unavailable or invalid: ${JSON.stringify(snapshot)}`);
  }
  if (!snapshot || snapshot.mode !== 'gpu-queries') return { snapshot, rows: [] };
  if (epoch !== undefined && snapshot.epoch !== epoch) throw new Error(`${scenario}: GPU timing resource epoch changed`);
  const frames = snapshot.frames.filter((frame) => frame.timestamp >= start);
  if (required && frames.length === 0) throw new Error(`${scenario}: no resolved GPU pass samples`);
  const groups = new Map<string, number[]>();
  for (const frame of frames) {
    let total = 0;
    for (const [label, ms] of Object.entries(frame.passesMs)) {
      if (!Number.isFinite(ms) || ms < 0) throw new Error(`${scenario}/${label}: invalid GPU duration`);
      groups.set(label, [...(groups.get(label) ?? []), ms]);
      total += ms;
    }
    groups.set('total', [...(groups.get('total') ?? []), total]);
  }
  const rows: BrowserFramesRow[] = [{ fixture, scenario, metric: 'gpu_timestamp_frames', value: frames.length }];
  for (const [label, values] of groups) {
    for (const p of [50, 95]) rows.push({
      fixture, scenario, metric: `gpu_pass_${label}_ms_p${p}`, value: percentile(values, p),
    });
  }
  return { snapshot: { ...snapshot, frames }, rows };
}
