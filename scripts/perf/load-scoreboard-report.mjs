/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scoreboard report: samples (one JSON row per lane sample) -> per fixture and
 * lane medians, spread, verdicts, noise floors, stage ranking and the
 * markdown tables. Failed samples stay in the counts.
 */

import { aaNoiseFloor, expectedCacheTier, median, rankShares, relativeSpread, verdictFor } from './load-scoreboard-stats.mjs';

export const LANES = ['native-cold', 'browser-cold', 'browser-warm'];
export const METRICS = [
  // [key, label, smallest countable absolute difference]
  ['firstGeometryMs', 'first geometry ms', 1],
  ['interactiveMs', 'interactive ms', 1],
  ['peakMemoryMiB', 'peak memory MiB', 1],
];

const shareOf = (row) => row.stageShares ?? (row.stageMs && row.interactiveMs
  ? Object.fromEntries(Object.entries(row.stageMs).map(([k, v]) => [k, v / row.interactiveMs])) : null);

function pairsFor(rows, metric) {
  const rounds = [...new Set(rows.map((r) => r.round))].sort((a, b) => a - b);
  return rounds.map((round) => ['base', 'branch'].map((side) => {
    const r = rows.find((x) => x.round === round && x.side === side);
    return r?.ok && Number.isFinite(r[metric]) ? r[metric] : null;
  }));
}

/** Summarize all samples. `floors`: an A/A report's `floors` (omit for an A/A run). */
export function summarize(plan, samples, { floors = null } = {}) {
  const fixtures = [];
  for (const fx of plan.fixtures) {
    const lanes = {};
    for (const lane of plan.lanes) {
      const rows = samples.filter((s) => s.fixture === fx.name && s.lane === lane);
      if (rows.length === 0) continue;
      const sides = {};
      for (const side of ['base', 'branch']) {
        const mine = rows.filter((r) => r.side === side);
        const ok = mine.filter((r) => r.ok);
        sides[side] = {
          samples: mine.length, ok: ok.length, failed: mine.length - ok.length,
          errors: mine.filter((r) => !r.ok).map((r) => `r${r.round}: ${r.error ?? 'unknown'}`),
          fingerprints: [...new Set(ok.map((r) => r.fingerprint))],
          adapters: [...new Set(ok.map((r) => r.adapter).filter(Boolean))],
          loadPaths: [...new Set(ok.flatMap((r) => r.loadPaths ?? []))],
          cacheTiers: [...new Set(ok.flatMap((r) => r.cacheTiers ?? []).filter(Boolean))],
          snapshotAdopted: ok.some((r) => (r.snapshotAdopted ?? []).some(Boolean)),
          settleQuantized: ok.filter((r) => r.settleQuantized).length,
          stages: rankShares(ok.map(shareOf).filter(Boolean)),
          metrics: Object.fromEntries(METRICS.map(([key]) => {
            const values = ok.map((r) => r[key]).filter(Number.isFinite);
            return [key, { median: median(values), spread: relativeSpread(values), n: values.length, values }];
          })),
        };
      }
      const failures = { base: sides.base.failed, branch: sides.branch.failed };
      const verdicts = {}, laneFloors = {};
      for (const [key, , minAbs] of METRICS) {
        const pairs = pairsFor(rows, key);
        if (pairs.every(([a, b]) => a === null && b === null)) continue;
        verdicts[key] = verdictFor(pairs, { failures, aaFloor: floors?.[fx.name]?.[lane]?.[key] ?? null, minAbs, seed: 0x5eed });
        laneFloors[key] = aaNoiseFloor(pairs, { seed: 0x5eed });
      }
      const fpBase = sides.base.fingerprints, fpBranch = sides.branch.fingerprints;
      const output = fpBase.length === 0 || fpBranch.length === 0 ? 'unknown (no successful sample on a side)'
        : fpBase.length > 1 || fpBranch.length > 1 ? 'VARIED within a side'
          : fpBase[0] === fpBranch[0] ? 'match' : 'CHANGED';
      lanes[lane] = { sides, verdicts, floors: laneFloors, output, primary: verdicts.interactiveMs ?? null };
    }
    fixtures.push({ name: fx.name, set: fx.set ?? 'tuning', bytes: fx.bytes, expectedTier: fx.bytes ? expectedCacheTier(fx.bytes) : null, lanes });
  }
  const floorsOut = {};
  for (const f of fixtures) for (const [lane, l] of Object.entries(f.lanes)) (floorsOut[f.name] ??= {})[lane] = l.floors;
  return { name: plan.name, kind: plan.kind ?? 'compare', fixtures, floors: floorsOut, laneSummary: laneSummary(fixtures, plan.lanes) };
}

function laneSummary(fixtures, lanes) {
  const out = {};
  for (const lane of lanes) {
    const rows = fixtures.filter((f) => f.lanes[lane]?.primary).map((f) => ({ fixture: f.name, set: f.set, ...f.lanes[lane].primary, output: f.lanes[lane].output }));
    const by = (pred) => rows.filter(pred).map((r) => r.fixture);
    out[lane] = {
      gains: by((r) => r.pass), regressions: by((r) => r.regression), noDifference: by((r) => r.verdict === 'no significant difference'),
      inconclusive: by((r) => r.verdict.startsWith('inconclusive')), outputChanged: by((r) => r.output !== 'match'),
    };
  }
  return out;
}

const n0 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : Math.round(v).toLocaleString('en-US'));
const pct = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(d)}%`);
const signed = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);

function cell(m) {
  if (!m || m.median === null) return '—';
  return `${n0(m.median)} ±${pct(m.spread ?? 0, 0)}`;
}

function tierCell(f, lane) {
  const l = f.lanes[lane];
  if (lane === 'native-cold') return 'n/a';
  const s = l?.sides.base;
  const observed = s ? `${s.cacheTiers.join('/') || 'none'}; path ${s.loadPaths.join('/') || '?'}${s.snapshotAdopted ? '; snapshot' : ''}` : '—';
  return observed;
}

/** Baseline table (one set). For an A/A run the base and branch sides are the same build, so values are pooled. */
function baselineTable(summary, set, lanes) {
  const lines = ['| fixture | MB | expected tier | lane | first geometry ms | interactive ms | peak memory MiB | ok/failed | observed tier, path | output |',
    '|---|---:|---|---|---:|---:|---:|---|---|---|'];
  for (const f of summary.fixtures.filter((x) => x.set === set)) {
    for (const lane of lanes) {
      const l = f.lanes[lane];
      if (!l) continue;
      const pooled = (key) => {
        const values = summary.kind === 'aa'
          ? [...l.sides.base.metrics[key].values, ...l.sides.branch.metrics[key].values] : l.sides.base.metrics[key].values;
        return { median: median(values), spread: relativeSpread(values) };
      };
      const okFailed = `${l.sides.base.ok + (summary.kind === 'aa' ? l.sides.branch.ok : 0)}/${l.sides.base.failed + (summary.kind === 'aa' ? l.sides.branch.failed : 0)}`;
      const warmNote = lane === 'browser-warm' && /^none/.test(f.expectedTier ?? '') ? ' (no cache tier: warm = uncached reopen)' : '';
      lines.push(`| ${f.name} | ${f.bytes ? (f.bytes / 2 ** 20).toFixed(1) : '—'} | ${f.expectedTier ?? '—'} | ${lane}${warmNote} | ${lane === 'native-cold' ? 'n/a (batch)' : cell(pooled('firstGeometryMs'))} | ${cell(pooled('interactiveMs'))} | ${cell(pooled('peakMemoryMiB'))} | ${okFailed} | ${tierCell(f, lane)} | ${l.output === 'match' ? (l.sides.base.fingerprints[0] ?? '').slice(0, 60) : l.output} |`);
    }
  }
  return lines.join('\n');
}

function verdictTable(summary, set, lanes) {
  const lines = ['| fixture | lane | metric | base median | branch median | gain | own floor | A/A floor | 2x floor | verdict | output |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---|---|'];
  for (const f of summary.fixtures.filter((x) => x.set === set)) {
    for (const lane of lanes) {
      const l = f.lanes[lane];
      if (!l) continue;
      for (const [key, label] of METRICS) {
        const v = l.verdicts[key];
        if (!v) continue;
        const mark = v.pass ? 'PASS gain' : v.regression ? `FLAG ${v.verdict}` : v.verdict;
        lines.push(`| ${f.name} | ${lane} | ${label} | ${n0(v.baseMedian)} | ${n0(v.branchMedian)} | ${signed(v.gain)} | ${pct(v.ownFloor)} | ${pct(v.aaFloor)} | ${pct(v.noiseFloor === null ? null : v.noiseFloor * 2)} | ${mark} | ${l.output} |`);
      }
    }
  }
  return lines.join('\n');
}

/** Stage shares ranked largest first per lane: the median over fixtures of each fixture's median share (base side). */
export function laneStageRanking(summary, lane, set = 'tuning') {
  const perFixture = summary.fixtures.filter((f) => f.set === set && f.lanes[lane]).map((f) => Object.fromEntries(f.lanes[lane].sides.base.stages.map((s) => [s.stage, s.share])));
  return rankShares(perFixture);
}

export function renderMarkdown(summary, plan, host) {
  const out = [`# Load scoreboard: ${summary.name}`, ''];
  out.push(`Kind: ${summary.kind}. Timed evidence: ${host?.timedEvidence ? 'yes (exclusive benchmark admission)' : 'NO (not exclusive; dry run)'}.`);
  if (host) out.push(`Host ${host.hostname}; power profile ${host.powerProfile?.start ?? '?'} -> ${host.powerProfile?.end ?? '?'}; max freq ${host.scalingMaxFreqKHz?.start ?? '?'} kHz; job ${host.workerJobId ?? 'none'}.`);
  out.push(`Sides: base = ${plan.sides.base.label}; branch = ${plan.sides.branch.label}. Rounds ${plan.rounds}, warm opens ${plan.warmOpens ?? 0}, order seed ${plan.seed}.`, '');
  out.push('Interactive = geometry streamed, drained and finalized, metadata ready and the store settled (README cold-load notes). Native has no first-geometry event (batch call); native interactive = file read + full `process_geometry`. Cells: median ±(max-min)/median.', '');
  for (const set of ['tuning', 'holdout']) {
    if (!summary.fixtures.some((f) => f.set === set)) continue;
    out.push(`## Baseline (${set})`, '', baselineTable(summary, set, plan.lanes), '');
  }
  for (const set of ['tuning', 'holdout']) {
    if (!summary.fixtures.some((f) => f.set === set)) continue;
    out.push(`## Verdicts (${set}): gain >= 2x noise floor`, '', verdictTable(summary, set, plan.lanes), '');
  }
  out.push('## Lane summary (interactive time)', '');
  for (const [lane, s] of Object.entries(summary.laneSummary)) {
    out.push(`- **${lane}**: gains [${s.gains.join(', ')}]; regressions [${s.regressions.join(', ')}]; no significant difference [${s.noDifference.join(', ')}]; inconclusive [${s.inconclusive.join(', ')}]; output not matching [${s.outputChanged.join(', ')}]`);
  }
  out.push('', '## Stage shares, ranked (tuning set, base side; concurrent stages overlap, so shares need not sum to 100%)', '');
  for (const lane of plan.lanes) {
    const ranked = laneStageRanking(summary, lane).filter((s) => s.share >= 0.005).slice(0, 15);
    if (ranked.length) out.push(`- **${lane}**: ${ranked.map((s) => `${s.stage} ${pct(s.share)}`).join(', ')}`);
  }
  return out.join('\n') + '\n';
}
