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
  SETTLE_HOLD_SECONDS,
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
function driver(readsAt, { pollMs = 15_000, startMs = 0 } = {}) {
  let clock = startMs;
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

function poll(d, { deadline = 900_000, pollSeconds = 15, required, settleHoldSeconds } = {}) {
  return pollForLanes({
    required: required ?? POLL_REQUIRED,
    initialState: d.state(),
    fetchState: d.state,
    deadline,
    pollSeconds,
    settleHoldSeconds,
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
  // It costs the HOLD and not one interval more. The first read cannot decide
  // this — see the fan-out replay below — but 60 s out of a 900 s budget still
  // leaves #3294's total-absence shape decided in seconds, not in fifteen
  // minutes, which is the property this test was written for.
  assert.deepEqual(d.slept, [15_000, 15_000, 15_000, 15_000], 'exactly SETTLE_HOLD_SECONDS');
  assert.equal(d.slept.length * 15, SETTLE_HOLD_SECONDS, 'the hold is what bounds the cost');
  assert.match(d.logs[0], /confirming across 60s before calling that absence final/);
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

test('MEASURED: 900 s covers every observed lane APPEARANCE, and 420 s did not', () => {
  // THE METHODOLOGY HERE WAS WRONG ONCE, AND THE NUMBERS MOVED WHEN IT WAS
  // FIXED. The first version of this constant measured `started_at` — when a
  // runner picked the job up. The gate does not wait for that. It polls for
  // PRESENCE in the rollup, which is `created_at`, and the two diverge hard:
  // on run 32930088375 `Lint` was created at 416 s and started at 1037 s.
  // Measured from each run's own `created_at` over the 68 completed `test.yml`
  // PR runs of 2026-08-25/26 that published the aggregate, here is when the
  // LAST NON-AGGREGATE lane appeared, in seconds:
  const LANE_APPEARED_SECONDS = [
    161, 162, 162, 162, 163, 164, 164, 165, 165, 165, 166, 166, 167, 167, 167, 167, 167, 169, 169,
    170, 170, 170, 170, 171, 171, 171, 172, 172, 175, 176, 177, 187, 188, 189, 190, 193, 198, 204,
    210, 221, 235, 237, 237, 241, 244, 276, 289, 290, 290, 297, 299, 310, 322, 334, 349, 362, 386,
    388, 403, 416, 423, 426, 450, 451, 522, 523, 542, 845,
  ];
  assert.equal(LANE_APPEARED_SECONDS.length, 68);

  for (const s of LANE_APPEARED_SECONDS) {
    const d = driver(completesAt(s * 1000));
    assert.equal(poll(d, { deadline: 900_000 }).timedOut, false, `${s}s must fit in 900 s`);
  }
  assert.equal(
    LANE_APPEARED_SECONDS.filter((s) => s > 900).length,
    0,
    '900 s holds: 0 of 68 runs breach it',
  );

  // THE TRUE TAIL MARGIN IS 1.07x, NOT THE 1.33x THIS FILE ONCE CLAIMED. That
  // figure came from the `started_at` numbers; against the max this budget
  // actually has to cover it is 900/845. Measuring from RUN CREATION is the
  // conservative direction — the gate's own deadline starts later still, after
  // its runner pickup and checkout — but a margin this thin is a fact worth
  // stating rather than rounding up.
  const max = Math.max(...LANE_APPEARED_SECONDS);
  assert.equal(max, 845);
  assert.equal(Number((900 / max).toFixed(2)), 1.07, 'tail margin, stated honestly');

  // AND THE AGGREGATE EXCLUSION IS MORE LOAD-BEARING THAN 420-vs-900 EVER WAS.
  // Same 68 runs, when `Build + WASM + Rust + Node` itself appeared: min 509,
  // median 894, max 2067 s. Requiring it would false-fail 33 of the 68 at a
  // 900 s budget — half of every green PR — which is why `excludeJobKeys`
  // carries the fix and the budget merely finishes it.
  const AGGREGATE_APPEARED_SECONDS = [
    509, 524, 528, 563, 579, 629, 667, 669, 669, 675, 697, 701, 702, 716, 721, 740, 743, 746, 750,
    756, 765, 773, 773, 776, 790, 800, 806, 809, 823, 853, 863, 865, 868, 887, 894, 926, 944, 964,
    970, 973, 983, 1006, 1006, 1020, 1105, 1109, 1132, 1175, 1177, 1226, 1230, 1246, 1261, 1272,
    1276, 1335, 1387, 1420, 1441, 1461, 1519, 1554, 1601, 1897, 1950, 1987, 2022, 2067,
  ];
  assert.equal(AGGREGATE_APPEARED_SECONDS.length, 68);
  assert.equal(
    AGGREGATE_APPEARED_SECONDS.filter((s) => s > 900).length,
    33,
    'keeping the aggregate in the required set would false-fail 33 of 68 green runs',
  );

  // The original regression, kept as an assertion rather than as prose: under
  // the first 420 s budget, eight of these 68 runs time out over a green PR.
  const falseFailures = LANE_APPEARED_SECONDS.filter(
    (s) => poll(driver(completesAt(s * 1000)), { deadline: 420_000 }).timedOut,
  );
  assert.deepEqual(falseFailures, [423, 426, 450, 451, 522, 523, 542, 845], '420 s false-failed 8');
});

// ------------------------------------- THE FAN-OUT RACE, REPLAYED FROM A RUN
//
// `rollupSettled` alone answers "has everything published so far finished",
// which is NOT the same question as "will anything else publish". A downstream
// job's check run is created only once its `needs` complete, so at every fan-out
// boundary there is an instant where every published lane is terminal and the
// next wave has not been created yet. The un-held rule reads that instant as
// proof of absence.
//
// Below is `test.yml` run 32930088375 (branch fix/schema-detect-file-schema-3278,
// conclusion SUCCESS), verbatim from
// `repos/LTplus-AG/ifc-lite/actions/runs/32930088375/jobs`, as offsets in
// seconds from the run's own `created_at` (2026-08-26T04:24:15Z). `created` is
// the field that decides PRESENCE — the thing this gate polls for. Skipped jobs
// really do report `completed_at` one second BEFORE `created_at`; that is
// GitHub's data, left exactly as measured.
const RUN_32930088375 = [
  { name: 'Detect changes', created: 159, completed: 266, conclusion: 'success' },
  { name: 'Build packages + WASM', created: 267, completed: 415, conclusion: 'success' },
  { name: 'Plato clash-math freshness', created: 267, completed: 266, conclusion: 'skipped' },
  { name: 'Geometry watertightness census', created: 267, completed: 266, conclusion: 'skipped' },
  { name: 'Rust tests', created: 267, completed: 266, conclusion: 'skipped' },
  { name: 'Docs checks (docs-only PRs)', created: 267, completed: 266, conclusion: 'skipped' },
  { name: 'Viewer E2E smoke', created: 416, completed: 863, conclusion: 'success' },
  { name: 'Node tests', created: 416, completed: 1278, conclusion: 'success' },
  { name: 'Lint', created: 416, completed: 1269, conclusion: 'success' },
  { name: 'Viewer tests (shard 2)', created: 416, completed: 966, conclusion: 'success' },
  { name: 'Viewer tests (shard 1)', created: 416, completed: 1338, conclusion: 'success' },
  { name: 'Viewer tests (shard 0)', created: 416, completed: 1386, conclusion: 'success' },
  { name: 'Viewer tests (shard 3)', created: 416, completed: 1022, conclusion: 'success' },
  { name: 'Typecheck', created: 416, completed: 1208, conclusion: 'success' },
  // The aggregate, dropped from the required set by `excludeJobKeys` and so
  // absent from REPLAY_REQUIRED — kept here because it is part of the rollup.
  { name: 'Build + WASM + Rust + Node', created: 1387, completed: 1396, conclusion: 'success' },
];

/** The 14 lanes the shipped config actually requires from that run. */
const REPLAY_REQUIRED = RUN_32930088375.filter((j) => j.name !== 'Build + WASM + Rust + Node')
  .map((j) => j.name)
  .sort();

/** That run's rollup exactly as the API would have returned it at time `ms`. */
const replayAt = (ms) => {
  const t = ms / 1000;
  return RUN_32930088375.filter((j) => j.created <= t).map((j) => ({
    name: j.name,
    state: j.completed <= t ? j.conclusion : 'in_progress',
  }));
};

// Every second of that run replayed against the un-held rule: t=266 and t=415
// are the two instants at which it would have declared lanes permanently
// absent. (t=1386 is a third such instant in the raw rollup, harmless only
// because by then every REQUIRED lane has appeared and the loop has returned.)
const FALSE_SETTLE_SECONDS = [266, 415];

test('RED: the un-held settle rule calls a GREEN run permanently missing 13 of 14 lanes', () => {
  // Not a paraphrase of the old rule — this IS it: `rollupSettled` true while
  // required names are still absent was the entire stopping condition.
  const at266 = replayAt(266_000);
  assert.equal(rollupSettled(at266), true, 'every published lane is terminal at t=266 s');
  assert.deepEqual(
    at266.map((l) => l.name),
    ['Detect changes'],
    'and exactly one lane has been published',
  );
  assert.equal(missingLanes(REPLAY_REQUIRED, at266).length, 13, '13 of 14 still to come');

  // Driven through the loop with the hold disabled, that is the shipped verdict
  // — on a run whose own conclusion was `success`, with the wrong remedy
  // ("rebase onto main") printed underneath it.
  const d = driver((c) => replayAt(c), { startMs: 266_000 });
  const r = poll(d, {
    required: REPLAY_REQUIRED,
    deadline: 266_000 + 900_000,
    settleHoldSeconds: 0,
  });
  assert.equal(r.timedOut, false, 'it does not time out — it answers, wrongly');
  assert.equal(missingLanes(REPLAY_REQUIRED, r.state.lanes).length, 13);
});

test('GREEN: holding the settle verdict gets run 32930088375 right at every fan-out edge', () => {
  for (const t of FALSE_SETTLE_SECONDS) {
    const d = driver((c) => replayAt(c), { startMs: t * 1000 });
    const r = poll(d, { required: REPLAY_REQUIRED, deadline: t * 1000 + 900_000 });
    assert.equal(r.timedOut, false, `t=${t} s must not time out`);
    assert.deepEqual(
      missingLanes(REPLAY_REQUIRED, r.state.lanes),
      [],
      `t=${t} s: every required lane appeared; the absence was the fan-out gap, not a fact`,
    );
  }
});

test('and it is right at EVERY second of that run, not just at the two known edges', () => {
  // The sweep the fix was derived from, kept as an assertion. Starting the poll
  // at any second of the run must reach "all lanes present"; `settleHoldSeconds:
  // 0` is the mutation, and it must produce the wrong answer on exactly the
  // start seconds whose 15 s polling schedule LANDS on one of those 1 s windows.
  //
  // Note how much bigger that set is than the windows themselves. The window is
  // 1 s wide, but every start phase congruent to it mod `--poll-seconds` hits
  // it, so a run with two windows exposes roughly 2 in 15 start phases — which
  // is why "the window is only a second wide" was never a defence.
  const expectedWrong = [];
  for (let t = 0; t <= 500; t += 1) {
    if (FALSE_SETTLE_SECONDS.some((w) => t <= w && (w - t) % 15 === 0)) expectedWrong.push(t);
  }

  const wrongUnderShippedRule = [];
  for (let t = 0; t <= 500; t += 1) {
    const held = poll(driver((c) => replayAt(c), { startMs: t * 1000 }), {
      required: REPLAY_REQUIRED,
      deadline: t * 1000 + 900_000,
    });
    assert.deepEqual(missingLanes(REPLAY_REQUIRED, held.state.lanes), [], `held rule at t=${t} s`);

    const unheld = poll(driver((c) => replayAt(c), { startMs: t * 1000 }), {
      required: REPLAY_REQUIRED,
      deadline: t * 1000 + 900_000,
      settleHoldSeconds: 0,
    });
    if (missingLanes(REPLAY_REQUIRED, unheld.state.lanes).length > 0) wrongUnderShippedRule.push(t);
  }
  assert.deepEqual(wrongUnderShippedRule, expectedWrong, 'the mutation fires, and only here');
  assert.equal(wrongUnderShippedRule.length, 46, '46 of 501 start seconds, not 2');
});

test('a wave that arrives ALREADY TERMINAL restarts the hold rather than extending it', () => {
  // The hold is on an UNCHANGED settled rollup, not on wall-clock time since
  // the first settled read, and the difference is load-bearing. A fan-out wave
  // made entirely of skipped jobs (a docs-only PR does exactly this) lands
  // terminal, so the rollup goes settled -> settled with the previous hold
  // still part-elapsed. Counting that as continuous would let the verdict fire
  // on a rollup that had just visibly moved.
  const waves = (clock) =>
    clock < 45_000
      ? [{ name: 'Typecheck', state: 'success' }]
      : clock < 90_000
        ? [
            { name: 'Typecheck', state: 'success' },
            { name: 'Lint', state: 'skipped' },
          ]
        : POLL_COMPLETE;

  const r = poll(driver(waves), { deadline: 900_000 });
  assert.equal(r.timedOut, false);
  assert.deepEqual(
    missingLanes(POLL_REQUIRED, r.state.lanes),
    [],
    'the second wave restarts the hold, so the poll is still there when the third arrives',
  );
});

test('a rollup that starts MOVING again drops the hold, even if it lands back where it was', () => {
  // The other half of the same rule. A lane that is re-run goes terminal ->
  // in_progress -> terminal, and can land on the identical conclusion, so the
  // signature check alone would see two settled reads that "match" across a
  // period in which the rollup plainly moved. Time already served must be
  // forfeited the moment anything is non-terminal.
  const rerun = (clock) =>
    clock < 15_000
      ? [{ name: 'Typecheck', state: 'success' }]
      : clock < 60_000
        ? [{ name: 'Typecheck', state: 'in_progress' }]
        : clock < 120_000
          ? [{ name: 'Typecheck', state: 'success' }]
          : POLL_COMPLETE;

  const r = poll(driver(rerun), { deadline: 900_000 });
  assert.equal(r.timedOut, false);
  assert.deepEqual(
    missingLanes(POLL_REQUIRED, r.state.lanes),
    [],
    'the hold restarts at t=60 s, so the poll is still there at t=120 s',
  );
});

test('an UNREADABLE hold falls back to the default, never to the weaker rule', () => {
  // A guard nobody can read must not be a guard nobody applies. NaN here would
  // make every comparison against it false, which reads as "hold forever" in
  // one direction and "no hold at all" in the other depending on how it is
  // written; neither is a decision anyone made.
  // Read against the #3294 shape, where the two candidate misreadings are
  // distinguishable: a hold of NaN never elapses, so the gate would burn the
  // whole budget and report a TIMEOUT instead of naming the missing lanes.
  const settled = [{ name: 'CodeRabbit', state: 'success' }];
  const d = driver(() => settled);
  const r = poll(d, { deadline: 900_000, settleHoldSeconds: Number('not a number') });
  assert.equal(r.timedOut, false, 'a timeout here would be the wrong verdict AND the wrong remedy');
  assert.deepEqual(d.slept, [15_000, 15_000, 15_000, 15_000], 'exactly the 60 s default');
});

test('THE ASSUMPTION, PINNED: a fan-out gap wider than the hold would defeat it', () => {
  // The hold is not magic — it buys exactly SETTLE_HOLD_SECONDS of tolerance,
  // and the claim it rests on is that GitHub never takes longer than that to
  // create the next wave of check runs after the last published one goes
  // terminal. Measured maximum over the 36 such windows found in 71 completed
  // `test.yml` PR runs (2026-08-25/26): 1 s — every single window exactly 1 s
  // wide, i.e. a 60x margin. This test makes the assumption FALSIFIABLE rather
  // than implicit: widen the gap past the hold and the wrong answer comes back,
  // which is what would happen if GitHub's fan-out latency ever grew that far.
  const gap = (seconds) => (clock) =>
    clock < seconds * 1000 ? [{ name: 'Typecheck', state: 'success' }] : POLL_COMPLETE;

  const withinHold = poll(driver(gap(SETTLE_HOLD_SECONDS - 15)), { deadline: 900_000 });
  assert.deepEqual(missingLanes(POLL_REQUIRED, withinHold.state.lanes), [], 'a 45 s gap is covered');

  const beyondHold = poll(driver(gap(SETTLE_HOLD_SECONDS * 2)), { deadline: 900_000 });
  assert.equal(
    missingLanes(POLL_REQUIRED, beyondHold.state.lanes).length,
    2,
    'a 120 s gap is NOT covered — that is the stated assumption, not an oversight',
  );
  // The failure direction is the safe one: a violated assumption produces a
  // false FAIL carrying the missing-lane remedy, never a false PASS.
  assert.equal(beyondHold.timedOut, false);
});
