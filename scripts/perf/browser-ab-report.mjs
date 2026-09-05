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

// These are the same six KPIs `viewer-benchmark.spec.ts` / `check-benchmark-
// regression.js` treat as the CI-facing metrics — kept identical so a number
// quoted from this tool means the same thing as one from the CI benchmark.
// `totalWallClockMs` (full readiness) and `firstBatchWaitMs`/
// `firstVisibleGeometryMs` (first geometry) are DELIBERATELY both present and
// never collapsed — that separation is the point (#3978).
const METRICS = [
  ['firstBatchWaitMs', 'first-batch (geom submitted)'],
  ['firstVisibleGeometryMs', 'first-visible (actual paint)'],
  ['streamCompleteMs', 'stream-complete'],
  ['spatialReadyMs', 'spatial-ready'],
  ['metadataCompleteMs', 'metadata-complete'],
  ['totalWallClockMs', 'TOTAL (full readiness)'],
];
const FINGERPRINT = ['totalMeshes'];

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

const report = { base: baseLabel, branch: branchLabel, failures: failedRows.length, fixtures: [] };
let anyRealChange = false;
let anyFingerprintDrift = false;
let anyTooNoisy = false;

const lines = [];
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
    report.fixtures.push(fx);
    continue;
  }
  lines.push(`    ${'metric'.padEnd(30)} ${baseLabel.padStart(9)} ${branchLabel.padStart(9)}   delta    noise`);

  for (const [key, label] of METRICS) {
    const bv = baseVals.map((r) => r[key]).filter((x) => typeof x === 'number');
    const brv = branchVals.map((r) => r[key]).filter((x) => typeof x === 'number');
    if (!bv.length || !brv.length) continue;
    const bMed = median(bv);
    const brMed = median(brv);
    const d = pct(brMed, bMed);
    const noise = spreadPct(bv);
    // Same rule as the native ab-report: a change only counts if it clears
    // both the base's own noise floor AND a small absolute ms floor.
    const real = d != null && Math.abs(d) > Math.max(noise, 3) && Math.abs(brMed - bMed) >= 5;
    if (real) anyRealChange = true;
    if (key === 'totalWallClockMs' && noise > 20) anyTooNoisy = true;
    const tag = real ? (d < 0 ? '  ✅' : '  ⛔') : '  ·';
    lines.push(
      `    ${label.padEnd(30)} ${fmt(bMed).padStart(9)} ${fmt(brMed).padStart(9)}  ${(sign(d) + (d == null ? '—' : d.toFixed(1)) + '%').padStart(7)}  ${('±' + noise.toFixed(0) + '%').padStart(6)}${tag}`
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
} else if (anyTooNoisy) {
  lines.push('VERDICT: ⚠️  machine too noisy (base TOTAL spread >20%) — close other load and re-run with more --iters before trusting any delta.');
} else if (anyRealChange) {
  lines.push(`VERDICT: a metric moved beyond the noise floor (✅ faster / ⛔ slower). ${baseLabel} vs ${branchLabel}. totalMeshes matched across all rounds on every fixture with comparable samples.`);
} else {
  lines.push('VERDICT: no metric moved beyond the machine noise floor — within noise; totalMeshes matched across all rounds.');
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
  };
  writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  console.log(`\n(machine-readable report → ${jsonOut})`);
}

process.exit(rows.length === 0 ? 1 : 0);
