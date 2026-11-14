/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CPU time (thread time from the opt-in Chrome trace, input event to interactive mark; trace-cpu-time.mjs) as the
 * scoreboard's SECOND measure. The wall-clock verdict stays the verdict; CPU total gets its own verdict column by the
 * same rule (verdictFor: gain >= 2x max(own floor, recorded A/A floor), >= 5 samples per side, no under-load sample;
 * with an A/A reference but no CPU floor for the cell: inconclusive). An A/A run writes `cpuTotalMs` into its floors,
 * so a merged floors file carries CPU floors beside the wall ones.
 * Evidence (quiet lane 2026-11-13, Pop): CPU-total A/A floors 3.6% (FZK) / 1.9% (Holter) with the cap, 6.4% / 9.0% hot
 * and uncapped (CPU time follows thermal throttling); Mac unthrottled 4.3% / 1.3%.
 */

import { aaNoiseFloor, median, verdictFor } from './load-scoreboard-stats.mjs';

/** CPU figures a row can carry, as [label, value of row]. `total` is the verdict metric (floor key cpuTotalMs). */
export const CPU_COLUMNS = [
  ['total', (r) => r.cpuTime?.cpuMs?.total], ['main', (r) => r.cpuTime?.cpuMs?.rendererMain], ['workers', (r) => r.cpuTime?.cpuMs?.workers],
  ['GPU', (r) => r.cpuTime?.cpuMs?.gpu], ['parser.worker (workers)', (r) => r.cpuTime?.stages?.['parser.worker']?.workersCpuMs],
  ['geometry.pool (workers)', (r) => r.cpuTime?.stages?.['geometry.pool']?.workersCpuMs], ['stream.queueDrain (main)', (r) => r.cpuTime?.stages?.['stream.queueDrain']?.mainCpuMs],
  ['scene.finalize (main)', (r) => r.cpuTime?.stages?.['scene.finalize']?.mainCpuMs],
];
export const CPU_FLOOR_KEY = 'cpuTotalMs';

const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '—');
const n0 = (x) => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : '—');

/**
 * Per fixture x browser lane with CPU time: per-side medians of wall interactive and every CPU figure, and for CPU
 * total the verdict (compare) or the A/A floor (aa). Failed samples count as failures, under-load samples as busy,
 * exactly as for the wall verdict.
 */
export function cpuTimeSummary(plan, samples, { floors = null } = {}) {
  const kind = plan.kind ?? 'compare';
  const cells = [];
  for (const fixture of [...new Set(samples.map((r) => r.fixture))]) {
    for (const lane of plan.lanes.filter((l) => l.startsWith('browser'))) {
      const rows = samples.filter((r) => r.fixture === fixture && r.lane === lane);
      // A cell where a second measure was requested is shown even when it was unavailable, with the count and reason (review #10138).
      if (!rows.some((r) => r.ok && r.cpuTime)) continue;
      const side = (s) => rows.filter((r) => r.side === s);
      const rounds = [...new Set(rows.map((r) => r.round))].sort((a, b) => a - b);
      const pairsOf = (get) => rounds.map((n) => ['base', 'branch'].map((s) => {
        const r = side(s).find((x) => x.round === n && x.ok);
        const v = r ? get(r) : null;
        return Number.isFinite(v) ? v : null;
      }));
      const medians = Object.fromEntries([['wall interactive', (r) => r.interactiveMs], ...CPU_COLUMNS].map(([label, get]) =>
        [label, ['base', 'branch'].map((s) => median(side(s).filter((r) => r.ok).map(get).filter(Number.isFinite)))]));
      // Second measures compare the rounds where both sides have the value (unavailable is not a failed load; review #10138).
      const complete = (ps) => ps.filter(([a, b]) => a !== null && b !== null);
      const pairs = complete(pairsOf(CPU_COLUMNS[0][1]));
      const underLoad = { base: side('base').filter((r) => r.host?.underLoad).length, branch: side('branch').filter((r) => r.host?.underLoad).length };
      const failures = { base: side('base').filter((r) => !r.ok).length, branch: side('branch').filter((r) => !r.ok).length };
      // The verdict figures' medians come from the same complete rounds the verdicts compare (review #10138).
      const pairMedians = (ps) => [median(ps.map((p) => p[0])), median(ps.map((p) => p[1]))];
      medians[CPU_COLUMNS[0][0]] = pairMedians(pairs);
      const okRows = rows.filter((r) => r.ok);
      const unavailable = (has, value, why) => { const u = okRows.filter((r) => has(r) && !Number.isFinite(value(r))); return u.length ? { n: u.length, reason: why(u[0]) } : null; };
      const cell = { fixture, lane, n: [side('base').length, side('branch').length], pairs: { cpu: pairs.length }, medians,
        cpuUnavailable: unavailable((r) => r.cpuTime, (r) => r.cpuTime?.cpuMs?.total, (r) => r.cpuTime?.coverage ?? r.cpuTime?.error ?? 'no CPU figure') };
      if (kind === 'aa') {
        cell.aaFloor = underLoad.base + underLoad.branch > 0 ? null : aaNoiseFloor(pairs, { seed: 0x5eed });
        cell.aaFloorFlagged = aaNoiseFloor(pairs, { seed: 0x5eed }); // floor with flagged samples kept, information only
      } else {
        cell.verdict = verdictWithFloor(pairs, { failures, underLoad, floors, fixture, lane, key: CPU_FLOOR_KEY, label: 'CPU' });
      }
      cells.push(cell);
    }
  }
  return { kind, cells };
}

/** verdictFor against the recorded A/A floor of `key`; with an A/A reference lacking that floor: inconclusive. */
function verdictWithFloor(pairs, { failures, underLoad, floors, fixture, lane, key, label }) {
  const aaFloor = floors?.[fixture]?.[lane]?.[key] ?? null;
  const v = verdictFor(pairs, { failures, underLoad, aaFloor, minAbs: 1, seed: 0x5eed });
  if (floors && !Number.isFinite(aaFloor) && !v.verdict.startsWith('inconclusive') && v.verdict !== 'regression: more failed loads') {
    return { ...v, verdict: `inconclusive: no ${label} A/A floor for this cell (own floor alone: ${v.verdict})`, pass: false, regression: false };
  }
  return v;
}

/**
 * The wall verdict's arm-protocol gate applies to CPU verdicts too: on a `-settled` lane whose sides
 * armed differently (not declared asymmetric) they are inconclusive, like the wall verdict (review #10138).
 */
export function applyArmProtocolGate(cpu, summary) {
  for (const c of cpu.cells) {
    const p = summary.fixtures?.find((f) => f.name === c.fixture)?.lanes?.[c.lane]?.armProtocol;
    if (!p || p.same || p.declaredAsymmetric) continue;
    const why = `inconclusive: arming protocols differ (base: ${p.base.signals.join('/')}, branch: ${p.branch.signals.join('/')}; declare plan.asymmetricBootSignal to compare them)`;
    if (c.verdict) Object.assign(c.verdict, { verdict: why, pass: false, regression: false });
    // An A/A cell has no verdict: withhold its floors, so a mismatched pair never enters a floors reference (review #10138).
    if (cpu.kind === 'aa') {
      c.aaFloor = null;
      c.aaFloorFlagged = null;
      c.gated = why;
    }
  }
  return cpu;
}

/** Add CPU A/A floors to a summary's floors (A/A runs), so merged floors files carry them. */
export function addCpuFloors(summary, cpu) {
  if (cpu.kind !== 'aa') return;
  for (const c of cpu.cells) {
    const cell = ((summary.floors[c.fixture] ??= {})[c.lane] ??= {});
    cell[CPU_FLOOR_KEY] = c.aaFloor;
  }
}

/** The report section's markdown lines (none without CPU time). */
export function cpuTimeSection(samples, summary) {
  const cpu = summary.cpuTime;
  if (!cpu?.cells?.length) return [];
  const aa = cpu.kind === 'aa';
  const lines = ['', `## CPU time, second measure (thread time from the Chrome trace, input event to interactive; ms, median base / branch). ${aa ? 'A/A floor of CPU total (no floor when a sample was under load; the value with those samples kept is in brackets).' : 'CPU verdict: gain >= 2x max(own floor, CPU A/A floor), as for wall time; the wall verdict above is the verdict.'}`, '',
    `| fixture | lane | n | wall interactive | ${CPU_COLUMNS.map(([l]) => `CPU ${l}`).join(' | ')} | ${aa ? 'CPU total A/A floor' : 'CPU total: gain / own / A/A floor | CPU verdict'} |`,
    `|---|---|---:|${'---:|'.repeat(CPU_COLUMNS.length + 1)}${aa ? '---:|' : '---|---|'}`];
  for (const c of cpu.cells) {
    const med = Object.values(c.medians).map(([b, r]) => `${n0(b)} / ${n0(r)}`).join(' | ');
    const mark = (v) => (!v ? '—' : v.pass ? 'PASS gain' : v.regression ? `FLAG ${v.verdict}` : v.verdict);
    const floors3 = (v) => (v ? `${pct(v.gain)} / ${pct(v.ownFloor)} / ${pct(v.aaFloor)}` : '—');
    const tail = aa ? `${pct(c.aaFloor)} (${pct(c.aaFloorFlagged)})` : `${floors3(c.verdict)} | ${mark(c.verdict)}`;
    const gaps = [c.cpuUnavailable && `CPU unavailable ${c.cpuUnavailable.n}: ${c.cpuUnavailable.reason}`].filter(Boolean);
    lines.push(`| ${c.fixture} | ${c.lane} | ${c.n.join('/')}; pairs CPU ${c.pairs.cpu}${gaps.length ? ` (${gaps.join('; ')})` : ''} | ${med} | ${tail} |`);
  }
  return lines;
}
