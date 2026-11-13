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
 */

import { fileURLToPath } from 'node:url';

export const INSTR_WRAPPER = fileURLToPath(new URL('./instr-chrome.py', import.meta.url));

/** Parse the wrapper's NDJSON: { unavailable } or { samples: [{ t, c: { pmu: count } }] } (time-ordered). */
export function parseInstrSamples(text) {
  const lines = String(text ?? '').split('\n').filter(Boolean);
  const rows = [];
  for (const line of lines) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.unavailable) return { unavailable: r.unavailable };
    if (Number.isFinite(r.t) && r.c && !r.final) rows.push(r);
  }
  if (rows.length < 2) return { unavailable: lines.length ? 'fewer than two counter samples' : 'no counter output (wrapper did not run)' };
  rows.sort((a, b) => a.t - b.t);
  return { samples: rows };
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
  const gap = (t) => Math.min(...s.map((r) => Math.abs(r.t - t)));
  return { total: Object.values(pmu).reduce((x, y) => x + y, 0), pmu, edgeGapMs: Math.round(Math.max(gap(startMs), gap(endMs)) * 10) / 10 };
}
