#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Refuse a PR that adds files to the retired evidence trees (#9054).
 *
 * 650 MB of receipts, logs, screenshots and tarballs built up in the tracked
 * tree before these were removed, one PR at a time. Evidence belongs in the PR
 * description or a CI artifact, and a file a test reads belongs in
 * tests/fixtures/.
 *
 * `tests/evidence/` stays open for what the gates read: a slice's
 * `witnesses.txt`, and the `oracle.json` and `*.oracle.patch` that
 * `scripts/revert-oracle-discover.mjs` discovers. Exit 1 on a refusal, 2 when
 * git cannot answer, so a shallow checkout never reads as a clean one.
 */
import { execFileSync } from 'node:child_process';
import { isMainEntry } from './lib/is-main-entry.mjs';

const RETIRED_TREES = [
  /^docs\/architecture\/evidence\//,
  /^scripts\/perf\/evidence\//,
  /^tests\/e2e\/evidence\//,
  /^tests\/ui-scenes\/(?:.*\/)?evidence\//,
  /^tools\/(?:.*\/)?evidence\//,
];
const GATE_INPUT = /^tests\/evidence\/[^/]+\/(?:witnesses\.txt|oracle\.json|[^/]+\.oracle\.patch)$/;

export function isRetiredEvidence(path) {
  if (path.startsWith('tests/evidence/')) return !GATE_INPUT.test(path);
  return RETIRED_TREES.some(tree => tree.test(path));
}

/** Renames count as additions: moving a bundle into a retired tree still adds it there. */
export function addedPaths(root, base, head) {
  return execFileSync('git', ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', `${base}...${head}`],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\0').filter(Boolean);
}

function main(argv) {
  const value = flag => { const index = argv.indexOf(flag); return index < 0 ? undefined : argv[index + 1]; };
  const base = value('--base');
  if (!base) { console.error('BAD_ARGS: --base <ref> is required.'); return 2; }
  let added;
  try { added = addedPaths(process.cwd(), base, value('--head') ?? 'HEAD'); }
  catch (error) { console.error(`NO_DIFF: cannot compare against ${base}: ${error.message}\nRemedy: fetch full history for the base and head.`); return 2; }
  const refused = added.filter(isRetiredEvidence);
  if (!refused.length) { console.log(`check-no-retained-evidence: OK (${added.length} added file(s) checked).`); return 0; }
  console.error(`RETAINED_EVIDENCE: ${refused.length} added file(s) in a retired evidence tree (#9054):`);
  for (const path of refused) console.error(`  ${path}`);
  console.error('Remedy: put evidence in the PR description or a CI artifact. A file a test reads goes in tests/fixtures/.');
  return 1;
}

if (isMainEntry(import.meta.url)) process.exit(main(process.argv.slice(2)));
