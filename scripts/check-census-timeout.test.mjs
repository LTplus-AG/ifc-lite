/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The accept/reject table for the heavy census lane's two-level timeout,
 * checked in (#4156).
 *
 * It used to be ~60 lines of inline `run:` shell with no test, and reviewing
 * it meant reconstructing this table by hand -- which two separate review
 * rounds each did. Every row below was MEASURED against that shell before it
 * moved, under bash 5.3 with the same `sed -nE` and awk `%d`, so these are the
 * verdicts the workflow already had rather than the ones it ought to have had.
 *
 * EVERY REJECT ASSERTS THE REASON, not merely that it failed. Six checks run in
 * sequence over one input, so "it was rejected" is satisfied by any of them:
 * delete the zero check and `0` is still rejected -- as `overBudget`? no, as
 * nothing, it would be ACCEPTED -- but delete the budget comparison and `1d`
 * would still have to be rejected by something for a bare "not ok" assertion
 * to notice, which it would not be. Pinning the reason is what makes each row
 * fail for the deletion of its own check and no other.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  checkCensusTimeout,
  parseDurationSeconds,
  jobTimeoutMinutes,
  HEADROOM_SECONDS,
  CENSUS_WORKFLOW,
} from './check-census-timeout.mjs';

const GATE = fileURLToPath(new URL('./check-census-timeout.mjs', import.meta.url));

/** The census job's real shape: `timeout-minutes: 60`, so a 3300 s budget. */
const JOB_MINUTES = 60;
const BUDGET = JOB_MINUTES * 60 - HEADROOM_SECONDS;

const scratch = mkdtempSync(join(tmpdir(), 'census-timeout-'));

/** A workflow file carrying exactly one job-level `timeout-minutes`. */
function workflowWith(body) {
  const path = join(scratch, `wf-${Math.random().toString(36).slice(2)}.yml`);
  writeFileSync(path, body);
  return path;
}

const REAL_SHAPED = workflowWith(
  ['jobs:', '  census:', '    runs-on: ubuntu-latest', `    timeout-minutes: ${JOB_MINUTES}`, ''].join(
    '\n',
  ),
);

function check(timeout, { workflowPath = REAL_SHAPED, declaredJobMinutes = JOB_MINUTES } = {}) {
  return checkCensusTimeout({ timeout, declaredJobMinutes, workflowPath });
}

test('the budget this table is measured against is 3300s', () => {
  assert.equal(BUDGET, 3300);
});

// ---------------------------------------------------------------- accept ----

const ACCEPTED = [
  ['50m', 3000],
  ['10s', 10],
  ['3000', 3000],
  ['3300', BUDGET], // exactly the budget, which is inside it
  ['3299.9', 3299], // truncates toward zero, as awk's %d did
];

for (const [timeout, seconds] of ACCEPTED) {
  test(`accepts ${JSON.stringify(timeout)} as ${seconds}s`, () => {
    const result = check(timeout);
    assert.equal(result.ok, true, `expected accept, got ${result.reason}`);
    assert.equal(result.seconds, seconds);
    assert.equal(result.budgetSeconds, BUDGET);
    assert.equal(result.jobMinutes, JOB_MINUTES);
  });
}

test('the accepted value and the budget it was checked against are both printed', () => {
  const result = check('50m');
  assert.equal(result.ok, true);
  assert.equal(
    result.summary,
    'census timeout: 50m (3000s), within the 3300s left by timeout-minutes: 60',
  );
});

// ---------------------------------------------------------------- reject ----

/**
 * `0`/`0s`/`0m` are the coreutils no-limit hole: they pass any upper bound and
 * REMOVE the deadline. The sub-second rows truncate into the same value.
 */
const NON_POSITIVE = ['0', '0s', '0m', '0.5s', '0.9', '0.0001s'];

for (const timeout of NON_POSITIVE) {
  test(`rejects ${JSON.stringify(timeout)} as non-positive`, () => {
    const result = check(timeout);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'nonPositive');
  });
}

/**
 * Negatives land HERE and not in a sign check: the DURATION pattern admits no
 * sign, so `-5m` never reaches any arithmetic. Measured on the shell this
 * replaces; a separate `< 0` branch would be unreachable.
 */
const MALFORMED = ['-5m', '-1', ' 50m', '50 m', '', '50M', '50min', '+50m', '1e3', '50m ', 'm', '.5s'];

for (const timeout of MALFORMED) {
  test(`rejects ${JSON.stringify(timeout)} as malformed`, () => {
    const result = check(timeout);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'malformed');
  });
}

const OVER_BUDGET = ['1h', '90m', '1.5h', '1d', '3301', '99999999999999999999d'];

for (const timeout of OVER_BUDGET) {
  test(`rejects ${JSON.stringify(timeout)} as over budget`, () => {
    const result = check(timeout);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'overBudget');
  });
}

test('an absurd interval fails CLOSED rather than wrapping into range', () => {
  // 8.64e24 s, and a longer digit string is Infinity. Both are > budget.
  assert.equal(check('99999999999999999999d').reason, 'overBudget');
  assert.equal(check(`${'9'.repeat(400)}d`).reason, 'overBudget');
});

// ------------------------------------------------ the job budget is READ ----

test('rejects when the declared copy disagrees with the workflow file', () => {
  const result = check('50m', { declaredJobMinutes: 30 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'staleCopy');
});

test('a stale copy is caught even when the timeout fits the copy it claims', () => {
  // 50m is inside a 60-minute budget and inside the 3300 s the stale copy
  // implies; only reading the file catches it. Here the FILE says 30, so the
  // real budget is 1500 s and 3000 s would blow it.
  const path = workflowWith('jobs:\n  census:\n    timeout-minutes: 30\n');
  const result = check('50m', { workflowPath: path, declaredJobMinutes: 60 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'staleCopy');
});

test('rejects when the workflow file cannot be read', () => {
  const result = check('50m', { workflowPath: join(scratch, 'does-not-exist.yml') });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unreadable');
});

test('rejects when more than one timeout-minutes line matches', () => {
  const path = workflowWith(
    'jobs:\n  census:\n    timeout-minutes: 60\n  other:\n    timeout-minutes: 45\n',
  );
  const result = check('50m', { workflowPath: path });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ambiguousBudget');
});

test('rejects when no timeout-minutes line matches', () => {
  const path = workflowWith('jobs:\n  census:\n    runs-on: ubuntu-latest\n');
  const result = check('50m', { workflowPath: path });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ambiguousBudget');
});

test('the budget follows the file, not the constant', () => {
  const path = workflowWith('jobs:\n  census:\n    timeout-minutes: 90\n');
  const result = check('80m', { workflowPath: path, declaredJobMinutes: 90 });
  assert.equal(result.ok, true);
  assert.equal(result.budgetSeconds, 90 * 60 - HEADROOM_SECONDS);
  assert.equal(check('86m', { workflowPath: path, declaredJobMinutes: 90 }).reason, 'overBudget');
});

// -------------------------------------------- what the line pattern sees ----

test('only an indented, bare-integer timeout-minutes line counts', () => {
  assert.deepEqual(jobTimeoutMinutes('    timeout-minutes: 60\n'), [60]);
  assert.deepEqual(jobTimeoutMinutes('\ttimeout-minutes: 60\n'), [60]);
  assert.deepEqual(jobTimeoutMinutes('    timeout-minutes:   60   \n'), [60]);
  assert.deepEqual(jobTimeoutMinutes('    timeout-minutes: 60\r\n'), [60], 'CRLF checkout');
  // Unindented (not a job key), commented, expression-valued, or trailing text.
  assert.deepEqual(jobTimeoutMinutes('timeout-minutes: 60\n'), []);
  assert.deepEqual(jobTimeoutMinutes('    # timeout-minutes: 60\n'), []);
  assert.deepEqual(jobTimeoutMinutes('    timeout-minutes: 60 # why\n'), []);
  // A template literal with `\$`: the same eight characters, without tripping
  // `no-template-curly-in-string` on a plain quoted `${{`.
  assert.deepEqual(jobTimeoutMinutes(`    timeout-minutes: \${{ env.X }}\n`), []);
});

test('the unit suffixes convert the way coreutils reads them', () => {
  assert.equal(parseDurationSeconds('90'), 90);
  assert.equal(parseDurationSeconds('90s'), 90);
  assert.equal(parseDurationSeconds('90m'), 5400);
  assert.equal(parseDurationSeconds('2h'), 7200);
  assert.equal(parseDurationSeconds('1d'), 86400);
  assert.equal(parseDurationSeconds('1.5h'), 5400);
  assert.equal(parseDurationSeconds('nope'), null);
});

// ------------------------------------------------------- the CLI contract ----

function runGate(env, args = [REAL_SHAPED]) {
  return spawnSync(process.execPath, [GATE, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env },
  });
}

test('CLI exits 0 and prints the accepted value on the happy path', () => {
  const run = runGate({ CENSUS_TIMEOUT: '50m', CENSUS_JOB_TIMEOUT_MINUTES: '60' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /census timeout: 50m \(3000s\), within the 3300s/);
});

test('CLI exits 1 and annotates on a rejected value', () => {
  const run = runGate({ CENSUS_TIMEOUT: '0', CENSUS_JOB_TIMEOUT_MINUTES: '60' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^::error::/m);
  assert.match(run.stderr, /NO limit/);
});

test('CLI refuses an absent CENSUS_TIMEOUT rather than reading it as empty', () => {
  const run = runGate({ CENSUS_JOB_TIMEOUT_MINUTES: '60' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /CENSUS_TIMEOUT is not set/);
});

test('CLI refuses an absent CENSUS_JOB_TIMEOUT_MINUTES', () => {
  const run = runGate({ CENSUS_TIMEOUT: '50m' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /CENSUS_JOB_TIMEOUT_MINUTES is not set/);
});

test('CLI refuses a non-integer CENSUS_JOB_TIMEOUT_MINUTES', () => {
  const run = runGate({ CENSUS_TIMEOUT: '50m', CENSUS_JOB_TIMEOUT_MINUTES: '60m' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /not a whole number of minutes/);
});

/**
 * The gate run the way the census step runs it: no path argument, and the two
 * values the workflow's own `env:` block carries. Those two literals ARE the
 * workflow's. Both are READ OUT of the workflow rather than restated here: a
 * literal would make a correct paired change (raising `timeout-minutes` and the
 * env default together, which is exactly what the gate demands) fail with the
 * gate's own stale-copy message, pointing the maintainer at the workflow when
 * the stale copy was this line. This assertion reaches the real
 * `.github/workflows/geometry-census-heavy.yml` and runs on every PR through the
 * `scripts/*.test.mjs` glob rather than on Monday.
 */
test('the census default validates against the real workflow, with no path argument', () => {
  const run = runGate({ CENSUS_TIMEOUT: '50m', CENSUS_JOB_TIMEOUT_MINUTES: '60' }, []);
  assert.equal(
    run.status,
    0,
    `${run.stderr}\n\nIf you have just changed timeout-minutes or CENSUS_TIMEOUT in ` +
      `${CENSUS_WORKFLOW}, THIS LINE is the third place to change and the stale copy ` +
      `the message above is about. Update the literals here to match the workflow. ` +
      `Deriving them by reading the workflow was tried and rejected: it makes this ` +
      `file read a source file, which check-source-text-assertions.mjs flags for the ` +
      `whole file, and the allowlist it offers only ratchets down.`,
  );
  assert.match(run.stdout, /^census timeout: 50m \(3000s\), within the \d+s /m);
});

// The two reject GROUPS have an order, and nothing pinned it. Moving the file read
// ahead of the duration checks leaves the suite green while changing this verdict
// from `malformed` to `unreadable`, so the reason a caller is given for a bad
// interval would depend on whether an unrelated file happened to be readable.
test('a malformed duration is reported before the workflow file is even read', () => {
  const r = checkCensusTimeout({
    timeout: '-5m',
    jobMinutes: '60',
    workflowPath: join(tmpdir(), 'definitely-not-a-workflow-4156.yml'),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'malformed');
});

test('the default workflow path is the census lane', () => {
  assert.equal(CENSUS_WORKFLOW, '.github/workflows/geometry-census-heavy.yml');
});
