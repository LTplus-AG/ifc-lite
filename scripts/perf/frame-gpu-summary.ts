/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Interleaving and summary for the real-GPU frame rig (#6960). Pure.
 *
 * Absolute frame time on a real GPU drifts between sessions (driver clocks,
 * thermals, compositor state), so a base number and a branch number from
 * different sessions are not comparable. The rig therefore runs base and
 * branch in counterbalanced pairs (AB, BA, AB, ...), each sample in a fresh
 * Chrome, and the verdict is the median of per-pair branch/base ratios.
 */

import { percentile, type BrowserFramesRow } from '../../tests/benchmark/frames/frame-stats.js';

export type Side = 'base' | 'branch';

export interface ScheduledSample { pair: number; side: Side }

export interface SampleRecord extends ScheduledSample {
  ok: boolean;
  error?: string;
  rows: BrowserFramesRow[];
  meta?: Record<string, unknown>;
}

/** `pairs` rounds; with a base, pair i runs base first when i is even, branch first when odd. */
export function interleavedSchedule(pairs: number, withBase: boolean): ScheduledSample[] {
  const schedule: ScheduledSample[] = [];
  for (let pair = 0; pair < pairs; pair++) {
    const order: Side[] = !withBase ? ['branch'] : pair % 2 === 0 ? ['base', 'branch'] : ['branch', 'base'];
    for (const side of order) schedule.push({ pair, side });
  }
  return schedule;
}

export interface SummaryRow {
  fixture: string;
  scenario: string;
  metric: string;
  base: { median: number; min: number; max: number; n: number } | null;
  branch: { median: number; min: number; max: number; n: number } | null;
  /** Median of per-pair branch/base ratios; null without complete pairs. */
  pairedRatio: number | null;
  pairs: number;
}

const stats = (values: number[]) => values.length
  ? { median: percentile(values, 50), min: Math.min(...values), max: Math.max(...values), n: values.length }
  : null;

/** Per-metric medians per side and the paired ratio. Failed samples are dropped, and so is their pair partner's ratio. */
export function summarizeSamples(samples: readonly SampleRecord[]): SummaryRow[] {
  const keyOf = (row: BrowserFramesRow) => `${row.fixture}\u0000${row.scenario}\u0000${row.metric}`;
  const values = new Map<string, Map<number, Partial<Record<Side, number>>>>();
  for (const sample of samples) {
    if (!sample.ok) continue;
    for (const row of sample.rows) {
      if (!Number.isFinite(row.value)) continue;
      const byPair = values.get(keyOf(row)) ?? new Map<number, Partial<Record<Side, number>>>();
      byPair.set(sample.pair, { ...byPair.get(sample.pair), [sample.side]: row.value });
      values.set(keyOf(row), byPair);
    }
  }
  return [...values].map(([key, byPair]) => {
    const [fixture, scenario, metric] = key.split('\u0000');
    const entries = [...byPair.values()];
    const ratios = entries
      .filter((entry): entry is Record<Side, number> => entry.base !== undefined && entry.branch !== undefined && entry.base > 0)
      .map((entry) => entry.branch / entry.base);
    return {
      fixture, scenario, metric,
      base: stats(entries.flatMap((entry) => (entry.base === undefined ? [] : [entry.base]))),
      branch: stats(entries.flatMap((entry) => (entry.branch === undefined ? [] : [entry.branch]))),
      pairedRatio: ratios.length ? Math.round(percentile(ratios, 50) * 1000) / 1000 : null,
      pairs: ratios.length,
    };
  });
}

/** Fixed-width table for the terminal. */
export function formatSummary(rows: readonly SummaryRow[]): string {
  const cell = (side: SummaryRow['base']) => (side ? `${side.median} [${side.min}..${side.max}] n=${side.n}` : '-');
  const lines = rows.map((row) => [
    `${row.fixture}/${row.scenario}`.padEnd(28), row.metric.padEnd(28),
    cell(row.base).padEnd(30), cell(row.branch).padEnd(30),
    row.pairedRatio === null ? '-' : `${row.pairedRatio} (${row.pairs} pairs)`,
  ].join(' '));
  return [['scenario'.padEnd(28), 'metric'.padEnd(28), 'base'.padEnd(30), 'branch'.padEnd(30), 'branch/base'].join(' '), ...lines].join('\n');
}
