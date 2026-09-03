/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
import { DirtyPrScanError } from './dirty-pr-scan.mjs';

/**
 * `topLevelTriggerNames` reads the trigger keys directly under a workflow's
 * top-level `on:` block ('push', 'workflow_dispatch', 'schedule', ...).
 *
 * Exists so `scripts/scan-dirty-prs.test.mjs`'s #3776 regression ("the scan
 * has a trigger that does not depend on GitHub cron delivery") can assert on
 * a PARSED trigger list instead of matching regexes against the workflow's
 * raw text -- the latter is exactly the pattern
 * `scripts/check-source-text-assertions.mjs` (#2434) exists to ratchet out,
 * because it certifies that a string of the right shape exists in the file
 * rather than that the workflow actually behaves the way the test claims.
 *
 * `requiredWorkflowTriggers` below does the file read itself so that no test
 * file ever calls `readFileSync` on the workflow and passes the bytes to a
 * predicate directly; this function stays pure and is exercised with literal
 * fixture text in `scripts/lib/workflow-triggers.test.mjs`.
 *
 * @param {string} text - a GitHub Actions workflow file's contents.
 * @returns {string[]} the trigger keys under `on:`, in file order.
 */
export function topLevelTriggerNames(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new DirtyPrScanError('NO_WORKFLOW_TEXT', 'The workflow text is empty, so its triggers cannot be read.');
  }
  const lines = text.split(/\r?\n/);

  const start = lines.findIndex((l) => /^on:\s*(#.*)?$/.test(l));
  if (start === -1) {
    throw new DirtyPrScanError('NO_ON_BLOCK', 'The workflow has no top-level `on:` block, so its triggers cannot be read.');
  }

  const names = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    // A line back at column 0 is the next top-level workflow key (`jobs:`,
    // `concurrency:`, ...), which ends the `on:` block.
    if (/^\S/.test(line)) break;
    const m = /^\s{2}([A-Za-z_][\w-]*):/.exec(line);
    if (m) names.push(m[1]);
  }
  if (names.length === 0) {
    throw new DirtyPrScanError('NO_TRIGGERS', 'The workflow`s `on:` block declares no trigger keys.');
  }
  return names;
}

/**
 * `topLevelTriggerNames`, reading the workflow file itself. Kept separate so
 * that a caller which only wants to assert on the parsed trigger list -- as
 * opposed to unit-testing the parser against hand-written fixtures -- never
 * needs its own `readFileSync` call.
 *
 * @param {string} workflowPath - absolute path to a workflow YAML file.
 * @returns {string[]}
 */
export function requiredWorkflowTriggers(workflowPath) {
  return topLevelTriggerNames(readFileSync(workflowPath, 'utf8'));
}
