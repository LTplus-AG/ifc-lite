/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pre-handoff rows for two CI gates that only fire on a PR: the revert oracle
 * in changed-tests mode (test.yml `revert-oracle`) and the UI drift ratchet
 * (test.yml `node-guards`). Whether each runs is read off test.yml itself,
 * through the same filter parser check-ci-path-coverage uses, so this cannot
 * drift from what CI decides.
 */
import { gatingFilters, matchesAny, parseFilterBlock, splitJobs } from './ci-path-coverage.mjs';

/**
 * A job's `if:` as one line; test.yml writes long ones as `>-` block scalars.
 * gatingFilters reads only the first line. Teaching it to unfold makes
 * check-ci-path-coverage newly (and correctly) flag revert-oracle inputs, a
 * test.yml filter change tracked separately.
 */
function jobCondition(jobText) {
  const lines = jobText.split('\n');
  const at = lines.findIndex((line) => /^ {4}if:/.test(line));
  if (at === -1) return '';
  const head = lines[at].replace(/^ {4}if:\s*/, '');
  if (!/^[>|][-+]?$/.test(head)) return head;
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (!/^ {6,}\S/.test(line)) break;
    body.push(line.trim());
  }
  return body.join(' ');
}

/**
 * Why CI's `jobId` would NOT run for these changed paths, or null when it
 * would. A job with no path filter in its `if:` always runs.
 */
export function ciJobSkipReason(workflowText, jobId, paths) {
  const job = splitJobs(workflowText).find((entry) => entry.id === jobId);
  if (!job) throw new Error(`test.yml has no ${jobId} job; update scripts/lib/pre-handoff-ci-mirror.mjs`);
  const filters = gatingFilters(`    if: ${jobCondition(job.text)}`);
  if (filters === null) return null;
  const globs = parseFilterBlock(workflowText);
  if (filters.some((name) => paths.some((path) => matchesAny(path, globs.get(name) ?? [])))) return null;
  return `CI's ${jobId} job would not run: no changed path matches its ${filters.join('/')} filter`;
}

/**
 * Gate rows for runGates. `baseMissing` and `production` come from the
 * caller's diff; `prerequisites()` names unavailable local tooling (or null)
 * and is only consulted when the oracle would otherwise run.
 */
export function ciMirrorGates({ base, baseMissing, workflowText, paths, production, oracleArgs, prerequisites }) {
  // The oracle resolves the repo's typescript only to judge TS production (#4472).
  const deps = production.some(({ path }) => /\.[cm]?tsx?$/.test(path)) ? ['typescript'] : [];
  const oracle = { name: 'revert-oracle (CI changed-tests)', deps, args: [
    'scripts/check-test-revert-oracle.mjs', '--base', base, '--ci', '--json', ...oracleArgs,
  ] };
  const uiDrift = { name: 'ui-drift', args: ['scripts/check-ui-drift.mjs'] };
  if (baseMissing) {
    // Without a base there is no diff to classify; the drift ratchet needs none.
    return [{ ...oracle, unavailable: baseMissing }, uiDrift];
  }
  oracle.unavailable = ciJobSkipReason(workflowText, 'revert-oracle', paths)
    ?? (production.length === 0 ? 'the oracle classifies no changed file as production' : null)
    ?? prerequisites();
  uiDrift.unavailable = ciJobSkipReason(workflowText, 'node-guards', paths);
  return [oracle, uiDrift];
}
