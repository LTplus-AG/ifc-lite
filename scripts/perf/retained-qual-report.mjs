#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// REPORT-ONLY reporter for the retained qualification runners (#7955 item 6). It applies
// the criteria scripts/perf/ab-report.mjs fixes (median; the base side's own spread is the
// noise floor; a movement is "real" only beyond max(noise, 3%) AND a 1-unit floor; base
// TOTAL spread > 15% is too noisy; a zero baseline blocks; count drift invalidates the
// comparison) to the retained runners' columns, and never prints a no-regression verdict:
// no retained performance or memory threshold is registered (qualification/PLAN.md).
//
//   node scripts/perf/retained-qual-report.mjs RUNS.jsonl|RESULT_DIR [...] [--json OUT]
//
// Rows from several runner invocations may be mixed (base from one, branch from another is
// NOT paired or order-balanced; the runners' own two-arm mode is). Failed rows are listed
// and excluded, never averaged in. Exit 2 = unreadable input; otherwise 0.

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMainEntry } from '../lib/is-main-entry.mjs';
import { median, spreadPct } from './retained-qual-lib.mjs';

export const NOISE_FLOOR_PCT = 3, ABSOLUTE_FLOOR = 1, TOO_NOISY_PCT = 15;
const FINGERPRINT = ['candidates', 'published', 'refused', 'meshes'];
const PHASES = ['productMs', 'sceneHeldMs', 'firstRetainedFrameMs', 'terminalMs', 'settledFrameMs', 'totalMs', 'startupControlMs', 'importMs', 'runMs',
  'wasmHeapMaxObservedBytes', 'uaAfterBytes', 'uaMemoryBytes', 'browserPeakHwmKiB', 'browserPeakConcurrentPssKiB', 'maxRssKiB', 'processHwmKiB',
  'maxIndividualWorkerHwmKiB', 'maxObservedConcurrentWorkerRssKiB', 'wallMs'];
const TOTALS = new Set(['totalMs', 'terminalMs', 'firstRetainedFrameMs', 'runMs', 'wallMs']);

export function readRows(inputs) {
  const rows = [];
  for (const input of inputs) {
    const path = existsSync(input) && statSync(input).isDirectory() ? join(input, 'runs.jsonl') : input;
    for (const [i, line] of readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).entries()) {
      let row;
      try { row = JSON.parse(line); } catch (error) { throw new Error(`${path} line ${i + 1}: ${error.message}`); }
      if (!row || (row.side !== 'base' && row.side !== 'branch') || typeof row.path !== 'string') throw new Error(`${path} line ${i + 1}: needs side base|branch and a path`);
      rows.push(row);
    }
  }
  if (!rows.length) throw new Error('no rows');
  return rows;
}

export function compare(rows) {
  const failed = rows.filter(r => !r.ok), ok = rows.filter(r => r.ok);
  const report = { reportOnly: true, failures: failed.map(r => ({ side: r.side, path: r.path, round: r.round, error: r.error })), fixtures: [], flags: {
    countDrift: false, tooNoisy: false, zeroBaselineIncrease: false, belowResolution: false, realMovement: false, unpaired: false } };
  const paths = [...new Set(ok.map(r => r.path))];
  for (const path of paths) {
    const base = ok.filter(r => r.path === path && r.side === 'base'), branch = ok.filter(r => r.path === path && r.side === 'branch');
    const fixture = { path, base: base.length, branch: branch.length, fingerprint: {}, columns: [] };
    if (!base.length || !branch.length || base.length !== branch.length) report.flags.unpaired = true;
    for (const key of FINGERPRINT) {
      const [b, r] = [base, branch].map(side => [...new Set(side.map(row => row[key]).filter(v => v !== undefined))]);
      if (!b.length && !r.length) continue;
      fixture.fingerprint[key] = { base: b, branch: r };
      if (b.length > 1 || r.length > 1 || b[0] !== r[0]) report.flags.countDrift = true;
    }
    for (const key of PHASES) {
      const bv = base.map(r => r[key]).filter(Number.isFinite), rv = branch.map(r => r[key]).filter(Number.isFinite);
      if (!bv.length || !rv.length) continue;
      const bMed = median(bv), rMed = median(rv), noise = bMed === 0 ? null : spreadPct(bv);
      const delta = bMed > 0 ? ((rMed - bMed) / bMed) * 100 : null;
      const unit = key.endsWith('Ms') ? ABSOLUTE_FLOOR : 0;
      const real = delta !== null && noise !== null && Math.abs(delta) > Math.max(noise, NOISE_FLOOR_PCT) && Math.abs(rMed - bMed) >= unit;
      const zeroBaselineIncrease = bMed === 0 && rMed > 0, belowResolution = bMed === 0 && rMed === 0;
      if (real) report.flags.realMovement = true;
      if (zeroBaselineIncrease) report.flags.zeroBaselineIncrease = true;
      if (belowResolution) report.flags.belowResolution = true;
      if (TOTALS.has(key) && noise !== null && noise > TOO_NOISY_PCT) report.flags.tooNoisy = true;
      fixture.columns.push({ column: key, baseMedian: bMed, branchMedian: rMed, deltaPct: delta, noisePct: noise, real, zeroBaselineIncrease, belowResolution,
        direction: delta === null ? null : delta < 0 ? 'lower' : delta > 0 ? 'higher' : 'unchanged' });
    }
    report.fixtures.push(fixture);
  }
  return report;
}

export function format(report) {
  const lines = ['retained qualification (REPORT-ONLY: no retained performance or memory threshold is registered)'];
  if (report.failures.length) lines.push(`  ${report.failures.length} FAILED sample(s) excluded, never averaged in:`, ...report.failures.map(f => `    ${f.side} ${f.path.split('/').pop()} r${f.round}: ${f.error}`));
  for (const f of report.fixtures) {
    lines.push(`\n  ${f.path.split('/').pop()}  (base n=${f.base}, branch n=${f.branch})`);
    for (const [key, v] of Object.entries(f.fingerprint)) lines.push(`    ${key}: base ${v.base.join('/')} · branch ${v.branch.join('/')}`);
    for (const c of f.columns) {
      const tag = c.zeroBaselineIncrease ? '  ⛔ zero baseline' : c.belowResolution ? '  ? below resolution' : c.real ? `  ${c.direction === 'lower' ? '↓' : '↑'} beyond noise` : '  ·';
      lines.push(`    ${c.column.padEnd(34)} ${c.baseMedian.toFixed(1).padStart(14)} ${c.branchMedian.toFixed(1).padStart(14)}  ${c.deltaPct === null ? '—' : `${c.deltaPct >= 0 ? '+' : ''}${c.deltaPct.toFixed(1)}%`}`.padEnd(80)
        + ` ±${c.noisePct === null ? '—' : `${c.noisePct.toFixed(0)}%`}${tag}`);
    }
  }
  const flags = report.flags;
  lines.push('', flags.countDrift ? 'NOTE: output counts differ across sides/rounds; timing and memory deltas are NOT like-for-like.'
    : flags.unpaired ? 'NOTE: sides are unpaired or unequal in sample count; this is not a paired comparison.'
      : flags.tooNoisy ? 'NOTE: base spread > 15% on a total; too noisy to read any delta.'
        : 'NOTE: numbers only. Movements are listed against the base spread and are not a regression verdict either way.');
  return lines.join('\n');
}

if (isMainEntry(import.meta.url)) {
  const args = process.argv.slice(2), jsonAt = args.indexOf('--json');
  const jsonOut = jsonAt === -1 ? null : args[jsonAt + 1];
  const inputs = args.filter((a, i) => !a.startsWith('--') && (jsonAt === -1 || i !== jsonAt + 1));
  try {
    if (!inputs.length) throw new Error('pass runs JSONL files or result directories');
    const report = compare(readRows(inputs));
    console.log(format(report));
    if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2) + '\n');
  } catch (error) {
    console.error(`retained-qual-report: invalid input: ${error.message}`);
    process.exitCode = 2;
  }
}
