#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * List, and with --apply remove, oracle files that have reached this branch.
 *
 * `scripts/revert-oracle-discover.mjs` only reads manifests ADDED by the PR under
 * test, so an `oracle.json` or `*.oracle.patch` has done its job once it merges.
 * Run from `.github/workflows/oracle-file-sweep.yml`, so that `tests/evidence/`
 * holds only the `witnesses.txt` registrations the retained gates read (#9054).
 */
import { execFileSync } from 'node:child_process';
import { isMainEntry } from './lib/is-main-entry.mjs';

const ORACLE_FILE = /^tests\/evidence\/[^/]+\/(?:oracle\.json|[^/]+\.oracle\.patch)$/;

export function oracleFiles(root) {
  return execFileSync('git', ['ls-files', '-z', 'tests/evidence'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(path => ORACLE_FILE.test(path));
}

function main(argv) {
  const root = process.cwd();
  const files = oracleFiles(root);
  if (argv.includes('--apply') && files.length) {
    execFileSync('git', ['rm', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'], { cwd: root, input: `${files.join('\0')}\0` });
  }
  console.log(`sweep-oracle-files: ${files.length} merged oracle file(s)${argv.includes('--apply') ? ' removed' : ''}.`);
  for (const path of files) console.log(`  ${path}`);
  return 0;
}

if (isMainEntry(import.meta.url)) process.exit(main(process.argv.slice(2)));
