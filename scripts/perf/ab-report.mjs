#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Reporter for scripts/perf/ab.sh. Reads the interleaved runs JSONL (one line
// per {side, ...probe}) and prints a per-fixture, per-phase base-vs-branch
// table with a trustworthiness verdict.
//
// Design choices that matter (see scripts/perf/README.md failure ledger):
//   - MEDIAN, not mean: robust to a single GC/scheduler hiccup.
//   - NOISE GUARD: the base side's own spread is the machine's noise floor for
//     this run. A delta smaller than that floor is reported as "within noise",
//     never as a win — this is the guard that would have killed the phantom
//     +31%/+43% and stale-artifact hunts.
//   - BYTE-IDENTITY: mesh/vertex/triangle counts must match across sides. A
//     "faster" branch that changed the output is flagged LOUDLY — a speedup is
//     only real if the work is the same (or the output change is intended and
//     stated).

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
  console.error('ab-report: pass the runs JSONL path');
  process.exit(2);
}

const rows = readFileSync(jsonlPath, 'utf-8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));

// Phases to report, in pipeline order. `parseMs` is the gate on
// time-to-first-geometry; keep it first.
const PHASES = [
  ['parseMs', 'parse'],
  ['entityScanMs', 'entity-scan'],
  ['lookupMs', 'lookup/styles'],
  ['preprocessMs', 'preprocess'],
  ['geometryMs', 'geometry'],
  ['totalMs', 'TOTAL'],
];
// Output fingerprint fields — must be identical across sides.
const FINGERPRINT = ['meshes', 'vertices', 'triangles'];

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
const fmt = (n) => (n == null ? '—' : n.toFixed(1));
const sign = (n) => (n == null ? '' : n >= 0 ? '+' : '');

// Group by fixture path, then by side.
const byFixture = new Map();
for (const r of rows) {
  if (!byFixture.has(r.path)) byFixture.set(r.path, { base: [], branch: [] });
  byFixture.get(r.path)[r.side]?.push(r);
}

const report = { base: baseLabel, branch: branchLabel, fixtures: [] };
let anyRealChange = false;
let anyFingerprintDrift = false;
let anyTooNoisy = false;

const lines = [];
lines.push(`\nperf A/B  base=${baseLabel}  branch=${branchLabel}`);

for (const [path, sides] of byFixture) {
  const name = path.split('/').pop();
  const fx = { fixture: name, phases: [], fingerprint: {} };

  // Byte-identity first — a changed output invalidates any timing comparison.
  const fpNotes = [];
  for (const f of FINGERPRINT) {
    const b = sides.base[0]?.[f];
    const br = sides.branch[0]?.[f];
    fx.fingerprint[f] = { base: b, branch: br };
    if (b !== br) {
      fpNotes.push(`${f} ${b}→${br}`);
      anyFingerprintDrift = true;
    }
  }

  lines.push(`\n  ${name}`);
  if (fpNotes.length) {
    lines.push(`    ⚠️  OUTPUT CHANGED: ${fpNotes.join(', ')} — timing delta is NOT a like-for-like comparison.`);
  }
  lines.push(`    ${'phase'.padEnd(14)} ${baseLabel.padStart(9)} ${branchLabel.padStart(9)}   delta    noise`);

  for (const [key, label] of PHASES) {
    const baseVals = sides.base.map((r) => r[key]).filter((x) => typeof x === 'number');
    const branchVals = sides.branch.map((r) => r[key]).filter((x) => typeof x === 'number');
    if (!baseVals.length || !branchVals.length) continue;
    const bMed = median(baseVals);
    const brMed = median(branchVals);
    const d = pct(brMed, bMed);
    const noise = spreadPct(baseVals); // machine noise floor for this phase
    // A change is only "real" if it exceeds the base's own spread AND a small
    // absolute floor (sub-ms phases are all noise).
    const real = d != null && Math.abs(d) > Math.max(noise, 3) && Math.abs(brMed - bMed) >= 1;
    if (key !== 'totalMs' && real) anyRealChange = true;
    if (key === 'totalMs' && noise > 15) anyTooNoisy = true;
    const tag = real ? (d < 0 ? '  ✅' : '  ⛔') : '  ·';
    lines.push(
      `    ${label.padEnd(14)} ${fmt(bMed).padStart(9)} ${fmt(brMed).padStart(9)}  ${(sign(d) + fmt(d) + '%').padStart(7)}  ${('±' + noise.toFixed(0) + '%').padStart(6)}${tag}`
    );
    fx.phases.push({ phase: label, baseMedianMs: bMed, branchMedianMs: brMed, deltaPct: d, noisePct: noise, real });
  }
  report.fixtures.push(fx);
}

// Verdict.
lines.push('');
if (anyFingerprintDrift) {
  lines.push('VERDICT: ⚠️  output fingerprint changed — re-pin determinism manifests and state the output change; the timing delta is not like-for-like.');
} else if (anyTooNoisy) {
  lines.push('VERDICT: ⚠️  machine too noisy (base TOTAL spread >15%) — close other load and re-run with more --iters before trusting any delta.');
} else if (anyRealChange) {
  lines.push('VERDICT: a phase moved beyond the noise floor (✅ faster / ⛔ slower). Output is byte-identical. Cite the ✅/⛔ phases + these numbers in the PR.');
} else {
  lines.push('VERDICT: no phase moved beyond the machine noise floor — within noise, byte-identical. Not a measurable change on this fixture.');
}

const out = lines.join('\n');
console.log(out);
if (jsonOut) {
  report.verdict = { fingerprintDrift: anyFingerprintDrift, tooNoisy: anyTooNoisy, realChange: anyRealChange };
  writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  console.log(`\n(machine-readable report → ${jsonOut})`);
}
