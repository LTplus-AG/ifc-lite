/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Regression harness for the pure half of the #3312 gate.
 *
 * The organising principle: every route to "nothing to report" must be a named
 * failure, so the tests below are mostly assertions that a DEGRADED input
 * throws rather than returning an empty answer. A gate built to catch vacuous
 * gates that could itself return a clean verdict over an unread rollup would be
 * the joke telling itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ReviewSignalError,
  expandJobNames,
  missingLanes,
  noVerdictReviews,
  parseWorkflowJobs,
  rollupSettled,
} from './pr-review-signal.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '../..');

const CFG = JSON.parse(readFileSync(join(HERE, '../pr-review-signal.config.json'), 'utf8'));

/** Minimal workflow with one plain job, one matrix job and one unnamed job. */
const WF = `name: X
on:
  pull_request:
jobs:
  changes:
    name: Detect changes
    runs-on: ubuntu-latest
    steps:
      - run: true
  viewer-tests:
    name: Viewer tests (shard \${{ matrix.shard }})
    runs-on: ubuntu-latest
    strategy:
      matrix:
        shard: [0, 1, 2, 3]
    steps:
      - run: true
  unnamed-job:
    runs-on: ubuntu-latest
    steps:
      - run: true
`;

// ---------------------------------------------------------------- derivation

test('job names expand: plain, matrix-sharded, and key-as-name', () => {
  assert.deepEqual(expandJobNames(WF), [
    'Detect changes',
    'Viewer tests (shard 0)',
    'Viewer tests (shard 1)',
    'Viewer tests (shard 2)',
    'Viewer tests (shard 3)',
    'unnamed-job',
  ]);
});

test('the REAL test.yml derives the lane names the REAL rollup publishes', () => {
  // Not a synthetic tree: the point of this gate is that its expectation
  // matches what GitHub actually publishes, and a fixture cannot show that.
  // These 16 are the names observed on PR #3305's rollup on 2026-08-26.
  const names = expandJobNames(readFileSync(join(REPO_ROOT, '.github/workflows/test.yml'), 'utf8'));
  for (const observed of [
    'Detect changes',
    'Build packages + WASM',
    'Typecheck',
    'Lint',
    'Node tests',
    'Rust tests',
    'Rust crate semver',
    'Viewer E2E smoke',
    'Viewer tests (shard 0)',
    'Viewer tests (shard 3)',
    'Docs checks (docs-only PRs)',
    'Build + WASM + Rust + Node',
  ]) {
    assert.ok(names.includes(observed), `derived set is missing the observed lane "${observed}"`);
  }
  assert.equal(names.length, 16);
});

test('FAIL CLOSED: an empty workflow file is NO_WORKFLOW_TEXT, not an empty lane set', () => {
  assert.throws(() => expandJobNames(''), (e) => e instanceof ReviewSignalError && e.reason === 'NO_WORKFLOW_TEXT');
});

test('FAIL CLOSED: a workflow with no `jobs:` block is NO_WORKFLOW_JOBS', () => {
  assert.throws(
    () => expandJobNames('name: X\non:\n  push:\n'),
    (e) => e.reason === 'NO_WORKFLOW_JOBS',
  );
});

test('FAIL CLOSED: a name whose matrix key has no inline list is UNRESOLVED_JOB_NAME', () => {
  const wf = WF.replace(
    '        shard: [0, 1, 2, 3]\n',
    `        shard: \${{ fromJSON(needs.x.outputs.s) }}\n`,
  );
  assert.throws(() => expandJobNames(wf), (e) => e.reason === 'UNRESOLVED_JOB_NAME');
});

test('FAIL CLOSED: a name carrying any other Actions expression is UNRESOLVED_JOB_NAME', () => {
  const wf = WF.replace('name: Detect changes', `name: Detect \${{ github.event_name }}`);
  assert.throws(() => expandJobNames(wf), (e) => e.reason === 'UNRESOLVED_JOB_NAME');
});

test('FAIL CLOSED: excluding every job is EMPTY_REQUIRED_SET, never a vacuous pass', () => {
  assert.throws(
    () => expandJobNames(WF, { exclude: ['changes', 'viewer-tests', 'unnamed-job'] }),
    (e) => e.reason === 'EMPTY_REQUIRED_SET',
  );
});

test('a `#` comment line at job indent is not mistaken for a job', () => {
  const jobs = parseWorkflowJobs(`jobs:\n  # note: not a job\n  real:\n    runs-on: x\n`);
  assert.deepEqual(jobs.map((j) => j.key), ['real']);
});

// ------------------------------------------------------------ lane presence

const LANE = (name, state = 'success') => ({ name, state });

test('every required lane present -> nothing missing', () => {
  assert.deepEqual(missingLanes(['A', 'B'], [LANE('A'), LANE('B'), LANE('Vercel')]), []);
});

test('presence counts a SKIPPED lane: a path-filtered job still published a check', () => {
  assert.deepEqual(missingLanes(['A'], [LANE('A', 'skipped')]), []);
});

test('presence counts a QUEUED lane: the workflow fired, which is the question', () => {
  assert.deepEqual(missingLanes(['A'], [LANE('A', 'queued')]), []);
});

test('the #3294 shape: only deploy/review lanes present -> every compile lane named missing', () => {
  const rollup = [
    LANE('Vercel – ifc-lite'),
    LANE('Vercel – ifc-lite-dev'),
    LANE('Vercel – ifc-lite-viewer-embed'),
    LANE('Vercel Agent Review', 'neutral'),
    LANE('Vercel Preview Comments'),
    LANE('CodeRabbit'),
    LANE('parity (in-tree fixtures, committed reference)'),
  ];
  const missing = missingLanes(['Typecheck', 'Node tests', 'Rust tests'], rollup);
  assert.deepEqual(missing, ['Node tests', 'Rust tests', 'Typecheck']);
});

test('FAIL CLOSED: an empty rollup is NO_ROLLUP, never "nothing to check"', () => {
  assert.throws(() => missingLanes(['A'], []), (e) => e.reason === 'NO_ROLLUP');
  assert.throws(() => missingLanes(['A'], null), (e) => e.reason === 'NO_ROLLUP');
});

// --------------------------------------------------------------- settle rule

test('a rollup with anything still moving is NOT settled — absence proves nothing yet', () => {
  assert.equal(rollupSettled([LANE('A', 'success'), LANE('B', 'in_progress')]), false);
  assert.equal(rollupSettled([LANE('A', 'success'), LANE('B', '')]), false);
});

test('a rollup where every lane is terminal IS settled — a missing name is missing for good', () => {
  assert.equal(rollupSettled([LANE('A', 'success'), LANE('B', 'skipped'), LANE('C', 'failure')]), true);
  assert.equal(rollupSettled([LANE('A', 'cancelled'), LANE('B', 'neutral')]), true);
});

test('an empty rollup is never settled, so the poll keeps waiting rather than failing on a race', () => {
  assert.equal(rollupSettled([]), false);
});

// ------------------------------------------------------------- no-verdict

test('VERBATIM #3305: CodeRabbit success + "Review rate limited" is a finding', () => {
  const f = noVerdictReviews(
    [{ name: 'CodeRabbit', state: 'success', description: 'Review rate limited' }],
    CFG,
  );
  assert.equal(f.length, 1);
  assert.equal(f[0].reason, 'NO_VERDICT');
  assert.match(f[0].means, /quota/);
});

test('VERBATIM #3294: "Review skipped: reviews are disabled for this base branch" is a finding', () => {
  const f = noVerdictReviews(
    [
      {
        name: 'CodeRabbit',
        state: 'success',
        description: 'Review skipped: reviews are disabled for this base branch',
      },
    ],
    CFG,
  );
  assert.equal(f.length, 1);
});

test('a real review is left alone', () => {
  assert.deepEqual(
    noVerdictReviews([{ name: 'CodeRabbit', state: 'success', description: 'Review completed' }], CFG),
    [],
  );
});

test('NEUTRAL is not a finding: it already communicates "no verdict"', () => {
  // `Cursor Bugbot :: Error` at neutral, and `Vercel Agent Review :: Review
  // skipped` at neutral, are both honest. Only `success` claims otherwise.
  assert.deepEqual(
    noVerdictReviews(
      [
        { name: 'Cursor Bugbot', state: 'neutral', description: 'Error' },
        { name: 'Vercel Agent Review', state: 'neutral', description: 'Review skipped' },
      ],
      CFG,
    ),
    [],
  );
});

test('a non-reviewer context is never adjudicated, however its description reads', () => {
  // `Canceled by Ignored Build Step` is a true statement about a deploy. This
  // gate has no business turning that into a claim about the code.
  assert.deepEqual(
    noVerdictReviews(
      [{ name: 'Vercel – ifc-lite', state: 'success', description: 'Canceled by Ignored Build Step' }],
      CFG,
    ),
    [],
  );
});

test('FAIL CLOSED: a reviewer passing with NO description is UNREADABLE_DESCRIPTION', () => {
  for (const description of [null, '', '   ', undefined]) {
    const f = noVerdictReviews([{ name: 'CodeRabbit', state: 'success', description }], CFG);
    assert.equal(f.length, 1, `description ${JSON.stringify(description)} must be a finding`);
    assert.equal(f[0].reason, 'UNREADABLE_DESCRIPTION');
  }
});

test('matching is a PREFIX, not a substring: a real review quoting a phrase is not a finding', () => {
  // Substring matching over vendor free text is how a phrase list starts
  // catching things it was never aimed at.
  assert.deepEqual(
    noVerdictReviews(
      [
        {
          name: 'CodeRabbit',
          state: 'success',
          description: 'Review completed — note: Review rate limited earlier',
        },
      ],
      CFG,
    ),
    [],
  );
});

test('matching is case-insensitive', () => {
  assert.equal(
    noVerdictReviews([{ name: 'CodeRabbit', state: 'success', description: 'REVIEW RATE LIMITED' }], CFG)
      .length,
    1,
  );
});

test('the shipped config lists a reviewer and a phrase for every observed instance', () => {
  assert.ok(CFG.reviewers.includes('CodeRabbit'));
  const prefixes = CFG.phrases.map((p) => p.startsWith);
  assert.ok(prefixes.includes('Review rate limited'));
  assert.ok(prefixes.includes('Review skipped'));
  for (const p of CFG.phrases) assert.ok(p.means && p.means.length > 10, `${p.startsWith} needs a \`means\``);
});
