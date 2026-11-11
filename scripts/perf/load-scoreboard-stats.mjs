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
 * fixture/lane/metric, this run's own floor). A run's own floor is one robust
 * standard deviation (IQR / 1.349) of what it can see: the larger side's
 * relative scatter, or the scatter of the paired per-round differences
 * (`ownNoiseFloor`). An A/A run's floor additionally includes its own |gain|,
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

/** Linear-interpolation quantile (type 7) of finite values; null when empty. */
export function quantile(xs, q) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (s.length === 0) return null;
  const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** One robust standard deviation of `xs`: interquartile range / 1.349. */
export function robustSd(xs) {
  const v = xs.filter((x) => Number.isFinite(x));
  if (v.length < 2) return null;
  return (quantile(v, 0.75) - quantile(v, 0.25)) / 1.349;
}

/** Robust relative scatter: IQR / 1.349 / median, null below two values or at a zero median. */
export function robustSpread(xs) {
  const v = xs.filter((x) => Number.isFinite(x));
  const med = median(v), sd = robustSd(v);
  if (sd === null || !med) return null;
  return sd / med;
}

/**
 * A run's own floor: one robust standard deviation (IQR / 1.349) of the noise
 * it can see, the largest of
 * - each side's relative scatter around its median, and
 * - the scatter of the paired per-round differences (branch/base - 1), which
 *   carries what interleaving pairs share (drift, position in the round).
 * Interquartile, measured on the timed A/A (`stage0-REPORT.md`):
 * - not the range or a 5-round paired bootstrap: one outlier (advanced_model
 *   warm, 1,938 ms against 1,080-1,188) made them 37% and 21%, which hid a
 *   consistent +37% regression in the same cell;
 * - not the MAD: bimodal metrics (FZK first geometry in two clusters ~100 ms
 *   apart; peak memory at ~868 or ~895 MiB) gave a MAD far below the jump
 *   between modes, so two identical builds read as different.
 * With five values the quartiles are the 2nd and 4th order statistics: a lone
 * outlier falls outside them, a split between modes falls inside them. The
 * bootstrap half-width stays in the verdict as information only.
 */
export function ownNoiseFloor(pairs) {
  const ok = pairs.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && a > 0);
  if (ok.length < 2) return null;
  const sideSpread = (i) => robustSpread(pairs.map((p) => p[i]).filter(Number.isFinite)) ?? 0;
  const pairedSpread = robustSd(ok.map(([a, b]) => b / a - 1)) ?? 0;
  return Math.max(sideSpread(0), sideSpread(1), pairedSpread);
}

/** The floor an A/A run contributes: the larger of its own |gain| and its own floor (`ownNoiseFloor`). */
export function aaNoiseFloor(pairs, options) {
  const g = gainOf(pairs.map((p) => p[0]), pairs.map((p) => p[1]));
  const hw = ownNoiseFloor(pairs);
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
    gain: gainOf(base, branch), ownFloor: ownNoiseFloor(pairs), bootstrapHalfWidth: bootstrapHalfWidth(pairs, { seed }), aaFloor,
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
  // No trace is no attribution: not "100% untraced".
  if (!Array.isArray(trace) || trace.length === 0 || !Number.isFinite(interactiveMs) || interactiveMs <= 0) return { shares: null, milestones: {} };
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
 * Output identity of one browser open from its readOutputFingerprint() models. Comparable only when
 * complete: every model had the Rust hash pass (flat + instanced-only hashes), every element is covered
 * (flat meshes the pass left unhashed by their exact bytes) and no element has two hashes. Anything less
 * is UNVERIFIABLE. A reopen from the cache has no element hashes and its instanced output is not readable,
 * so its identity is UNVERIFIABLE too: only its flat output is checked against the cold load, and a
 * different flat output is a RESTORE MISMATCH. A copied cold identity is never reported for a reopen.
 */
export function openIdentity({ label, fingerprint, coldFingerprint }) {
  const models = Array.isArray(fingerprint) ? fingerprint : [];
  const none = (why) => ({ identity: `UNVERIFIABLE (${why})`, elements: [], identitySource: 'none' });
  if (models.length === 0) return none('no model in the store');
  const complete = (m) => m.hashed > 0 && m.unhashed === 0 && m.conflicts === 0;
  if (models.every(complete)) return { identity: models.map((m) => m.identity).join(' | '), elements: models.map((m) => m.elements), identitySource: 'element hashes' };
  if (models.some((m) => m.hashed > 0 || label === 'cold')) {
    const why = models.some((m) => m.conflicts > 0) ? 'an element has two different hashes'
      : models.some((m) => !(m.unhashed === 0)) ? 'element hashes do not cover every element'
        : 'no element geometry hashes';
    return none(why);
  }
  const cold = Array.isArray(coldFingerprint) ? coldFingerprint : [];
  if (cold.length === 0) return none('cache hit without a cold load to compare its flat output with');
  const sameFlat = cold.length === models.length
    && models.every((m, i) => m.flat?.signature === cold[i].flat?.signature && m.flat?.meshes === cold[i].flat?.meshes);
  return sameFlat ? none('cache hit: no element hashes, instanced output not readable; flat output restored exactly')
    : { identity: `RESTORE MISMATCH vs cold: flat ${models.map((m) => `${m.flat?.meshes}/${m.flat?.signature}`).join(',')}`, elements: [], identitySource: 'none' };
}

/**
 * Which open a browser-sample failure belongs to: 0 = the cold open (launch, boot, its
 * shell wait or the open itself), i = warm open i, including the steps that prepare it
 * (`warm<i>-prep`: cache-write or snapshot wait, page replacement). That open and every
 * later one fail; earlier clean opens keep their result.
 */
export function failedOpenIndex(phase) {
  const warm = /^warm(\d+)/.exec(phase ?? '');
  // Anything not attributable to a reopen (launch, boot, cold, or an unknown phase) taints every open.
  return warm ? Number(warm[1]) : 0;
}

/**
 * Why reopen `open` cannot be measured as the cache hit it is labelled, or null.
 * A cache write that never settled leaves every reopen measuring something else;
 * an expected scene snapshot that was never written leaves reopen 2 onwards
 * measuring the streamed hit instead of the snapshot adoption.
 */
export function warmPrepFailure({ open, cacheWriteSettled, snapshotExpected, snapshotWritten }) {
  // Only a confirmed state prepares a reopen: unknown is a failure, never a pass.
  if (cacheWriteSettled !== true) return cacheWriteSettled === false
    ? 'cache write did not settle within 10 min, so the reopen would not measure a cache hit'
    : 'cache write was not checked before the reopen';
  if (open > 1 && snapshotExpected !== false && snapshotWritten !== true) return snapshotExpected === undefined || snapshotExpected === null
    ? 'whether a scene snapshot is expected was not decided before the reopen'
    : 'expected scene snapshot was not written within 60 s, so the reopen would not measure snapshot adoption';
  return null;
}

/** The quiet wait's cap after readiness (viewer-load-boot.mjs `waitUiQuiet` timeoutMs). */
export const UI_QUIET_CAP_MS = 20000;

/**
 * A row's UI-quiet time, or null when the wait hit its cap: the main thread
 * never went quiet, so the value is the cap, not a measurement. Rows from
 * harnesses that did not record `uiQuietTimedOut` are recognised by landing at
 * least 19 s past readiness, which only a capped wait does (it stops at 20 s
 * with a long task inside the last 500 ms).
 */
export function uiQuietValue(row) {
  if (!Number.isFinite(row?.uiQuietMs)) return null;
  if (row.uiQuietTimedOut === true) return null;
  if (row.uiQuietTimedOut === undefined && Number.isFinite(row.interactiveMs) && row.uiQuietMs - row.interactiveMs >= UI_QUIET_CAP_MS - 1000) return null;
  return row.uiQuietMs;
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
