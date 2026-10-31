#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Verdict for the nightly native corpus run (#7955).
 *
 * `retained_compare` without `--gate` exits 0 on comparison violations,
 * universe mismatches and absent fixtures, and `--gate` itself also compares
 * the committed coverage manifests, which a downloaded corpus does not carry.
 * So the nightly reads `summary.json` instead: the run must be complete and
 * `violations`, `universeMismatch` and `skipped` must be present and empty.
 *
 * An INCOMPLETE run (timeout or crash: `complete` is not true) is reported
 * apart from a PARITY failure (a finished run with violations), so a red
 * nightly says which it is. With `--shards N` exactly N summaries must be given.
 *
 * `--report-violations` makes PARITY entries warnings (counted, listed in the
 * job summary) instead of failures. The first sharded corpus run found
 * thousands of `source oracle failed` violations in a complete run, so gating
 * on them would leave the nightly permanently red until a baseline exists; an
 * INCOMPLETE run, a universe mismatch or an absent fixture still fail.
 */

import { readFileSync } from 'node:fs';
import { isMainEntry } from './lib/is-main-entry.mjs';

export function corpusFindings(summary, { reportViolations = false } = {}) {
  if (summary === null || typeof summary !== 'object' || Array.isArray(summary)) return { problems: ['INCOMPLETE: summary.json is not an object'], warnings: [] };
  const problems = [];
  const warnings = [];
  if (summary.complete !== true) problems.push('INCOMPLETE: the run is not marked complete (timeout or crash; not a parity result)');
  for (const key of ['violations', 'universeMismatch', 'skipped']) {
    if (!Array.isArray(summary[key])) problems.push(`INCOMPLETE: ${key} is missing or not an array`);
    else if (summary[key].length > 0) {
      const line = `PARITY: ${key} has ${summary[key].length} entr${summary[key].length === 1 ? 'y' : 'ies'}: ${summary[key].slice(0, 3).join(' | ')}`;
      (reportViolations && key === 'violations' ? warnings : problems).push(line);
    }
  }
  return { problems, warnings };
}

export const corpusProblems = (summary, options) => corpusFindings(summary, options).problems;

if (isMainEntry(import.meta.url)) {
  const args = process.argv.slice(2);
  let expected = null;
  let reportViolations = false;
  while (args[0]?.startsWith('--')) {
    const flag = args.shift();
    if (flag === '--shards') expected = Number(args.shift());
    else if (flag === '--report-violations') reportViolations = true;
    else { console.error(`Unknown flag ${flag}`); process.exit(2); }
  }
  if (args.length === 0 || (expected !== null && !Number.isInteger(expected))) { console.error('Usage: check-retained-corpus-summary.mjs [--shards N] [--report-violations] <summary.json>...'); process.exit(2); }
  const problems = [];
  const warnings = [];
  if (expected !== null && args.length !== expected) problems.push(`INCOMPLETE: expected ${expected} shard summaries, got ${args.length}`);
  for (const file of args) {
    let found;
    try { found = corpusFindings(JSON.parse(readFileSync(file, 'utf8')), { reportViolations }); }
    catch (error) { found = { problems: [`INCOMPLETE: cannot read ${file}: ${error.message}`], warnings: [] }; }
    const label = (p) => (args.length > 1 ? `${file}: ${p}` : p);
    problems.push(...found.problems.map(label));
    warnings.push(...found.warnings.map(label));
  }
  for (const w of warnings) console.log(`::warning title=native corpus parity (report only)::${w.slice(0, 400)}`);
  if (problems.length > 0) {
    console.error(`❌ native corpus failed:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  console.log(`✅ native corpus: ${args.length} summar${args.length === 1 ? 'y' : 'ies'} complete, no universe mismatches or skipped models${warnings.length ? ` (${warnings.length} report-only parity warning(s))` : ', no violations'}`);
}
