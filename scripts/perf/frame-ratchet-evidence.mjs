#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Same-build repeatability of the deterministic frame rig's rows, and which of
 * them may carry a `browser-frames` ratchet ceiling (#6975, M4 #6959).
 *
 *   node scripts/perf/frame-ratchet-evidence.mjs --seed <sha> --runs <gh-run-list.json>
 *        --out <evidence.json> <artifact-dir>...
 *
 * Each <artifact-dir> is `gh run download <id> -n browser-frames -D <dir>`
 * named by its run id; --runs is `gh run list --json databaseId,headSha,updatedAt`.
 * Every artifact is put through the production admission (`requireFrameEvidence`);
 * only admitted ones enter the statistics, refused ones are kept as receipts
 * and counted in the GPU-contamination tally. The committed evidence is
 * recomputed from its own raw values by frame-ratchet-evidence.test.mjs, so
 * no number here is hand-typed.
 *
 * CRITERIA (one pass per fixture/scenario/metric row):
 *  1. Rows fixed by the scripted scenario are informational: orbit/hover frame
 *     counts are the script's length, the lockstep clock never skips a slot,
 *     and the spec already fails any rAF gap there.
 *  2. Orbit/hover render and GPU-work counts are informational by #6975's
 *     ruling: they follow the viewer's adaptive render throttle on SwiftShader,
 *     so a slower runner changes them with no code change.
 *  3. Every other row is judged on data, within EACH build that has at least
 *     MIN_ADMITTED_RUNS admitted runs:
 *     - identical in every run of a build: an `exact` ceiling;
 *     - otherwise its spread (max/min - 1) must stay <= RELATIVE_SPREAD_CAP in
 *       every build; the tolerance is TOLERANCE_MARGIN x the widest spread,
 *       rounded UP to TOLERANCE_STEP. Because the daily job may lower a
 *       ceiling to any value it measures, the band must also hold the seed
 *       build's maximum when the ceiling sits at its MINIMUM (checked with the
 *       ratchet's own `allowedMax`), or lowering would make main flake;
 *     - anything wider is noise for a gate and stays informational.
 *  Ceilings are seeded at the seed build's (current main's) maximum, a real
 *  measured value, never extrapolated.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { allowedMax } from '../perf-ratchet/compare.mjs';
import { isMainEntry } from '../lib/is-main-entry.mjs';

export const CRITERIA = {
  minAdmittedRuns: 5,
  relativeSpreadCap: 0.01,
  toleranceMargin: 2,
  toleranceStep: 0.005,
  scripted: { scenarios: ['orbit', 'hover'], metrics: ['frames', 'missed_vsyncs', 'frames_without_raf'] },
  throttled: { scenarios: ['orbit', 'hover'], metrics: ['rendered_frames', 'idle_frames', 'gpu_submits', 'gpu_draws', 'gpu_write_kib'] },
};

const round = (v, digits = 6) => Math.round(v * 10 ** digits) / 10 ** digits;

/** Distribution of one row within one build. */
export function rowStats(values) {
  const n = values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0], max = sorted[n - 1];
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return {
    n, min, max, median: round(median), mean: round(mean), sd: round(sd),
    cv: mean > 0 ? round(sd / mean) : 0,
    spread: min > 0 ? round(max / min - 1) : (max === 0 ? 0 : null),
    exact: min === max,
  };
}

function excluded(scenario, metric) {
  for (const [rule, why] of [
    ['scripted', 'fixed by the scripted scenario, not by the app'],
    ['throttled', '#6975: follows the adaptive render throttle under SwiftShader'],
  ]) {
    const c = CRITERIA[rule];
    if (c.scenarios.includes(scenario) && c.metrics.includes(metric)) return { kind: 'informational', rule, reason: why };
  }
  return null;
}

/**
 * Verdict for one row. `builds` maps commit -> { values, runs }, `seed` names
 * the build the ceiling binds; `measuredAt` maps run id -> ISO time.
 */
export function rowVerdict({ fixture, scenario, metric }, builds, seed, measuredAt) {
  const rule = excluded(scenario, metric);
  if (rule) return rule;
  const stats = Object.entries(builds).map(([commit, b]) => ({ commit, ...rowStats(b.values) }));
  const thin = stats.filter((s) => s.n < CRITERIA.minAdmittedRuns);
  if (thin.length) throw new Error(`${fixture}/${scenario}/${metric}: build ${thin[0].commit} has ${thin[0].n} admitted runs (< ${CRITERIA.minAdmittedRuns})`);
  const seeded = builds[seed];
  const top = stats.find((s) => s.commit === seed);
  const at = measuredAt[seeded.runs[seeded.values.indexOf(top.max)]];
  if (stats.every((s) => s.exact)) {
    return { kind: 'exact', reason: 'identical in every admitted run of every build', ceiling: top.max, tolerance: { kind: 'exact', value: 0 }, provenance: { commit: seed, measuredAt: at } };
  }
  const widest = Math.max(...stats.map((s) => (s.spread === null ? Infinity : s.spread)));
  if (!(widest <= CRITERIA.relativeSpreadCap)) {
    return { kind: 'informational', rule: 'noisy', reason: `same-build spread ${widest === Infinity ? 'unbounded (zero minimum)' : `${(widest * 100).toFixed(2)}%`} exceeds the ${CRITERIA.relativeSpreadCap * 100}% cap` };
  }
  const step = CRITERIA.toleranceStep;
  const value = round(Math.max(step, Math.ceil(round(CRITERIA.toleranceMargin * widest / step, 9)) * step), 6);
  const tolerance = { kind: 'relative', value };
  const lowestCeiling = { ceiling: top.min, tolerance };
  if (allowedMax(lowestCeiling) < top.max) {
    return { kind: 'informational', rule: 'lowering-unsafe', reason: `a ceiling lowered to the seed minimum would refuse the seed maximum at +${value * 100}%` };
  }
  return { kind: 'relative', reason: `widest same-build spread ${(widest * 100).toFixed(3)}%`, ceiling: top.max, tolerance, provenance: { commit: seed, measuredAt: at } };
}

/** Group admitted artifacts' values per row and build; stats + verdict per row. */
export function computeRows(artifacts, seed) {
  const admitted = artifacts.filter((a) => a.admitted);
  const measuredAt = Object.fromEntries(admitted.map((a) => [a.run, a.measuredAt]));
  const keys = [...new Set(admitted.flatMap((a) => Object.keys(a.values)))];
  return keys.map((key) => {
    const [fixture, scenario, metric] = key.split('/');
    const builds = {};
    for (const a of admitted) {
      const b = (builds[a.commit] ??= { runs: [], values: [] });
      b.runs.push(a.run);
      b.values.push(a.values[key]);
    }
    const stats = Object.fromEntries(Object.entries(builds).map(([c, b]) => [c, rowStats(b.values)]));
    return { fixture, scenario, metric, stats, verdict: rowVerdict({ fixture, scenario, metric }, builds, seed, measuredAt) };
  });
}

/** Attempts and GPU-contaminated attempts per fixture, admitted or not. */
export function contaminationTally(artifacts) {
  const tally = {};
  for (const a of artifacts) for (const attempt of a.attempts) {
    const t = (tally[attempt.fixture] ??= { attempts: 0, contaminated: 0, runsWithContamination: [] });
    t.attempts += 1;
    if (attempt.contaminated) {
      t.contaminated += 1;
      if (!t.runsWithContamination.includes(a.run)) t.runsWithContamination.push(a.run);
    }
  }
  return tally;
}

/** Recompute everything derived from the artifacts' committed raw values. */
export function deriveEvidence({ seed, artifacts }) {
  const rows = computeRows(artifacts, seed);
  return {
    rows,
    contamination: contaminationTally(artifacts),
    ratchet: rows.filter((r) => r.verdict.kind !== 'informational').map((r) => `${r.fixture}/${r.scenario}/${r.metric}`),
  };
}

/** Read one downloaded artifact and put it through production admission. */
export function readArtifact(dir, runs, requireFrameEvidence) {
  const run = basename(dir);
  const meta = runs.find((r) => String(r.databaseId) === run);
  if (!meta) throw new Error(`run ${run} is not in --runs`);
  const raw = readFileSync(join(dir, 'browser-frames.json'));
  const json = JSON.parse(raw.toString('utf8'));
  let admissionError = null;
  try { requireFrameEvidence(json); } catch (error) { admissionError = String(error.message ?? error); }
  const attempts = [...(json.refusedAttempts ?? []), ...json.samples].map((s) => ({
    fixture: s.fixture, attempt: s.attempt ?? null, contaminated: s.gpuHealth?.contaminated === true,
  }));
  return {
    run, commit: meta.headSha, measuredAt: meta.updatedAt, rawSha256: createHash('sha256').update(raw).digest('hex'),
    schema: json.schema, browser: json.browser, admitted: admissionError === null, admissionError, attempts,
    values: admissionError === null ? Object.fromEntries(json.rows.map((r) => [`${r.fixture}/${r.scenario}/${r.metric}`, r.value])) : {},
  };
}

if (isMainEntry(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const flag = (name) => { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) throw new Error(`${name} is required`); return args.splice(i, 2)[1]; };
    const seed = flag('--seed'), runsFile = flag('--runs'), out = flag('--out');
    const { tsImport } = await import('tsx/esm/api');
    const { requireFrameEvidence } = await tsImport('../../tests/benchmark/frames/frame-evidence.ts', import.meta.url);
    const runs = JSON.parse(readFileSync(runsFile, 'utf8'));
    const artifacts = args.map((dir) => readArtifact(resolve(dir), runs, requireFrameEvidence))
      .sort((a, b) => Number(a.run) - Number(b.run));
    const evidence = { issue: 6975, seed, criteria: CRITERIA, artifacts, ...deriveEvidence({ seed, artifacts }) };
    writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`frame-ratchet-evidence: ${artifacts.filter((a) => a.admitted).length}/${artifacts.length} admitted; ratchet: ${evidence.ratchet.join(', ') || 'none'}`);
  } catch (error) {
    console.error(`frame-ratchet-evidence: ${error.message}`);
    process.exitCode = 2;
  }
}
