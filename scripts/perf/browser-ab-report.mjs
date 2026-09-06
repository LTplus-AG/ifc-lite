#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Reporter for scripts/perf/browser-cold-ab.mts. Reads the interleaved runs
// JSONL (one line per {side, fixture, round, ok, ...ViewerBenchmarkMetrics})
// and prints a per-fixture, per-metric base-vs-branch table with a
// trustworthiness verdict. Deliberately mirrors scripts/perf/ab-report.mjs
// (the native probe's reporter) so a reader who trusts one trusts the other:
// same MEDIAN-not-mean, same base-side-spread noise floor, same
// fingerprint-drift-invalidates-timing rule.
//
// Usage:
//   node scripts/perf/browser-ab-report.mjs runs.jsonl --base A --branch B [--json out.json]

import { readFileSync, writeFileSync } from 'fs';

const args = process.argv.slice(2);
const jsonlPath = args.find((a) => !a.startsWith('--'));
const opt = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
};
const baseLabel = opt('--base') ?? 'base';
const branchLabel = opt('--branch') ?? 'branch';
const jsonOut = opt('--json');

if (!jsonlPath) {
  console.error('browser-ab-report: pass the runs JSONL path');
  process.exit(2);
}

const allRows = readFileSync(jsonlPath, 'utf-8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));

// Preserve the legacy KPIs alongside observed readiness; do not relabel app summaries.
// These legacy KPIs `viewer-benchmark.spec.ts` / `check-benchmark-
// regression.js` treat as the CI-facing metrics — kept identical so a number
// quoted from this tool means the same thing as one from the CI benchmark.
// `totalWallClockMs` (legacy app summary, not full readiness) and `firstBatchWaitMs`/
// `firstVisibleGeometryMs` (first geometry) are DELIBERATELY both present and
// never collapsed — that separation is the point (#3978).
const METRICS = [
  ['firstBatchWaitMs', 'first-batch (geom submitted)'],
  ['firstVisibleGeometryMs', 'first-visible (actual paint)'],
  ['streamCompleteMs', 'stream-complete'],
  ['spatialReadyMs', 'spatial-ready'],
  ['metadataCompleteMs', 'metadata-complete'],
  ['metadataRenderReadyMs', 'METADATA + RENDER (observed)'],
  ['totalWallClockMs', 'app total (legacy CI metric)'],
];
const FINGERPRINT = ['totalMeshes'];
// Mesh count is a coarse witness, not payload/vertex identity. Search, cache-tail
// memory, properties, picking and Firefox are not qualified by this report.

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const spreadPct = (xs) => {
  if (xs.length < 2) return 0;
  const med = median(xs);
  if (med <= 0) return 0;
  return ((Math.max(...xs) - Math.min(...xs)) / med) * 100;
};
const pct = (cur, base) => (base > 0 ? ((cur - base) / base) * 100 : null);
const fmt = (n) => (n == null ? '—' : n.toFixed(0));
const sign = (n) => (n == null ? '' : n >= 0 ? '+' : '');

const failedRows = allRows.filter((r) => r.ok === false);
const rows = allRows.filter((r) => r.ok !== false);

const byFixture = new Map();
for (const r of rows) {
  if (!byFixture.has(r.fixture)) byFixture.set(r.fixture, { [baseLabel]: [], [branchLabel]: [] });
  const bucket = byFixture.get(r.fixture)[r.side];
  if (bucket) bucket.push(r);
  else {
    // A side label present in the data but not one of --base/--branch — data
    // integrity problem, not a metric to silently drop.
    (byFixture.get(r.fixture)[r.side] ??= []).push(r);
  }
}

const coverage = 'Observed metadata/geometry/renderer logs plus canvas allocation (100ms polling); search, cache-tail memory, properties, picking and Firefox unqualified.';
const report = { coverage, base: baseLabel, branch: branchLabel, failures: failedRows.length, fixtures: [] };
let anyRealChange = false;
let anyFingerprintDrift = false;
let anyTooNoisy = false;
let anyInsufficientSamples = false;
// Set when a fixture has zero comparable samples on one side (e.g. every
// launch on that side threw and was archived as a failure) — distinct from
// "no metric moved": no comparison happened for that fixture AT ALL, so
// falling through to the calm "within noise" verdict below would print a
// clean-looking pass for a fixture nothing was actually verified on.
let anyIncomparableFixture = false;

const lines = [coverage];
lines.push(`\nbrowser cold-load A/B  base=${baseLabel}  branch=${branchLabel}`);
if (failedRows.length > 0) {
  lines.push(`\n⚠️  ${failedRows.length} sample(s) FAILED and were excluded from the stats below (evidence archived under scripts/perf/.browser-cold-ab-results/FAILED-*):`);
  for (const f of failedRows) lines.push(`   - ${f.side}/${f.fixture}/round${f.round}: ${f.error ?? 'unknown error'}`);
}

for (const [fixture, sides] of byFixture) {
  const baseVals = sides[baseLabel] ?? [];
  const branchVals = sides[branchLabel] ?? [];
  const fx = { fixture, metrics: [], fingerprint: {} };

  const fpNotes = [];
  for (const f of FINGERPRINT) {
    const baseSet = [...new Set(baseVals.map((r) => r[f]))];
    const branchSet = [...new Set(branchVals.map((r) => r[f]))];
    fx.fingerprint[f] = { [baseLabel]: baseSet, [branchLabel]: branchSet };
    if (baseSet.length > 1 || branchSet.length > 1) {
      fpNotes.push(`${f} varied across rounds (${baseLabel} ${baseSet.join('/')} · ${branchLabel} ${branchSet.join('/')})`);
      anyFingerprintDrift = true;
    } else if (baseSet.length && branchSet.length && baseSet[0] !== branchSet[0]) {
      fpNotes.push(`${f} ${baseSet[0]}→${branchSet[0]}`);
      anyFingerprintDrift = true;
    }
  }

  lines.push(`\n  ${fixture}  (${baseVals.length} ${baseLabel} sample(s), ${branchVals.length} ${branchLabel} sample(s))`);
  if (fpNotes.length) {
    lines.push(`    ⚠️  OUTPUT CHANGED: ${fpNotes.join(', ')} — timing delta is NOT like-for-like.`);
  }
  if (!baseVals.length || !branchVals.length) {
    lines.push(`    ⚠️  no comparable samples on one side — no verdict for this fixture.`);
    anyIncomparableFixture = true;
    report.fixtures.push(fx);
    continue;
  }
  const invalidReadiness = [...baseVals, ...branchVals].some(row =>
    !Number.isFinite(row.metadataRenderReadyMs) || row.metadataRenderReadyMs <= 0 ||
    !Number.isFinite(row.metadataCompleteMs) || !Number.isFinite(row.streamCompleteMs) ||
    row.metadataRenderReadyMs < Math.max(row.metadataCompleteMs, row.streamCompleteMs));
  if (invalidReadiness) {
    lines.push('    ⚠️ missing/inconsistent observed metadata-render readiness; legacy app-total records are not comparable.');
    anyIncomparableFixture = true;
    report.fixtures.push(fx);
    continue;
  }
  const rounds = values => new Set(values.map(row => row.round));
  const baseRounds = rounds(baseVals);
  const branchRounds = rounds(branchVals);
  const sufficient = baseVals.length === baseRounds.size && branchVals.length === branchRounds.size &&
    baseRounds.size >= 5 && baseRounds.size === branchRounds.size &&
    [...baseRounds].every(round => branchRounds.has(round));
  if (!sufficient) anyInsufficientSamples = true;
  lines.push(`    ${'metric'.padEnd(30)} ${baseLabel.padStart(9)} ${branchLabel.padStart(9)}   delta    noise`);

  for (const [key, label] of METRICS) {
    const baseValues = new Map(baseVals.filter(row => Number.isFinite(row[key])).map(row => [row.round, row[key]]));
    const branchValues = new Map(branchVals.filter(row => Number.isFinite(row[key])).map(row => [row.round, row[key]]));
    const matchedRounds = [...baseValues.keys()].filter(round => branchValues.has(round));
    const bv = matchedRounds.map(round => baseValues.get(round));
    const brv = matchedRounds.map(round => branchValues.get(round));
    const metricSufficient = sufficient && matchedRounds.length >= 5;
    if (!metricSufficient) anyInsufficientSamples = true;
    if (!bv.length || !brv.length) continue;
    const bMed = median(bv);
    const brMed = median(brv);
    const d = pct(brMed, bMed);
    const noise = metricSufficient ? spreadPct(bv) : null;
    // Same rule as the native ab-report: a change only counts if it clears
    // both the base's own noise floor AND a small absolute ms floor.
    const real = metricSufficient && noise != null && d != null && Math.abs(d) > Math.max(noise, 3) && Math.abs(brMed - bMed) >= 5;
    if (real) anyRealChange = true;
    if (key === 'metadataRenderReadyMs' && noise != null && noise > 20) anyTooNoisy = true;
    const tag = real ? (d < 0 ? '  ✅' : '  ⛔') : '  ·';
    lines.push(
      `    ${label.padEnd(30)} ${fmt(bMed).padStart(9)} ${fmt(brMed).padStart(9)}  ${(sign(d) + (d == null ? '—' : d.toFixed(1)) + '%').padStart(7)}  ${(noise == null ? 'n/a' : '±' + noise.toFixed(0) + '%').padStart(6)}${tag}`
    );
    fx.metrics.push({ metric: label, baseMedianMs: bMed, branchMedianMs: brMed, deltaPct: d, noisePct: noise, real });
  }
  report.fixtures.push(fx);
}

lines.push('');
if (rows.length === 0) {
  lines.push('VERDICT: ❌ no successful samples — see failures above. This is a harness fault, not a clean run.');
} else if (anyFingerprintDrift) {
  lines.push('VERDICT: ⚠️  totalMeshes fingerprint changed — the timing delta is not like-for-like; state the output change or investigate before trusting any number here.');
} else if (failedRows.length > 0) {
  lines.push('VERDICT: failed samples invalidate this run; descriptive successful observations are not a clean performance qualification.');
  if (anyIncomparableFixture) lines.push('VERDICT: inconclusive — at least one fixture had no comparable samples; this is NOT a clean "no regression" result.');
} else if (anyTooNoisy) {
  lines.push('VERDICT: ⚠️  machine too noisy (base observed-readiness spread >20%) — close other load and re-run with more --iters before trusting any delta.');
} else {
  // anyRealChange and anyIncomparableFixture are independent facts about
  // DIFFERENT fixtures (a real move on one fixture says nothing about
  // whether another fixture was ever actually measured), so both lines are
  // printed when both are true - an exclusive if/else here previously let
  // the exit code (nonzero whenever anyIncomparableFixture, regardless of
  // anyRealChange - see below) contradict the ONLY verdict text printed: a
  // real regression detected on one fixture while a different fixture
  // crashed on every launch on one side printed the calm-sounding "a metric
  // moved..." line alone and exited 1, with nothing in the VERDICT itself
  // explaining the nonzero exit.
  if (anyRealChange) {
    lines.push(`VERDICT: a metric moved beyond the noise floor (✅ faster / ⛔ slower). ${baseLabel} vs ${branchLabel}. totalMeshes matched across all rounds on every fixture with comparable samples.`);
  }
  if (anyIncomparableFixture) {
    // NOT the calm "within noise" message below: that message claims every
    // fixture was actually compared. When one side of a fixture produced zero
    // successful samples (e.g. every launch on that side threw), no
    // comparison happened for it at all - falling through to "within noise"
    // here would read as a clean pass for a fixture nothing was verified on.
    lines.push('VERDICT: ⚠️  inconclusive — at least one fixture had no comparable samples on one side (see warnings above); this is NOT a clean "no regression" result.');
  }
  if (anyInsufficientSamples) {
    lines.push('VERDICT: insufficient paired samples (minimum five unique matched rounds); functional observations only, no noise-based performance verdict.');
  }
  if (!anyRealChange && !anyIncomparableFixture && !anyInsufficientSamples) {
    lines.push('VERDICT: no metric moved beyond the machine noise floor — within noise; totalMeshes matched across all rounds.');
  }
}
if (failedRows.length > 0) {
  lines.push(`(${failedRows.length} sample(s) failed and were excluded — a failed run is never silently retried; see evidence paths above.)`);
}

const out = lines.join('\n');
console.log(out);
if (jsonOut) {
  report.verdict = {
    noSuccessfulSamples: rows.length === 0,
    fingerprintDrift: anyFingerprintDrift,
    tooNoisy: anyTooNoisy,
    realChange: anyRealChange,
    insufficientPairedSamples: anyInsufficientSamples,
    incomparableFixture: anyIncomparableFixture,
  };
  writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  console.log(`\n(machine-readable report → ${jsonOut})`);
}

// Nonzero on any harness fault: zero successful samples anywhere, OR at
// least one fixture where one side never produced a single comparable
// sample (the per-fixture version of the same fault - see anyIncomparableFixture
// above). A real regression/improvement (anyRealChange) still exits 0: that
// is a successful, trustworthy comparison reporting a result, not a fault.
process.exit(failedRows.length > 0 || rows.length === 0 || anyIncomparableFixture || anyFingerprintDrift ? 1 : 0);
