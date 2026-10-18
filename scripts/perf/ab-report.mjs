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
// Output fingerprint fields. NOTE: these are COUNTS, not a content hash — equal
// counts across sides are necessary-but-not-sufficient for identical output
// (distinct geometry can preserve all three). So the verdict says "counts
// matched", never "byte-identical"; a real byte-identity gate is the
// mesh_determinism manifest, not this harness.
const FINGERPRINT = ['meshes', 'vertices', 'triangles'];
const REQUIRED_PHASES = ['parseMs', 'geometryMs', 'totalMs'];

function invalidInput(message) {
  console.error(`ab-report: invalid comparison input: ${message}`);
  process.exit(2);
}

let rows;
try {
  rows = readFileSync(jsonlPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        invalidInput(`line ${index + 1} is not valid JSON (${error.message})`);
      }
    });
} catch (error) {
  invalidInput(`cannot read runs JSONL (${error.message})`);
}

if (rows.length === 0) invalidInput('runs JSONL is empty');

const byFixture = new Map();
for (const [index, row] of rows.entries()) {
  const line = index + 1;
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    invalidInput(`line ${line} must contain a JSON object`);
  }
  if (typeof row.path !== 'string' || row.path.trim().length === 0 || row.path.trim().split(/[\\/]/).pop().length === 0) {
    invalidInput(`line ${line} is missing a usable fixture path`);
  }
  if (row.side !== 'base' && row.side !== 'branch') {
    invalidInput(`line ${line} has side ${JSON.stringify(row.side)}; input sides must be literal "base" or "branch"`);
  }
  for (const field of REQUIRED_PHASES) {
    if (!Number.isFinite(row[field]) || row[field] < 0) {
      invalidInput(`line ${line} requires a finite nonnegative ${field}`);
    }
  }
  for (const [field] of PHASES) {
    if (Object.hasOwn(row, field) && (!Number.isFinite(row[field]) || row[field] < 0)) {
      invalidInput(`line ${line} has invalid ${field}; present phase values must be finite and nonnegative`);
    }
  }
  for (const field of FINGERPRINT) {
    if (!Number.isInteger(row[field]) || row[field] < 0) {
      invalidInput(`line ${line} requires a nonnegative integer ${field} count`);
    }
  }
  if (!byFixture.has(row.path)) byFixture.set(row.path, { base: [], branch: [] });
  byFixture.get(row.path)[row.side].push(row);
}

for (const [path, sides] of byFixture) {
  if (sides.base.length === 0 || sides.branch.length === 0) {
    invalidInput(`fixture ${path} needs at least one base and one branch sample`);
  }
  if (sides.base.length !== sides.branch.length) {
    invalidInput(`fixture ${path} has unequal paired sample counts (base ${sides.base.length}, branch ${sides.branch.length})`);
  }
}

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

const report = { base: baseLabel, branch: branchLabel, fixtures: [] };
let anyRealChange = false;
let anyFingerprintDrift = false;
let anyTooNoisy = false;
let anyBelowResolution = false;
let anyZeroBaselineIncrease = false;

const lines = [];
lines.push(`\nperf A/B  base=${baseLabel}  branch=${branchLabel}`);

for (const [path, sides] of byFixture) {
  const name = path.split('/').pop();
  const fx = { fixture: name, phases: [], fingerprint: {} };

  // Output-count fingerprint first — a changed count invalidates any timing
  // comparison. Check EVERY round on both sides (not just the first): a count
  // that drifts across rounds is itself non-determinism worth flagging, and a
  // base-vs-branch difference in any round means the output changed.
  const fpNotes = [];
  for (const f of FINGERPRINT) {
    const baseSet = [...new Set(sides.base.map((r) => r[f]))];
    const branchSet = [...new Set(sides.branch.map((r) => r[f]))];
    fx.fingerprint[f] = { base: baseSet, branch: branchSet };
    // Non-constant within a side = the pipeline isn't deterministic on this run.
    if (baseSet.length > 1 || branchSet.length > 1) {
      fpNotes.push(`${f} varied across rounds (base ${baseSet.join('/')} · branch ${branchSet.join('/')})`);
      anyFingerprintDrift = true;
    } else if (baseSet[0] !== branchSet[0]) {
      fpNotes.push(`${f} ${baseSet[0]}→${branchSet[0]}`);
      anyFingerprintDrift = true;
    }
  }

  lines.push(`\n  ${name}`);
  if (fpNotes.length) {
    lines.push(`    ⚠️  OUTPUT CHANGED: ${fpNotes.join(', ')} — timing delta is NOT a like-for-like comparison.`);
  }
  lines.push(`    ${'phase'.padEnd(14)} ${baseLabel.padStart(9)} ${branchLabel.padStart(9)}   delta    noise`);

  for (const [key, label] of PHASES) {
    const baseVals = sides.base.map((r) => r[key]).filter((x) => x !== undefined);
    const branchVals = sides.branch.map((r) => r[key]).filter((x) => x !== undefined);
    if (!baseVals.length || !branchVals.length) continue;
    const bMed = median(baseVals);
    const brMed = median(branchVals);
    const d = pct(brMed, bMed);
    const noise = bMed === 0 ? null : spreadPct(baseVals); // no relative noise floor at zero
    const belowResolution = bMed === 0 && brMed === 0;
    const zeroBaselineIncrease = bMed === 0 && brMed > 0;
    if (belowResolution) anyBelowResolution = true;
    if (zeroBaselineIncrease) anyZeroBaselineIncrease = true;
    // A change is only "real" if it exceeds the base's own spread AND a small
    // absolute floor (sub-ms phases are all noise).
    const real = d != null && noise != null && Math.abs(d) > Math.max(noise, 3) && Math.abs(brMed - bMed) >= 1;
    const direction = d == null ? null : d < 0 ? 'faster' : d > 0 ? 'slower' : 'unchanged';
    // TOTAL participates in the verdict too: a regression can be spread across
    // sub-phases that each stay under the per-phase floor while the TOTAL clears
    // it (or land in unaccounted overhead). Excluding TOTAL would let that show
    // ⛔ in the table yet still print "within noise" — a false no-regression.
    if (real) anyRealChange = true;
    if (key === 'totalMs' && noise > 15) anyTooNoisy = true;
    const tag = zeroBaselineIncrease ? '  ⛔ zero baseline'
      : belowResolution ? '  ? below resolution'
        : real ? (direction === 'faster' ? '  ✅' : '  ⛔') : '  ·';
    const noiseLabel = noise == null ? '—' : '±' + noise.toFixed(0) + '%';
    const deltaLabel = d == null ? '—' : sign(d) + fmt(d) + '%';
    lines.push(
      `    ${label.padEnd(14)} ${fmt(bMed).padStart(9)} ${fmt(brMed).padStart(9)}  ${deltaLabel.padStart(7)}  ${noiseLabel.padStart(6)}${tag}`
    );
    fx.phases.push({ phase: label, baseMedianMs: bMed, branchMedianMs: brMed, deltaPct: d, noisePct: noise, real, direction });
  }
  report.fixtures.push(fx);
}

// Verdict.
lines.push('');
if (anyFingerprintDrift) {
  lines.push('VERDICT: ⚠️  output fingerprint changed — re-pin determinism manifests and state the output change; the timing delta is not like-for-like.');
} else if (anyZeroBaselineIncrease) {
  lines.push('VERDICT: ⛔ blocked — a phase increased from a zero baseline; its relative delta and noise floor are undefined. This cannot certify no regression.');
} else if (anyTooNoisy) {
  lines.push('VERDICT: ⚠️  machine too noisy (base TOTAL spread >15%) — close other load and re-run with more --iters before trusting any delta.');
} else if (anyBelowResolution) {
  lines.push('VERDICT: ? inconclusive — a phase is zero on both sides, below timer resolution. This cannot certify no change.');
} else if (anyRealChange) {
  lines.push('VERDICT: a phase moved beyond the noise floor (✅ faster / ⛔ slower). Output counts matched across all rounds (mesh/vertex/triangle — NOT a byte hash; confirm byte-identity via the mesh_determinism manifest if the change could alter geometry). Cite the ✅/⛔ phases + these numbers in the PR.');
} else {
  lines.push('VERDICT: no phase moved beyond the machine noise floor — within noise; output counts matched across all rounds. Not a measurable change on this fixture.');
}

const out = lines.join('\n');
console.log(out);
if (jsonOut) {
  report.verdict = { fingerprintDrift: anyFingerprintDrift, tooNoisy: anyTooNoisy, realChange: anyRealChange,
    inconclusive: anyBelowResolution, zeroBaselineIncrease: anyZeroBaselineIncrease };
  writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  console.log(`\n(machine-readable report → ${jsonOut})`);
}
