/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Arithmetic behind `load-scoreboard.mjs`: medians, spread, the noise floor,
 * per-stage shares and the base-vs-branch verdict. Pure, so the decision rule
 * the hill-climb accepts or rejects optimisations by is unit-tested.
 *
 * Signs: `gain` is the fraction of the base median the branch saves
 * (`1 - branch/base`): +0.10 is 10% faster (or 10% less memory), negative is
 * a regression.
 *
 * Noise floor of one comparison = max(the A/A floor recorded for that
 * fixture/lane/metric, this run's own floor). A run's own floor is the
 * larger of the half-width of the 90% paired-bootstrap interval of its gain
 * (rounds resampled with replacement, each round's base and branch kept
 * together because they ran next to each other) and half the larger side's
 * relative range. An A/A run's floor additionally includes its own |gain|,
 * the systematic difference between two identical builds. A verdict needs
 * |gain| >= 2 x floor and at least 5 successful samples per side.
 */

import { seededRand } from './ab-order.mjs';

export const VERDICT_MULTIPLIER = 2;

export function median(xs) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (s.length === 0) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** (max - min) / median of the finite values; null below two values or at a zero median. */
export function relativeSpread(xs) {
  const v = xs.filter((x) => Number.isFinite(x));
  const med = median(v);
  if (v.length < 2 || !med) return null;
  return (Math.max(...v) - Math.min(...v)) / med;
}

/** 1 - median(branch) / median(base); null when either side has no value or the base median is zero. */
export function gainOf(base, branch) {
  const b = median(base), r = median(branch);
  if (b === null || r === null || b === 0) return null;
  return 1 - r / b;
}

/**
 * Half-width of the `level` paired-bootstrap interval of the gain. `pairs` is
 * one [base, branch] per round; rounds with a missing side are dropped.
 */
export function bootstrapHalfWidth(pairs, { resamples = 2000, level = 0.9, seed = 1 } = {}) {
  const ok = pairs.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  if (ok.length < 2) return null;
  const rand = seededRand(seed);
  const gains = [];
  for (let i = 0; i < resamples; i++) {
    const base = [], branch = [];
    for (let j = 0; j < ok.length; j++) {
      const [a, b] = ok[Math.floor(rand() * ok.length)];
      base.push(a); branch.push(b);
    }
    const g = gainOf(base, branch);
    if (g !== null) gains.push(g);
  }
  if (gains.length === 0) return null;
  gains.sort((a, b) => a - b);
  const lo = gains[Math.floor(((1 - level) / 2) * (gains.length - 1))];
  const hi = gains[Math.ceil((1 - (1 - level) / 2) * (gains.length - 1))];
  return (hi - lo) / 2;
}

/**
 * A run's own floor: the paired-bootstrap half-width, but never less than half
 * the larger side's relative range. With 3-5 rounds whose pairs happen to lean
 * one way, the bootstrap alone collapses far below the samples' own scatter
 * (an A/A FZK native cohort: 3% half-width against a 14% base range).
 */
export function ownNoiseFloor(pairs, options) {
  const hw = bootstrapHalfWidth(pairs, options);
  if (hw === null) return null;
  const spread = (i) => relativeSpread(pairs.map((p) => p[i]).filter(Number.isFinite)) ?? 0;
  return Math.max(hw, Math.max(spread(0), spread(1)) / 2);
}

/** The floor an A/A run contributes: the larger of its own |gain| and its bootstrap half-width. */
export function aaNoiseFloor(pairs, options) {
  const g = gainOf(pairs.map((p) => p[0]), pairs.map((p) => p[1]));
  const hw = ownNoiseFloor(pairs, options);
  if (g === null && hw === null) return null;
  return Math.max(Math.abs(g ?? 0), hw ?? 0);
}

/**
 * Verdict for one metric. `pairs`: [base, branch] per round (null for a failed
 * sample). `failures`: { base, branch } counts. `aaFloor`: the recorded A/A
 * floor (omit for an A/A run itself). `minAbs`: smallest absolute median
 * difference, in the metric's unit, that can count at all (timer resolution).
 */
export function verdictFor(pairs, { failures = { base: 0, branch: 0 }, aaFloor = null, minAbs = 1, minSamples = 5, seed = 1 } = {}) {
  const base = pairs.map((p) => p[0]).filter(Number.isFinite);
  const branch = pairs.map((p) => p[1]).filter(Number.isFinite);
  const out = {
    baseMedian: median(base), branchMedian: median(branch),
    baseSpread: relativeSpread(base), branchSpread: relativeSpread(branch),
    samples: { base: base.length, branch: branch.length }, failures,
    gain: gainOf(base, branch), ownFloor: ownNoiseFloor(pairs, { seed }), aaFloor,
    noiseFloor: null, ratio: null, verdict: 'inconclusive', pass: false, regression: false,
  };
  if (failures.branch > failures.base) {
    return { ...out, verdict: 'regression: more failed loads', regression: true };
  }
  if (base.length < minSamples || branch.length < minSamples || out.gain === null || out.ownFloor === null) {
    return { ...out, verdict: 'inconclusive: too few successful samples' };
  }
  out.noiseFloor = Math.max(out.ownFloor, aaFloor ?? 0);
  out.ratio = out.noiseFloor > 0 ? Math.abs(out.gain) / out.noiseFloor : Infinity;
  const clears = Math.abs(out.gain) >= VERDICT_MULTIPLIER * out.noiseFloor && Math.abs(out.branchMedian - out.baseMedian) >= minAbs;
  if (!clears) return { ...out, verdict: 'no significant difference' };
  if (out.gain > 0) return { ...out, verdict: 'gain', pass: true };
  return { ...out, verdict: 'regression', regression: true };
}

/** Total length covered by [start, duration] intervals, overlaps counted once. */
export function unionLength(intervals) {
  const sorted = intervals.filter(([s, d]) => Number.isFinite(s) && Number.isFinite(d) && d > 0)
    .map(([s, d]) => [s, s + d]).sort((a, b) => a[0] - b[0]);
  let total = 0, curStart = null, curEnd = null;
  for (const [s, e] of sorted) {
    if (curEnd === null || s > curEnd) {
      if (curEnd !== null) total += curEnd - curStart;
      curStart = s; curEnd = e;
    } else if (e > curEnd) curEnd = e;
  }
  if (curEnd !== null) total += curEnd - curStart;
  return total;
}

/**
 * Wall-clock share of `totalMs` per stage. `stages` is { name: [[start, dur], ...] };
 * each stage's intervals are unioned (concurrent workers count once), clipped
 * to [0, totalMs]. Stages run concurrently, so shares need not sum to 1.
 */
export function stageShares(stages, totalMs) {
  if (!Number.isFinite(totalMs) || totalMs <= 0) return {};
  const out = {};
  for (const [name, intervals] of Object.entries(stages)) {
    const clipped = intervals.map(([s, d]) => {
      const start = Math.max(0, s), end = Math.min(totalMs, s + d);
      return [start, end - start];
    });
    out[name] = unionLength(clipped) / totalMs;
  }
  return out;
}

/**
 * Browser trace spans -> stages by name and by group (the name up to its first
 * dot). Milestones are excluded. A name with child spans is an umbrella and is
 * keyed with a trailing `*`, so it is not mistaken for leaf work.
 */
export function browserStages(trace) {
  const byName = {}, byGroup = {};
  for (const load of trace ?? []) {
    const parents = new Set((load.spans ?? []).map((sp) => sp[6]).filter((id) => id !== null && id !== undefined));
    const umbrella = new Set((load.spans ?? []).filter((sp) => parents.has(sp[5])).map((sp) => sp[0]));
    for (const [name, , start, dur, milestone] of load.spans ?? []) {
      if (milestone) continue;
      (byName[umbrella.has(name) ? `${name}*` : name] ??= []).push([start, dur]);
      (byGroup[name.split('.')[0]] ??= []).push([start, dur]);
    }
  }
  return { byName, byGroup };
}

/**
 * Stage shares of one browser open: per span name, plus `(no span)`, the part
 * of [0, interactive] no non-milestone span covers (untraced work or idle
 * waiting). Milestone times are returned beside them.
 */
export function browserShares(trace, interactiveMs) {
  const { byName } = browserStages(trace);
  const shares = stageShares(byName, interactiveMs);
  const covered = stageShares({ all: Object.values(byName).flat() }, interactiveMs).all ?? 0;
  shares['(no span)'] = Math.max(0, 1 - covered);
  const milestones = {};
  for (const load of trace ?? []) {
    for (const [name, , start, dur, milestone] of load.spans ?? []) if (milestone) milestones[name] = Math.max(milestones[name] ?? 0, start + dur);
  }
  return { shares, milestones };
}

/** perf_probe --cold JSON row -> sequential stages (ms). Each pipeline phase is reported once, residuals named. */
export function nativeStages(row) {
  const parseSub = (row.entityScanMs ?? 0) + (row.lookupMs ?? 0) + (row.preprocessMs ?? 0);
  const pipelineOther = Math.max(0, (row.totalMs ?? 0) - (row.parseMs ?? 0) - (row.geometryMs ?? 0));
  const loadMs = (row.allWallMs?.[0] ?? row.totalMs ?? 0);
  return {
    'file.read': row.fileReadMs ?? 0,
    'parse.entityScan': row.entityScanMs ?? 0,
    'parse.lookupStyles': row.lookupMs ?? 0,
    'parse.preprocess': row.preprocessMs ?? 0,
    'parse.other': Math.max(0, (row.parseMs ?? 0) - parseSub),
    geometry: row.geometryMs ?? 0,
    'pipeline.other': pipelineOther,
    'metadata.tail': Math.max(0, loadMs - (row.totalMs ?? 0)),
  };
}

/** Median share per stage over samples, ranked largest first. `shares`: one { stage: fraction } per sample. */
export function rankShares(shares) {
  const names = new Set(shares.flatMap((s) => Object.keys(s)));
  return [...names].map((name) => ({ stage: name, share: median(shares.map((s) => s[name] ?? 0)) }))
    .sort((a, b) => b.share - a.share);
}

/** Per-element output diff of two { expressId: hash } maps: ids on one side only, and ids whose hash differs. */
export function diffElements(base, branch, limit = 10) {
  const onlyBase = [], onlyBranch = [], changed = [];
  for (const [id, hash] of Object.entries(base)) {
    if (!(id in branch)) onlyBase.push(Number(id));
    else if (branch[id] !== hash) changed.push(Number(id));
  }
  for (const id of Object.keys(branch)) if (!(id in base)) onlyBranch.push(Number(id));
  const head = (xs) => xs.sort((a, b) => a - b).slice(0, limit);
  // No hashes on either side proves nothing: never report that as identical.
  const empty = Object.keys(base).length === 0 || Object.keys(branch).length === 0;
  return { identical: !empty && onlyBase.length + onlyBranch.length + changed.length === 0, unverifiable: empty, compared: Object.keys(base).length,
    onlyBase: onlyBase.length, onlyBranch: onlyBranch.length, changed: changed.length,
    examples: { onlyBase: head(onlyBase), onlyBranch: head(onlyBranch), changed: head(changed) } };
}

/**
 * Which open a browser-sample failure belongs to: 0 = the cold open (launch, boot, its
 * shell wait or the open itself), i = warm open i, including the steps that prepare it
 * (`warm<i>-prep`: cache-write or snapshot wait, page replacement). That open and every
 * later one fail; earlier clean opens keep their result.
 */
export function failedOpenIndex(phase) {
  if (['launch', 'boot', 'cold', 'cold-shell'].includes(phase)) return 0;
  const warm = /^warm(\d+)/.exec(phase ?? '');
  return warm ? Number(warm[1]) : 1;
}

/** Why a sample's GPU health fails it, or null. A health read that itself failed is not a clean bill (unknown is not healthy). */
export function gpuUnhealthy(health) {
  if (!health || typeof health.contaminated !== 'boolean') return `GPU health unreadable (${health?.error ?? 'no result'})`;
  return health.contaminated ? `GPU device lost during sample (${health.reasons.join('; ')})` : null;
}

/** Viewer cache tier a source of `bytes` qualifies for (apps/viewer/src/utils/ifcConfig.ts, hooks/cacheTier.ts). */
export function expectedCacheTier(bytes) {
  const MB = 1024 * 1024;
  if (bytes < 10 * MB) return 'none (<10 MB, uncached)';
  if (bytes <= 150 * MB) return 'source (10-150 MB)';
  if (bytes <= 400 * MB) return 'mesh-only (150-400 MB)';
  return 'none (>400 MB, uncached)';
}
