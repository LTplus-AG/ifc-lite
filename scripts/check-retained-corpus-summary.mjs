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
 */

import { readFileSync } from 'node:fs';
import { isMainEntry } from './lib/is-main-entry.mjs';

export function corpusProblems(summary) {
  if (summary === null || typeof summary !== 'object' || Array.isArray(summary)) return ['summary.json is not an object'];
  const problems = [];
  if (summary.complete !== true) problems.push('the run is not marked complete');
  for (const key of ['violations', 'universeMismatch', 'skipped']) {
    if (!Array.isArray(summary[key])) problems.push(`${key} is missing or not an array`);
    else if (summary[key].length > 0) problems.push(`${key} has ${summary[key].length} entr${summary[key].length === 1 ? 'y' : 'ies'}: ${summary[key].slice(0, 3).join(' | ')}`);
  }
  return problems;
}

if (isMainEntry(import.meta.url)) {
  const file = process.argv[2];
  if (!file) { console.error('Usage: check-retained-corpus-summary.mjs <summary.json>'); process.exit(2); }
  let problems;
  try { problems = corpusProblems(JSON.parse(readFileSync(file, 'utf8'))); }
  catch (error) { problems = [`cannot read ${file}: ${error.message}`]; }
  if (problems.length > 0) {
    console.error(`❌ native corpus failed:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('✅ native corpus summary: complete, no violations, universe mismatches or skipped models');
}
