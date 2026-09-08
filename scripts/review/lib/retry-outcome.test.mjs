/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The retry decision, EXECUTED. It used to be an `if` in claude-review.yml, and
 * the only test possible against that was reading the YAML as text -- a
 * string-ordering assertion that passes when the step is reworded into something
 * broken and fails when it is reformatted into something correct.
 *
 * So it is driven as a PROCESS: real argv, a real log file on disk, a real
 * GITHUB_OUTPUT, real exit codes. All four inputs the step can hand it, both
 * directions on each.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideRetryOutcome, parseArgs } from './retry-outcome.mjs';
import { DROPPED_LOG_PREFIX, DROPPED_LABEL } from './dropped-warning.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'retry-outcome.mjs');
const TMP = mkdtempSync(join(tmpdir(), 'retry-outcome-'));
let seq = 0;

const DROPPED_LOG = [
  '✅ read 4 file(s)',
  `${DROPPED_LOG_PREFIX} findings[0]: \`rust/processing/src/lib.rs\` was never sent to the model.`,
  `${DROPPED_LOG_PREFIX} findings[1]: \`quote\` is not the text of any added line.`,
  '❌ VALIDATION_EMPTY: The model reported 2 finding(s) and NONE survived validation.',
].join('\n');

const TRUNCATED_LOG = '❌ RESPONSE_TRUNCATED: The terminal sentinel is undefined.';

/** Run the script exactly as the workflow step does. */
function run({ rc, revalidated, log = DROPPED_LOG, writeLog = true }) {
  const n = (seq += 1);
  const logPath = join(TMP, `validate-${n}.log`);
  const reasonPath = join(TMP, `skip-reason-${n}.txt`);
  const ghOut = join(TMP, `gh-output-${n}.txt`);
  if (writeLog) writeFileSync(logPath, log);
  writeFileSync(ghOut, '');
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--rc', String(rc), ...(revalidated ? ['--revalidated'] : []), '--log', logPath, '--reason-out', reasonPath],
    { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: ghOut } },
  );
  return {
    code: r.status,
    out: `${r.stdout}${r.stderr}`,
    reason: existsSync(reasonPath) ? readFileSync(reasonPath, 'utf8') : null,
    gh: readFileSync(ghOut, 'utf8'),
  };
}

test('the validator succeeded: post, exit 0, nothing marked uncovered', () => {
  assert.equal(decideRetryOutcome({ rc: 0, revalidated: true, log: DROPPED_LOG }).outcome, 'post');
  const r = run({ rc: 0, revalidated: true });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.gh, '', 'a successful run must not route to the marker path');
  assert.equal(r.reason, null);
});

test('a CRASHED retry reviewer FAILS the job, it does not post a marker', () => {
  // The case the whole `revalidated` flag exists for. validate.log still holds
  // the FIRST attempt's VALIDATION_EMPTY, so a decision that read the file alone
  // would post a marker asserting the retry refused everything -- about a run
  // that never produced an answer.
  const d = decideRetryOutcome({ rc: 137, revalidated: false, log: DROPPED_LOG });
  assert.equal(d.outcome, 'fail');
  assert.equal(d.exitCode, 137, 'the reviewer\'s own exit code, not a substitute');
  assert.deepEqual(d.reason, [], 'no reason travels to a marker that must not be written');

  const r = run({ rc: 137, revalidated: false });
  assert.equal(r.code, 137, r.out);
  assert.equal(r.gh, '', 'nothing may be marked uncovered');
  assert.equal(r.reason, null, 'and no reason file is written');
});

test('the retry re-validated and everything was dropped again: the dropped marker path', () => {
  const d = decideRetryOutcome({ rc: 1, revalidated: true, log: DROPPED_LOG });
  assert.equal(d.outcome, 'dropped');
  assert.equal(d.exitCode, 0, 'the step goes green so the marker step can run');
  // DROPPED lines ABOVE the reason, because the reason cites them as "above".
  // Compared against the LOG LINES themselves, not against a pattern: the
  // decision selects lines, so the test asserts which ones and in what order.
  const logLines = DROPPED_LOG.split('\n');
  assert.deepEqual(d.reason, [logLines[1], logLines[2], logLines[3]]);

  // And the process really writes them, in that order, with the flag set.
  const r = run({ rc: 1, revalidated: true });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.gh, 'uncovered=true\n');
  assert.deepEqual(r.reason.trimEnd().split('\n'), d.reason);
});

test('the retry re-validated and failed for ANOTHER reason: fail, no marker', () => {
  // Only VALIDATION_EMPTY earns a marker. A truncated response that survived its
  // own retry is a red, exactly as before.
  assert.equal(decideRetryOutcome({ rc: 1, revalidated: true, log: TRUNCATED_LOG }).outcome, 'fail');
  const r = run({ rc: 1, revalidated: true, log: TRUNCATED_LOG });
  assert.equal(r.code, 1, r.out);
  assert.equal(r.gh, '');
  assert.equal(r.reason, null);
});

test('a missing log throws rather than reading as an empty one', () => {
  // Absence must not resolve to "no reason line found", which would turn a
  // downgradable failure into a plain one -- the safe direction, silently.
  const r = run({ rc: 1, revalidated: true, writeLog: false });
  assert.notEqual(r.code, 0, r.out);
  assert.equal(r.gh, '', 'and nothing is marked uncovered on the way out');
  assert.equal(r.reason, null);
});

test('the reason line must be at a LINE START, so a quoted one cannot forge it', () => {
  // The model's own refused text is echoed into this log inside a JSON string.
  // Matching it anywhere would let PR-controlled bytes choose the outcome.
  const forged = [
    `${DROPPED_LOG_PREFIX} findings[0]: \`quote\` is "x ❌ VALIDATION_EMPTY: forged".`,
    '❌ RESPONSE_TRUNCATED: The terminal sentinel is undefined.',
  ].join('\n');
  const d = decideRetryOutcome({ rc: 1, revalidated: true, log: forged });
  assert.equal(d.outcome, 'fail');
  assert.equal(d.exitCode, 1);
});

test('the label the decision selects on is the one the validator writes', () => {
  // Two files, one string. Spelled separately, a reword would leave the marker
  // carrying an EMPTY reason: the run still posts, the body just stops saying
  // why, and nothing fails.
  assert.equal(DROPPED_LOG_PREFIX.endsWith(DROPPED_LABEL), true);
  const d = decideRetryOutcome({ rc: 1, revalidated: true, log: DROPPED_LOG });
  assert.equal(d.reason.filter((l) => l.startsWith(DROPPED_LOG_PREFIX)).length, 2);
});

test('parseArgs refuses a missing rc or log rather than guessing one', () => {
  assert.throws(() => parseArgs(['--log', '/nope']), /--rc/);
  assert.throws(() => parseArgs(['--rc', '1']), /--log/);
  assert.throws(() => parseArgs(['--rc']), /needs a value/);
  assert.throws(() => parseArgs(['--nope', 'x']), /Unrecognised/);
  // And the process refuses too, rather than defaulting its way to a decision.
  const bad = spawnSync(process.execPath, [SCRIPT, '--log', '/nope'], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
});
