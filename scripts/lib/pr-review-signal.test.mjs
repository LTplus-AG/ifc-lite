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
  pollForLanes,
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

// ------------------------------------------------------- the poll loop itself
//
// This is the branch that had NO coverage while it was inline in `main()`:
// `--state-file` mode hardcodes `timedOut: false` and jumps straight to
// `evaluate`, so the process harness drove the verdict and never the wait. The
// wait is where the 420 s budget defect lived, so the untested branch was the
// broken one. Clock, sleep and re-read are all injected, so the timeout path
// below runs in microseconds rather than in fifteen real minutes.

const POLL_REQUIRED = ['Typecheck', 'Lint', 'Node tests'];
const POLL_MOVING = [{ name: 'Typecheck', state: 'in_progress' }];
const POLL_COMPLETE = POLL_REQUIRED.map((n) => ({ name: n, state: 'success' }));

/**
 * A scripted poll over a fake clock.
 *
 * `readsAt(ms)` returns the rollup as of that many ms into the run, so a test
 * says WHEN the lanes appear and the loop discovers it by polling, exactly as
 * it does against the real API.
 */
function driver(readsAt, { pollMs = 15_000 } = {}) {
  let clock = 0;
  const slept = [];
  const logs = [];
  const state = () => ({ sha: 'deadbeef', lanes: readsAt(clock) });
  return {
    state,
    now: () => clock,
    sleep: (ms) => {
      slept.push(ms);
      clock += pollMs;
    },
    log: (l) => logs.push(l),
    slept,
    logs,
  };
}

/** Lanes that are `in_progress` until `atMs`, complete from then on. */
const completesAt = (atMs) => (clock) => (clock >= atMs ? POLL_COMPLETE : POLL_MOVING);

function poll(d, { deadline = 900_000, pollSeconds = 15 } = {}) {
  return pollForLanes({
    required: POLL_REQUIRED,
    initialState: d.state(),
    fetchState: d.state,
    deadline,
    pollSeconds,
    now: d.now,
    sleep: d.sleep,
    log: d.log,
  });
}

test('the poll RETURNS as soon as every required lane has appeared, without sleeping', () => {
  const d = driver(completesAt(0));
  const r = poll(d);
  assert.equal(r.timedOut, false);
  assert.deepEqual(d.slept, [], 'a complete rollup must not cost a single poll interval');
});

test('the poll KEEPS WAITING while lanes are still appearing, then succeeds', () => {
  // Complete at t=30 s, polling every 15 s: exactly the `opened` spawn race.
  const d = driver(completesAt(30_000));
  const r = poll(d);
  assert.equal(r.timedOut, false);
  assert.deepEqual(r.state.lanes, POLL_COMPLETE);
  assert.deepEqual(d.slept, [15_000, 15_000], 'it must actually have waited, at --poll-seconds');
  assert.match(d.logs[0], /2\/3 required lane\(s\) not yet published/);
  assert.match(d.logs[0], /s of budget left/);
});

test('the poll STOPS EARLY once the rollup has settled — #3294 must not burn the budget', () => {
  const settled = [{ name: 'CodeRabbit', state: 'success' }];
  const d = driver(() => settled);
  const r = poll(d);
  assert.equal(r.timedOut, false, 'settled is an ANSWER, not a timeout');
  assert.deepEqual(d.slept, [], 'a settled rollup is decided on the first read');
});

test('THE TIMEOUT PATH: a rollup that never settles and never completes returns timedOut', () => {
  // Never settles (always `in_progress`) and never completes, so only the
  // deadline can stop it. 900 s of budget at 15 s a poll is 60 sleeps.
  const d = driver(() => POLL_MOVING);
  const r = poll(d);
  assert.equal(r.timedOut, true, 'the budget ran out; that is not a pass');
  assert.equal(d.slept.length, 60, '900 s of budget at 15 s a poll');
});

test('THE TIMEOUT PATH: a deadline already in the past times out on the FIRST read', () => {
  // The deadline must be checked BEFORE sleeping, or an expired budget still
  // buys one more interval and a zero budget never terminates at all.
  const d = driver(() => POLL_MOVING);
  const r = poll(d, { deadline: -1 });
  assert.equal(r.timedOut, true);
  assert.deepEqual(d.slept, [], 'an expired budget must not buy another poll');
});

test('the poll treats an EMPTY rollup as "nothing has appeared yet", never as settled', () => {
  // NO_ROLLUP out of `missingLanes` must not escape the loop as a crash, and an
  // empty rollup is never settled — so this is the pure race. It times out
  // rather than reporting a clean verdict over a rollup it could not read.
  const d = driver(() => []);
  const r = poll(d, { deadline: 30_000 });
  assert.equal(r.timedOut, true);
  assert.match(d.logs[0], /3\/3 required lane\(s\) not yet published/);
});

test('MEASURED: 900 s covers every observed lane pickup and 420 s did not', () => {
  // `Detect changes` start to LAST NON-AGGREGATE lane start, over the twelve
  // most recent non-cancelled test.yml PR runs (2026-08-25/26), in seconds.
  // The aggregate itself was 670..1312 s behind `Detect changes`, which is why
  // `excludeJobKeys` drops it; THESE are what the budget must actually cover.
  // Pinned because the shipped budget is a claim about these numbers and
  // nothing else re-checks it.
  const OBSERVED_PICKUP_SECONDS = [159, 159, 168, 213, 238, 245, 252, 315, 336, 343, 535, 678];

  for (const s of OBSERVED_PICKUP_SECONDS) {
    const d = driver(completesAt(s * 1000));
    assert.equal(poll(d, { deadline: 900_000 }).timedOut, false, `${s}s pickup must fit in 900s`);
  }

  // The regression itself, kept as an assertion rather than as prose: under the
  // old 420 s budget two of those twelve runs time out over a green PR.
  const falseFailures = OBSERVED_PICKUP_SECONDS.filter(
    (s) => poll(driver(completesAt(s * 1000)), { deadline: 420_000 }).timedOut,
  );
  assert.deepEqual(falseFailures, [535, 678], '420 s false-failed exactly these two');
});
