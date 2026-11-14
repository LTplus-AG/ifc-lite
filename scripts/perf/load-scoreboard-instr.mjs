/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Retired user-space instructions of one browser open (opt-in `instructions` on a plan or side; Linux only).
 *
 * `instr-chrome.py` wraps Chrome: one `instructions:u` counter per CPU PMU (cpu_core and cpu_atom on hybrid Intel),
 * inherited over the whole Chrome tree from exec on (including the browser process that moves itself into its own
 * systemd scope), sampled every 10 ms as running totals with wall-clock times. Here the totals are interpolated at the
 * open's input event and interactive mark (page performance.timeOrigin + offsets), so the window matches the wall
 * metric. Instructions do not change with clock speed or thermal throttling; work that moves between P- and E-cores
 * keeps its count, so the per-PMU split is reported but the verdict figure is the sum.
 * Not counted: kernel work (:u), anything outside the Chrome tree (the harness, Xvfb, other processes).
 * Live children are in every sample: read() on an inherited event returns the parent's count plus exited children's
 * (child_total_count) plus every live child event (the kernel's __perf_event_read_value walks event->child_list).
 * Proven on Pop (kernel 6.17.9) by the "LIVE inherited children" test: a child still alive held 99.65% of its final count.
 */

import { fileURLToPath } from 'node:url';

export const INSTR_WRAPPER = fileURLToPath(new URL('./instr-chrome.py', import.meta.url));
/** Share of enabled time the counters must have run in a window: complete (below it the PMU was multiplexed; review #10138). */
/**
 * Lifetime PMU coverage required: (sum of the PMUs' running time) / (enabled time) from the first sample to the final
 * totals, read after every descendant exited, when their times are folded in exactly (1.0000000 measured on Pop in three
 * runs with 12 busy children). Within a window the same ratio is NOT a valid test: live inherited children's
 * enabled/running times update lazily and non-atomically across the two PMUs (0.9956-1.0037 over >= 500 ms windows
 * uncontended, about half below 99.99%), while their counts are read live. The window ratio is reported as information.
 * Bound: the tolerance admits a lifetime gap of at most 0.01% of the sample's enabled time; even if all of it fell inside
 * the window, the window's count moves by at most 0.01% x (lifetime / window), about 0.03% (Holter) to 0.08% (FZK). An
 * instruction verdict needs a gain >= 2x the instruction A/A floor (1.0-1.2%), i.e. >= 2%: the tolerance is more than an
 * order of magnitude below the smallest decidable effect.
 */
export const MIN_PMU_COVERAGE = 0.9999;

/** Parse the wrapper's NDJSON: { unavailable } or { samples: [{ t, c: { pmu: count } }] } (time-ordered). */
export function parseInstrSamples(text) {
  const lines = String(text ?? '').split('\n').filter(Boolean);
  const rows = [];
  let final = null;
  for (const line of lines) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.unavailable) return { unavailable: r.unavailable };
    if (Number.isFinite(r.t) && r.c && r.final) final = r;
    else if (Number.isFinite(r.t) && r.c) rows.push(r);
  }
  if (rows.length < 2) return { unavailable: lines.length ? 'fewer than two counter samples' : 'no counter output (wrapper did not run)' };
  // Every sample must carry the same PMUs: a missing one would read as "no change" there (review #10138).
  const keys = (r) => Object.keys(r.c).sort().join(',');
  if (rows.some((r) => keys(r) !== keys(rows[0]) || Object.values(r.c).some((v) => !Number.isFinite(v)))) return { unavailable: 'counter samples with differing or non-numeric PMU sets' };
  // Scheduling coverage (time enabled / running) is required: without it multiplexing cannot be ruled out (review #10138).
  if (rows.some((r) => !Number.isFinite(r.e) || !r.r || keys({ c: r.r }) !== keys(rows[0]) || Object.values(r.r).some((v) => !Number.isFinite(v)))) return { unavailable: 'counter samples without PMU scheduling coverage (time enabled/running)' };
  rows.sort((a, b) => a.t - b.t);
  // Lifetime coverage from the exact final totals (see MIN_PMU_COVERAGE); no final totals = coverage unknown.
  if (!final || !Number.isFinite(final.e) || !final.r) return { unavailable: 'no final counter totals: lifetime PMU coverage unknown' };
  const dE = final.e - rows[0].e, dR = Object.keys(final.r).reduce((a, k) => a + (final.r[k] - (rows[0].r[k] ?? 0)), 0);
  const lifetimeCoverage = dE > 0 ? dR / dE : null;
  if (!(lifetimeCoverage >= MIN_PMU_COVERAGE)) return { unavailable: lifetimeCoverage === null ? 'counters never ran (no enabled time)' : `PMU multiplexed: counters ran ${(lifetimeCoverage * 100).toFixed(4)}% of their enabled time over the sample (>= ${MIN_PMU_COVERAGE * 100}% required)` };
  return { samples: rows, lifetimeCoverage };
}

function at(samples, t) {
  let i = 0;
  while (i < samples.length - 2 && samples[i + 1].t <= t) i++;
  const a = samples[i], b = samples[i + 1];
  const f = b.t === a.t ? 0 : Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
  return Object.fromEntries(Object.keys(a.c).map((k) => [k, a.c[k] + f * ((b.c[k] ?? a.c[k]) - a.c[k])]));
}

/**
 * Instructions between `startMs` and `endMs` (epoch ms): { total, pmu: { name: count }, edgeGapMs } where edgeGapMs is
 * the largest distance from a window edge to its nearest sample (interpolation span). Null figures with `unavailable`
 * when the window is not covered by samples.
 */
export function instructionsIn(parsed, startMs, endMs) {
  if (parsed.unavailable) return { total: null, pmu: null, unavailable: parsed.unavailable };
  const s = parsed.samples;
  if (!(endMs > startMs) || startMs < s[0].t || endMs > s.at(-1).t) {
    return { total: null, pmu: null, unavailable: `window ${Math.round(startMs)}..${Math.round(endMs)} not covered by counter samples ${Math.round(s[0].t)}..${Math.round(s.at(-1).t)}` };
  }
  const a = at(s, startMs), b = at(s, endMs);
  const pmu = Object.fromEntries(Object.keys(b).map((k) => [k, Math.max(0, Math.round(b[k] - (a[k] ?? 0)))]));
  // A loop, not Math.min(...spread): a long run can hold more samples than a call takes arguments (review #10138).
  const gap = (t) => { let m = Infinity; for (const r of s) m = Math.min(m, Math.abs(r.t - t)); return m; };
  // Coverage over the samples bracketing the window: the PMUs' running time over the enabled time. Each task runs on one
  // core type at a time, so without multiplexing the running times sum to the enabled time (1.0000 measured on Pop).
  let i0 = 0;
  while (i0 < s.length - 1 && s[i0 + 1].t <= startMs) i0++;
  let i1 = s.length - 1;
  while (i1 > 0 && s[i1 - 1].t >= endMs) i1--;
  const dE = s[i1].e - s[i0].e, dR = Object.keys(s[i1].r).reduce((acc, k) => acc + (s[i1].r[k] - s[i0].r[k]), 0);
  // No enabled time between the bracketing samples: the counters did not run, so nothing was measured (review #10138).
  if (!(dE > 0)) return { total: null, pmu: null, coverage: null, unavailable: 'counters not running in this window (no enabled time)' };
  // Information only (see MIN_PMU_COVERAGE): the window ratio, unrounded, and the lifetime ratio that decided.
  return { total: Object.values(pmu).reduce((x, y) => x + y, 0), pmu, coverage: dR / dE, lifetimeCoverage: parsed.lifetimeCoverage, edgeGapMs: Math.round(Math.max(gap(startMs), gap(endMs)) * 10) / 10 };
}

/**
 * Instruction figures for each lane of a sample that requested counting: the window's count, or `unavailable` with the
 * reason (platform, permissions, wrapper output) on every lane, so the report shows why (review #10138).
 * `windows`: [{ lane, window: [startEpochMs, endEpochMs] }]; `parsed`: parseInstrSamples output or null.
 */
export function laneInstructions(lanes, { parsed = null, windows = [], unavailable = null }) {
  const reason = unavailable ?? parsed?.unavailable ?? null;
  for (const [name, lane] of Object.entries(lanes)) {
    const w = windows.find((x) => x.lane === name);
    lane.instructions = reason ? { total: null, pmu: null, unavailable: reason }
      : w ? instructionsIn(parsed, w.window[0], w.window[1]) : { total: null, pmu: null, unavailable: 'no measured window for this lane (open failed)' };
  }
  return lanes;
}
