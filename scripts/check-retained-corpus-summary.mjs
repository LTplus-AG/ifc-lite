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
 */

import { readFileSync } from 'node:fs';
import { isMainEntry } from './lib/is-main-entry.mjs';

export function corpusProblems(summary) {
  if (summary === null || typeof summary !== 'object' || Array.isArray(summary)) return ['INCOMPLETE: summary.json is not an object'];
  const problems = [];
  if (summary.complete !== true) problems.push('INCOMPLETE: the run is not marked complete (timeout or crash; not a parity result)');
  for (const key of ['violations', 'universeMismatch', 'skipped']) {
    if (!Array.isArray(summary[key])) problems.push(`INCOMPLETE: ${key} is missing or not an array`);
    else if (summary[key].length > 0) problems.push(`PARITY: ${key} has ${summary[key].length} entr${summary[key].length === 1 ? 'y' : 'ies'}: ${summary[key].slice(0, 3).join(' | ')}`);
  }
  return problems;
}

if (isMainEntry(import.meta.url)) {
  const args = process.argv.slice(2);
  let expected = null;
  if (args[0] === '--shards') { expected = Number(args[1]); args.splice(0, 2); }
  if (args.length === 0 || (expected !== null && !Number.isInteger(expected))) { console.error('Usage: check-retained-corpus-summary.mjs [--shards N] <summary.json>...'); process.exit(2); }
  const problems = [];
  if (expected !== null && args.length !== expected) problems.push(`INCOMPLETE: expected ${expected} shard summaries, got ${args.length}`);
  for (const file of args) {
    let found;
    try { found = corpusProblems(JSON.parse(readFileSync(file, 'utf8'))); }
    catch (error) { found = [`INCOMPLETE: cannot read ${file}: ${error.message}`]; }
    problems.push(...found.map((p) => (args.length > 1 ? `${file}: ${p}` : p)));
  }
  if (problems.length > 0) {
    console.error(`❌ native corpus failed:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  console.log(`✅ native corpus: ${args.length} summar${args.length === 1 ? 'y' : 'ies'} complete, no violations, universe mismatches or skipped models`);
}
