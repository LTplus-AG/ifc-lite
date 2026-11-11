/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scoreboard report: samples (one JSON row per lane sample) -> per fixture and
 * lane medians, spread, verdicts, noise floors, stage ranking and the
 * markdown tables. Failed samples stay in the counts.
 */

import { aaNoiseFloor, expectedCacheTier, median, rankShares, relativeSpread, verdictFor } from './load-scoreboard-stats.mjs';

export const LANES = ['native-cold', 'browser-cold', 'browser-cold-early', 'browser-warm1', 'browser-warm', 'boot'];
/** The `boot` lane opens no file; its rows carry this pseudo-fixture. */
export const BOOT_FIXTURE = '(app shell)';
export const METRICS = [
  // [key, label, smallest countable absolute difference]
  ['firstGeometryMs', 'first geometry ms', 1],
  ['interactiveMs', 'interactive ms', 1],
  ['peakMemoryMiB', 'peak memory MiB', 1],
  ['uiQuietMs', 'UI quiet ms', 1],
  // `boot` lane only (absent elsewhere, so no verdict there).
  ['shellReadyMs', 'app-shell ready ms', 1],
  ['bootLongTaskMs', 'boot long-task ms', 1],
  ['idleJsMiB', 'idle JS+wasm MiB', 1],
  ['idleVramMiB', 'idle GPU MiB', 1],
];
export const BROWSER_LANES = ['browser-cold', 'browser-cold-early', 'browser-warm1', 'browser-warm'];

const shareOf = (row) => row.stageShares ?? (row.stageMs && row.interactiveMs
  ? Object.fromEntries(Object.entries(row.stageMs).map(([k, v]) => [k, v / row.interactiveMs])) : null);

/** Browser readiness components (median ms) and which one ended the load most often. */
export const READINESS = [['firstGeometryMs', 'first geometry'], ['geometryMs', 'geometry finalized'], ['propsMs', 'metadata ready'], ['settlePaintMs', 'settled + frame'], ['publishPaintMs', 'publish + frame'], ['uiQuietMs', 'UI quiet']];
function readinessOf(ok) {
  if (!ok.some((r) => Number.isFinite(r.storeSettledMs))) return null;
  const medians = Object.fromEntries(READINESS.map(([k]) => [k, ok.length >= 3 ? median(ok.map((r) => r[k])) : null]));
  const counts = {};
  for (const r of ok) {
    // Binding = the last of the three components that define interactive.
    const last = ['propsMs', 'settlePaintMs'].reduce((a, k) => ((r[k] ?? r.storeSettledMs ?? -1) > (r[a] ?? -1) ? k : a), 'geometryMs');
    counts[last] = (counts[last] ?? 0) + 1;
  }
  const binding = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { medians, binding, bindingCounts: counts };
}

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
  const planFixtures = [...plan.fixtures, ...(plan.lanes.includes('boot') ? [{ name: BOOT_FIXTURE, set: 'boot' }] : [])];
  for (const fx of planFixtures) {
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
          // A reopen keeps its lane whatever path it took: count how many adopted a scene snapshot,
          // and (first reopen) how many found one stored before opening.
          snapshotAdoptedCount: ok.filter((r) => (r.snapshotAdopted ?? []).some(Boolean)).length,
          snapshotPresentBeforeOpenCount: ok.filter((r) => r.snapshotPresentBeforeOpen === true).length,
          settleQuantized: ok.filter((r) => r.settleQuantized).length,
          // H9: taken while the host was busy (pre-sample check), and H2: input event dispatched >100 ms late.
          underLoad: mine.filter((r) => r.host?.underLoad).length,
          inputDelayed: mine.filter((r) => (r.inputDelayMs ?? 0) > 100).length,
          stages: rankShares(ok.map(shareOf).filter(Boolean)),
          readiness: readinessOf(ok),
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
    fixtures.push({ name: fx.name, set: fx.set ?? 'tuning', bytes: fx.bytes, expectedTier: Number.isFinite(fx.bytes) ? expectedCacheTier(fx.bytes) : null, lanes });
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

/** Median [min-max] (n); fewer than three values are listed, never summarized as a median (H5). */
function cell(m) {
  const v = (m?.values ?? []).filter(Number.isFinite);
  if (v.length === 0) return '—';
  if (v.length < 3) return `n=${v.length}: ${v.map(n0).join(', ')}`;
  return `${n0(median(v))} [${n0(Math.min(...v))}-${n0(Math.max(...v))}] n=${v.length}`;
}

function tierCell(f, lane) {
  const l = f.lanes[lane];
  if (lane === 'native-cold') return 'n/a';
  const s = l?.sides.base;
  const adopted = s?.snapshotAdoptedCount ? `; snapshot ${s.snapshotAdoptedCount}/${s.ok}` : '';
  const stored = lane === 'browser-warm1' && s?.snapshotPresentBeforeOpenCount ? ` (stored before open ${s.snapshotPresentBeforeOpenCount}/${s.ok})` : '';
  const observed = s ? `${s.cacheTiers.join('/') || 'none'}; path ${s.loadPaths.join('/') || '?'}${adopted}${stored}` : '—';
  return observed;
}

/** Baseline table (one set). For an A/A run the base and branch sides are the same build, so values are pooled. */
function baselineTable(summary, set, lanes) {
  const lines = ['| fixture | MB | expected tier | lane | first geometry ms | interactive ms | UI quiet ms | peak memory MiB | ok/failed | flagged (load / input delay) | observed tier, path | output |',
    '|---|---:|---|---|---:|---:|---:|---:|---|---|---|---|'];
  for (const f of summary.fixtures.filter((x) => x.set === set)) {
    for (const lane of lanes) {
      const l = f.lanes[lane];
      if (!l) continue;
      const pooled = (key) => {
        const values = summary.kind === 'aa'
          ? [...l.sides.base.metrics[key].values, ...l.sides.branch.metrics[key].values] : l.sides.base.metrics[key].values;
        return { median: median(values), spread: relativeSpread(values), values };
      };
      const okFailed = `${l.sides.base.ok + (summary.kind === 'aa' ? l.sides.branch.ok : 0)}/${l.sides.base.failed + (summary.kind === 'aa' ? l.sides.branch.failed : 0)}`;
      const warmNote = lane.startsWith('browser-warm') && /^none/.test(f.expectedTier ?? '') ? ' (no cache tier: warm = uncached reopen)' : '';
      const flags = summary.kind === 'aa' ? [l.sides.base, l.sides.branch] : [l.sides.base];
      const flagged = `${flags.reduce((a, x) => a + x.underLoad, 0)} / ${flags.reduce((a, x) => a + x.inputDelayed, 0)}`;
      lines.push(`| ${f.name} | ${f.bytes ? (f.bytes / 2 ** 20).toFixed(1) : '—'} | ${f.expectedTier ?? '—'} | ${lane}${warmNote} | ${lane === 'native-cold' ? 'n/a (batch)' : cell(pooled('firstGeometryMs'))} | ${cell(pooled('interactiveMs'))} | ${lane === 'native-cold' ? 'n/a' : cell(pooled('uiQuietMs'))} | ${cell(pooled('peakMemoryMiB'))} | ${okFailed} | ${flagged} | ${tierCell(f, lane)} | ${l.output === 'match' ? (l.sides.base.fingerprints[0] ?? '').slice(0, 60) : l.output} |`);
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
        const med = (side) => (v.samples[side] >= 3 ? n0(side === 'base' ? v.baseMedian : v.branchMedian) : `n=${v.samples[side]} (no median)`);
        lines.push(`| ${f.name} | ${lane} | ${label} | ${med('base')} | ${med('branch')} | ${signed(v.gain)} | ${pct(v.ownFloor)} | ${pct(v.aaFloor)} | ${pct(v.noiseFloor === null ? null : v.noiseFloor * 2)} | ${mark} | ${l.output} |`);
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
  for (const seg of host?.segments ?? []) {
    out.push(`- Segment (${seg.fixtures}): host ${seg.start?.hostname}; ${seg.workerKind ?? 'no'} admission, job ${seg.workerJobId ?? 'none'}; power ${seg.start?.powerProfile ?? '?'} -> ${seg.end?.powerProfile ?? '?'}; max freq ${seg.start?.scalingMaxFreqKHz ?? '?'} -> ${seg.end?.scalingMaxFreqKHz ?? '?'} kHz; ${seg.start?.at} .. ${seg.end?.at ?? 'unfinished'}`);
  }
  out.push(`Sides: base = ${plan.sides.base.label}; branch = ${plan.sides.branch.label}. Rounds ${plan.rounds}, warm opens ${plan.warmOpens ?? 0}, order seed ${plan.seed}.`, '');
  out.push('Interactive = geometry streamed, drained and finalized, metadata ready, and the first frame after the store settled (README cold-load notes). UI quiet = end of the last main-thread long task before 500 ms without one. Native has no first-geometry event (batch call); native interactive = file read + full `process_geometry`. Times are ms from the file input change event. Cells: median [min-max] n; fewer than 3 values are listed, never summarized.', '');
  for (const set of ['tuning', 'holdout', 'boot']) {
    if (!summary.fixtures.some((f) => f.set === set)) continue;
    out.push(`## Baseline (${set})`, '', baselineTable(summary, set, plan.lanes), '');
  }
  for (const set of ['tuning', 'holdout', 'boot']) {
    if (!summary.fixtures.some((f) => f.set === set)) continue;
    out.push(`## Verdicts (${set}): gain >= 2x noise floor`, '', verdictTable(summary, set, plan.lanes), '');
  }
  const diffRows = summary.fixtures.flatMap((f) => BROWSER_LANES.filter((lane) => f.lanes[lane]?.elementDiff).map((lane) => {
    const d = f.lanes[lane].elementDiff, worst = d.diffs.find((x) => !x.identical);
    if (d.diffs.some((x) => x.unverifiable)) return `| ${f.name} | ${lane} | ${d.diffs.length + 1} | UNVERIFIABLE (no element hashes on a sample) |`;
    return `| ${f.name} | ${lane} | ${d.diffs.length + 1} | ${d.identical ? 'IDENTICAL' : `DIFFERS (${worst.side} r${worst.round}: ${worst.onlyBase} missing, ${worst.onlyBranch} extra, ${worst.changed} changed of ${worst.compared}; e.g. ${[...worst.examples.changed, ...worst.examples.onlyBase, ...worst.examples.onlyBranch].slice(0, 5).join(', ')})`} |`;
  }));
  if (diffRows.length) {
    out.push('## Per-element output (element geometry hashes, flat + instanced; every sample vs the first base sample)', '',
      '| fixture | lane | samples | result |', '|---|---|---:|---|', ...diffRows, '');
  }
  out.push('## Lane summary (interactive time)', '');
  for (const [lane, s] of Object.entries(summary.laneSummary)) {
    out.push(`- **${lane}**: gains [${s.gains.join(', ')}]; regressions [${s.regressions.join(', ')}]; no significant difference [${s.noDifference.join(', ')}]; inconclusive [${s.inconclusive.join(', ')}]; output not matching [${s.outputChanged.join(', ')}]`);
  }
  const readinessRows = summary.fixtures.flatMap((f) => BROWSER_LANES.filter((lane) => f.lanes[lane]?.sides.base.readiness)
    .map((lane) => { const r = f.lanes[lane].sides.base.readiness; const label = Object.fromEntries(READINESS);
      return `| ${f.name} | ${f.set} | ${lane} | ${READINESS.map(([k]) => n0(r.medians[k])).join(' | ')} | ${label[r.binding] ?? '—'} (${Object.entries(r.bindingCounts).map(([k, c]) => `${label[k]} ${c}`).join(', ')}) |`; }));
  if (readinessRows.length) {
    out.push('', '## Readiness components (base side medians, n>=3, ms from the input change event; interactive = the last of geometry finalized, metadata ready, settled + frame)', '',
      `| fixture | set | lane | ${READINESS.map(([, l]) => l).join(' | ')} | binding (count) |`, `|---|---|---|${READINESS.map(() => '---:|').join('')}---|`, ...readinessRows);
  }
  out.push('', '## Stage shares, ranked (tuning set, base side; concurrent stages overlap, so shares need not sum to 100%)', '');
  for (const lane of plan.lanes) {
    const ranked = laneStageRanking(summary, lane).filter((s) => s.share >= 0.005).slice(0, 15);
    if (ranked.length) out.push(`- **${lane}**: ${ranked.map((s) => `${s.stage} ${pct(s.share)}`).join(', ')}`);
  }
  return out.join('\n') + '\n';
}
