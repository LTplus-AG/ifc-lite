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
  flattenReviewPages,
  matrixSkipAliases,
  missingLanes,
  noVerdictReviews,
  pollForLanes,
  parseWorkflowJobs,
  rollupSettled,
  staleReviews,
  flattenCheckRunPages,
  STALE_REVIEW_POLICIES,
  SETTLE_HOLD_SECONDS,
  pullRequestBranchFilterKeys,
  wholesaleSkippedTemplates,
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
  // These were the names observed on PR #3305's rollup on 2026-08-26, plus
  // `AGENTS.md ratchet`, added when check-agents-md-size.mjs got its own job
  // rather than riding in `Node tests` (it needs no build artifact and no
  // install, and routing it through `frontend` fanned one gate out to nine
  // jobs). The count is a TRIPWIRE for a lane appearing or vanishing unnoticed,
  // so bumping it is a deliberate act: add the new name to the list below as
  // well, or the count alone would pass while asserting nothing about identity.
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
    'AGENTS.md ratchet',
    'Build + WASM + Rust + Node',
  ]) {
    assert.ok(names.includes(observed), `derived set is missing the observed lane "${observed}"`);
  }
  assert.equal(names.length, 17);
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

// ------------------------------------------- a matrix job skipped BEFORE expanding

/**
 * The check-run name PR #3581 actually published, verbatim.
 *
 * ONE constant rather than five literals, and deliberately NOT derived from
 * `matrixSkipAliases` over the real test.yml: that is the function under test,
 * and an expected value taken from it would agree with it whatever it did. This
 * is the observed string, pinned by hand, which is the whole point.
 */
// The literal `${{ }}` below is DATA, not a template this file means to interpolate: it is what
// GitHub publishes as the check-run name for a matrix job skipped before it expanded.
// oxlint-disable-next-line no-template-curly-in-string
const MATRIX_TEMPLATE = 'Viewer tests (shard ${{ matrix.shard }})';

/**
 * VERBATIM from PR #3581's rollup on 2026-08-31 (a `.coderabbit.yaml`-only
 * change, so `needs.changes.outputs.frontend` was false). Note what is NOT here:
 * `Viewer tests (shard 0)` through `(shard 3)`. GitHub published ONE check run,
 * under the unexpanded template, because the job was skipped before its matrix
 * expanded.
 */
const PR3581_ROLLUP = [
  { name: 'Detect changes', state: 'success' },
  { name: 'Build + WASM + Rust + Node', state: 'success' },
  { name: 'Build packages + WASM', state: 'skipped' },
  { name: 'Viewer E2E smoke', state: 'skipped' },
  { name: MATRIX_TEMPLATE, state: 'skipped' },
];

test('RED, the #3581 shape: a skipped MATRIX job publishes its template, not its expansions', () => {
  // The premise the gate shipped with -- "a skipped job still publishes a check
  // run under the name we derived" -- was verified against `Docs checks
  // (docs-only PRs)`, a PLAIN job, where it holds. It does not hold here, and
  // the difference is invisible until a PR touches neither frontend nor rust.
  const required = ['Viewer tests (shard 0)', 'Viewer tests (shard 1)'];
  assert.deepEqual(
    missingLanes(required, PR3581_ROLLUP),
    required,
    'without the alias map both shards read as never having run',
  );
  const aliases = matrixSkipAliases(WF);
  assert.deepEqual(missingLanes(required, PR3581_ROLLUP, aliases), []);
});

test('the alias covers ONLY a skip: the template at any other state satisfies nothing', () => {
  // A template name at `success` means a workflow really is publishing a literal
  // `${{ ... }}` check, which is broken, not skipped. At `queued` the decision is
  // not made yet, and calling that covered would let the poll stop mid-fan-out.
  const aliases = matrixSkipAliases(WF);
  const required = ['Viewer tests (shard 0)'];
  for (const state of ['success', 'queued', 'in_progress', 'failure', '']) {
    const rollup = [{ name: MATRIX_TEMPLATE, state }];
    assert.deepEqual(missingLanes(required, rollup, aliases), required, `state "${state}"`);
  }
});

test('the alias is not a blanket pass: a shard absent with NO check run of any kind still fails', () => {
  const aliases = matrixSkipAliases(WF);
  assert.deepEqual(
    missingLanes(['Viewer tests (shard 0)'], [{ name: 'Detect changes', state: 'success' }], aliases),
    ['Viewer tests (shard 0)'],
    'this is the #3294 case the gate exists for, and it must be untouched',
  );
});

test('a PLAIN job gets no alias, so nothing but its own name can satisfy it', () => {
  // Giving a plain job an alias would be a real weakening: its skipped check run
  // already carries the derived name, so an alias could only ever let some OTHER
  // check stand in for it.
  const aliases = matrixSkipAliases(WF);
  assert.equal(aliases.has('Detect changes'), false);
  assert.equal(aliases.has('unnamed-job'), false);
  assert.deepEqual([...new Set(aliases.values())], [MATRIX_TEMPLATE]);
  assert.equal(aliases.size, 4, 'all four shards, and only those');
});

test('the REAL test.yml maps every viewer shard to the template the REAL rollup published', () => {
  // The pairing that matters: the SAME workflow file the gate derives from must
  // produce the alias for the SAME string PR #3581 was observed carrying. A
  // hand-written template in a fixture would prove nothing about that string.
  const aliases = matrixSkipAliases(
    readFileSync(join(REPO_ROOT, '.github/workflows/test.yml'), 'utf8'),
  );
  for (const shard of [0, 1, 2, 3]) {
    assert.equal(
      aliases.get(`Viewer tests (shard ${shard})`),
      MATRIX_TEMPLATE,
      `shard ${shard}`,
    );
  }
  const observed = PR3581_ROLLUP.map((c) => c.name);
  assert.ok(
    observed.includes([...new Set(aliases.values())][0]),
    'the derived template must be a string PR #3581 actually published',
  );
});

test('`excludeJobKeys` must reach BOTH derivations, or the alias map stops covering a lane', () => {
  // The one property no other test here pins: `main` passes the same exclude
  // list to `expandJobNames` and to `matrixSkipAliases`. Passing it to only the
  // first is a silent, asymmetric failure -- the lane stays required while its
  // alias disappears -- so it is checked positively rather than by the absence
  // of a complaint.
  const wf = readFileSync(join(REPO_ROOT, '.github/workflows/test.yml'), 'utf8');
  const exclude = CFG.excludeJobKeys ?? [];

  const required = expandJobNames(wf, { exclude });
  const missing = missingLanes(required, PR3581_ROLLUP, matrixSkipAliases(wf, { exclude }));
  // Positive: name exactly what is still missing. Everything test.yml publishes
  // that PR #3581's rollup did not carry, and not one viewer shard among them.
  const carried = new Set(PR3581_ROLLUP.map((c) => c.name));
  assert.deepEqual(
    missing,
    required.filter((n) => !carried.has(n) && !n.startsWith('Viewer tests (shard ')).sort(),
  );

  // Asymmetric: excluding the job from the ALIASES only puts the shards back.
  const asymmetric = missingLanes(required, PR3581_ROLLUP, matrixSkipAliases(wf, { exclude: [...exclude, 'viewer-tests'] }));
  for (const shard of [0, 1, 2, 3]) {
    assert.ok(asymmetric.includes(`Viewer tests (shard ${shard})`), `shard ${shard} uncovered`);
  }
});

test('FAIL CLOSED: pollForLanes REFUSES a missing alias map rather than defaulting', () => {
  // The defect this closes was found by review, not by a test: three call sites
  // wire the map, tests covered ONE, and deleting the other two left the suite
  // green while the live gate regressed to failing every config-only PR. A
  // default made that silent. It is now a named refusal.
  for (const bad of [undefined, null, {}, new Set(), [['a', 'b']]]) {
    assert.throws(
      () => pollForLanes({
        required: ['A'],
        aliases: bad,
        initialState: { lanes: [{ name: 'A', state: 'success' }] },
        fetchState: () => ({ lanes: [] }),
        deadline: Date.now() + 1000,
        pollSeconds: 1,
        sleep: () => {},
      }),
      (e) => e.reason === 'MISSING_ALIASES',
      String(bad),
    );
  }
});

test('a wholesale skip is REPORTED, never absorbed into a tick', () => {
  const aliases = matrixSkipAliases(WF);
  assert.deepEqual(
    [...wholesaleSkippedTemplates(PR3581_ROLLUP, aliases)],
    [MATRIX_TEMPLATE],
  );
  // And nothing is reported when nothing was skipped wholesale.
  assert.equal(wholesaleSkippedTemplates([{ name: 'Detect changes', state: 'skipped' }], aliases).size, 0);
});

test('the poll does not wait out its budget on a matrix that was skipped wholesale', () => {
  // Before the alias map this was the lived cost of the bug: the lanes could
  // never appear, so the poll ran the full 900 s before failing.
  let slept = 0;
  const r = pollForLanes({
    required: ['Viewer tests (shard 0)', 'Detect changes'],
    aliases: matrixSkipAliases(WF),
    initialState: { lanes: PR3581_ROLLUP },
    fetchState: () => ({ lanes: PR3581_ROLLUP }),
    deadline: Date.now() + 900_000,
    pollSeconds: 30,
    sleep: (ms) => { slept += ms; },
  });
  assert.equal(r.timedOut, false);
  assert.equal(slept, 0, 'it returns on the first read');
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

function poll(d, { deadline = 900_000, pollSeconds = 15, required, aliases, settleHoldSeconds } = {}) {
  return pollForLanes({
    required: required ?? POLL_REQUIRED,
    // EXPLICIT, because `pollForLanes` refuses a missing map. These fixtures use
    // plain lane names with no matrix job, so an empty map is the true answer
    // here -- not a default standing in for one nobody thought about.
    aliases: aliases ?? new Map(),
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
  // this — see the fan-out replay below — but 60 s out of the poll budget still
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

/**
 * Run creation to the LAST non-aggregate lane's `created_at`, in seconds, over
 * the 68 completed `test.yml` PR runs of 2026-08-25/26 that published the
 * aggregate. Read by TWO tests below, in opposite directions: what 900 s covered
 * on this population, and what 420 s false-failed on it. The 2026-08-31
 * re-measure does NOT read it -- it is a different population and carries its
 * own array, which is the whole reason the two disagree about 900 s.
 */
/** The budget the workflow ships; asserted against the YAML below, not restated. */
const BUDGET_SECONDS = 2400;

const LANE_APPEARED_SECONDS = [
  161, 162, 162, 162, 163, 164, 164, 165, 165, 165, 166, 166, 167, 167, 167, 167, 167, 169, 169,
  170, 170, 170, 170, 171, 171, 171, 172, 172, 175, 176, 177, 187, 188, 189, 190, 193, 198, 204,
  210, 221, 235, 237, 237, 241, 244, 276, 289, 290, 290, 297, 299, 310, 322, 334, 349, 362, 386,
  388, 403, 416, 423, 426, 450, 451, 522, 523, 542, 845,
];

test('MEASURED on 2026-08-25/26: 900 s covered every lane APPEARANCE in THAT population', () => {
  // SCOPED TO ITS POPULATION ON PURPOSE. A later test re-measures on 2026-08-31
  // and finds eight breaches of 900 s. The two do not contradict each other --
  // different runs, different day, a busier pool -- but a title claiming "every
  // observed" would, so it says which runs it observed.
  // THE METHODOLOGY HERE WAS WRONG ONCE, AND THE NUMBERS MOVED WHEN IT WAS
  // FIXED. The first version of this constant measured `started_at` — when a
  // runner picked the job up. The gate does not wait for that. It polls for
  // PRESENCE in the rollup, which is `created_at`, and the two diverge hard:
  // on run 32930088375 `Lint` was created at 416 s and started at 1037 s.
  // Measured from each run's own `created_at` over the 68 completed `test.yml`
  // PR runs of 2026-08-25/26 that published the aggregate, here is when the
  // LAST NON-AGGREGATE lane appeared, in seconds:
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
});

test('RE-MEASURED 2026-08-31: 900 s BREACHED, and the budget is now 2400 s', () => {
  // A 1.07x margin is one busy afternoon from being wrong, and this was that
  // afternoon.
  //
  // THIS ARRAY HAS BEEN CENSORED TWICE, BY THE SAME MECHANISM, AND THE SECOND
  // TIME WAS AFTER WRITING THE PARAGRAPH WARNING ABOUT IT. Filtering a run list
  // on `status == completed` at an instant drops the runs that are slow BECAUSE
  // THEY ARE STILL RUNNING -- it removes the tail, which is the only part of the
  // distribution a budget cares about.
  //
  //   first draft:  sampled the 60 most recent runs, kept the 22 completed.
  //                 Dropped 1276, 1387, 1503, 1786, 2028 -- the five slowest of
  //                 the day. Landed on 1800 s, which would not have covered the
  //                 worst run of the afternoon it was measured on.
  //   second draft: same filter, wider window, 45 kept. Dropped 1276 AGAIN --
  //                 run 33424176735, PR #3584's own -- because it finished about
  //                 50 s after the read. The docblock NAMED 1276 as a censored
  //                 run in the same breath as an array that omitted it.
  //
  // Both caught in review, not by me. The fix is not a wider window, it is to
  // stop sampling on a field that moves with the thing being measured: take the
  // whole day, after the day is over.
  //
  // Below: every completed test.yml PR run created on 2026-08-31 -- 72 created,
  // 57 completed, 56 with jobs to measure -- run creation to the LAST
  // non-aggregate lane's `created_at`.
  const RE_MEASURED = [
    15, 162, 166, 166, 169, 170, 170, 170, 171, 173, 173, 174, 175, 176, 176, 183, 185, 200, 201,
    201, 205, 211, 238, 264, 264, 269, 275, 282, 290, 308, 311, 314, 317, 333, 357, 375, 391, 418,
    469, 469, 473, 496, 622, 660, 662, 712, 814, 824, 906, 1172, 1276, 1387, 1503, 1527, 1786, 2028,
  ];
  assert.equal(RE_MEASURED.length, 56);

  // THE 12 RUNS THIS STILL CANNOT MEASURE, bounded rather than waved away --
  // that silent exclusion is the whole defect above. They were still queued, so
  // their last lane may yet appear later; so far they stand at 304..1145 s, and
  // the budget would have to be wrong by more than 1255 s for one to breach.
  const STILL_QUEUED_SO_FAR = [304, 306, 324, 374, 378, 397, 435, 446, 467, 485, 1102, 1145];
  assert.ok(Math.max(...STILL_QUEUED_SO_FAR) < BUDGET_SECONDS, 'none of the unmeasurable runs is near the cap');

  // EIGHT breach 900 s, not the seven an earlier censored draft claimed.
  assert.deepEqual(
    RE_MEASURED.filter((t) => t > 900),
    [906, 1172, 1276, 1387, 1503, 1527, 1786, 2028],
    '900 s breaches eight of 56',
  );
  assert.deepEqual(RE_MEASURED.filter((t) => t > 1800), [2028], '1800 s still breaches the max');
  assert.deepEqual(RE_MEASURED.filter((t) => t > BUDGET_SECONDS), [], 'the shipped budget covers all 56');

  // THE COVERING DIRECTION.
  for (const t of RE_MEASURED) {
    assert.equal(poll(driver(completesAt(t * 1000)), { deadline: BUDGET_SECONDS * 1000 }).timedOut, false, `${t}s`);
  }
  // THE FAILING DIRECTION, because a budget that covers everything proves
  // nothing on its own: the two superseded budgets genuinely time out on the
  // runs they are claimed to.
  for (const t of [906, 2028]) {
    assert.equal(poll(driver(completesAt(t * 1000)), { deadline: 900_000 }).timedOut, true, `${t}s vs 900 s`);
  }
  assert.equal(poll(driver(completesAt(2028_000)), { deadline: 1800_000 }).timedOut, true, '2028s vs 1800 s');
});

/**
 * WHAT THIS BUDGET ACTUALLY MEASURES, and it is NOT the build.
 *
 * An earlier draft of this file asserted it was "measuring the BUILD", which was
 * reasoning, not measurement, and it was wrong. The job timings say the number
 * is almost entirely RUNNER-POOL QUEUE:
 *
 *   run           queue before the first job started   build itself   queue share
 *   33422274815   1837 s                               176 s          91%
 *   33421389375   1350 s                               162 s          88%
 *   33424176735   1090 s                               165 s          85%
 *
 * The build is a near-constant ~170 s. Making it faster would move this budget
 * by seconds. That matters for the remedy: there is nothing to optimise here,
 * and the quantity has NO CEILING -- queue depth grows with how many PRs are
 * open, which is precisely when this gate is under load.
 *
 * STATED HOLE: a budget cannot bound an unbounded quantity, so this WILL breach
 * again on a busy enough day. When it does, the gate reports "within the poll
 * budget" rather than a bare absence, and the remedy is a re-run once the lanes
 * exist -- correct, because nothing failed.
 */
test('the budget the WORKFLOW ships is the budget this file tested', () => {
  // WITHOUT THIS, REVERTING THE SHIPPED VALUE LEAVES THE SUITE GREEN. Measured:
  // putting `--timeout-seconds 900` and `timeout-minutes: 20` back -- the exact
  // regression this work exists to fix -- passed the whole suite, because the only
  // budget any test named was a literal inside itself. Third instance today of
  // the same shape: a value tested in one place and shipped from another. See
  // the WIRING test in check-pr-review-signal.test.mjs.
  const wf = readFileSync(join(REPO_ROOT, '.github/workflows/pr-review-signal.yml'), 'utf8');
  // ANCHORED, and that is load-bearing rather than tidy. Unanchored, these
  // matched the FIRST occurrence anywhere in a comment-dense file whose comments
  // discuss these very numbers. Demonstrated in review: one line reading
  // `# historical: timeout-minutes: 45` above a shipped `timeout-minutes: 20`
  // passed all 78 tests while certifying a job that would be killed at 1200 s
  // against a 2400 s budget -- the exact `cancelled` run the slack assertion
  // below exists to prevent. `^[ \t]*` cannot match a `#`-prefixed line.
  const budget = /^[ \t]*--timeout-seconds[ \t]+(\d+)/m.exec(wf);
  assert.ok(budget, 'the workflow must pass an explicit --timeout-seconds');
  assert.equal(Number(budget[1]), BUDGET_SECONDS, 'shipped budget vs the one measured above');

  // The JOB cap must exceed the gate's own deadline, or the job is killed first
  // and the run reports `cancelled` -- the same word `cancel-in-progress`
  // produces for a superseded run, so a red check with no verdict and no way to
  // tell the two apart.
  const jobCap = /^[ \t]*timeout-minutes:[ \t]+(\d+)/m.exec(wf);
  assert.ok(jobCap, 'the job must carry a timeout-minutes');
  // >= 5 minutes of slack. Measured on the real failing run: set-up 2 s,
  // checkout 4 s, `node --test` 5 s, and 3 s of trailing reads after the poll
  // returned -- about 15 s beyond the budget, so 5 minutes is generous rather
  // than tight. The assertion is on the SLACK, not on either number, so raising
  // the budget later without raising the cap fails here instead of silently
  // producing a `cancelled` run.
  assert.ok(
    Number(jobCap[1]) * 60 - BUDGET_SECONDS >= 300,
    `timeout-minutes ${jobCap[1]} leaves ${Number(jobCap[1]) * 60 - BUDGET_SECONDS}s over the ` +
      `${BUDGET_SECONDS}s budget; at least 300 s required`,
  );

  // The poll interval bounds API cost: GITHUB_TOKEN is 1,000 requests/hour PER
  // REPOSITORY, shared with every other workflow, and the tail is CORRELATED
  // across PRs -- one busy pool slows every run at once, which is when the most
  // pollers are running at their cap. At 15 s this budget would be 160 reads a
  // run, so ~6 concurrent full-budget pollers exhaust the repository. Exhaustion
  // makes the gate fail closed on GH_ERROR: red, for a reason unrelated to the
  // diff. 30 s halves it, and costs 15 s of resolution on a 2400 s budget.
  const interval = /^[ \t]*--poll-seconds[ \t]+(\d+)/m.exec(wf);
  assert.ok(interval, 'the workflow must pass an explicit --poll-seconds');
  assert.ok(Number(interval[1]) >= 30, 'a faster poll multiplies the rate-limit risk');
  assert.ok(BUDGET_SECONDS / Number(interval[1]) <= 90, 'reads per run stay under ~90');
});

test('MEASURED: excluding the aggregate matters more than any budget, and 420 s false-failed 8', () => {
  // THE AGGREGATE EXCLUSION IS MORE LOAD-BEARING THAN ANY BUDGET EVER WAS, and
  // the 900 s figure below no longer argues that, because 900 s is not the
  // budget any more: at 2400 s, 0 of those 68 would breach and the evidence
  // would be vacuous. Re-measured on the same 56 runs of 2026-08-31 as the
  // budget above, the aggregate appeared at min 213 / median 1175 / MAX 3364 s,
  // with TWELVE past 2400 s. So the exclusion still carries the fix at the
  // budget actually in force, and the 68-run figure below is kept as the
  // original finding rather than restated as a current one.
  //
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

// ------------------------------------------------ PART 3: review staleness

/**
 * PR #3276, louistrue's own example in #3312, from
 * `repos/LTplus-AG/ifc-lite/pulls/3276/reviews` on 2026-08-26.
 *
 * Head `1305f778`; CodeRabbit's newest review names `c26e453d`, three commits
 * back. NOTE THAT EVERY ONE OF THESE IS `COMMENTED` — that is not fixture
 * convenience, it is what the API returns for this repository's reviewers, and
 * it is why the scoping rule cannot drop `COMMENTED`. (The SHAs of the older
 * commits are padded to 40 hex here; the head is verbatim.)
 */
const SHA = {
  head: '1305f778c0dc817bb344e23f881c2a30963c14c2',
  c26e453d: 'c26e453d00000000000000000000000000000000',
  x7e500b34: '7e500b3400000000000000000000000000000000',
};
const REVIEWS_3276 = [
  {
    id: 5030129859,
    user: { login: 'BIMvoice' },
    state: 'COMMENTED',
    commit_id: SHA.x7e500b34,
    submitted_at: '2026-08-26T12:04:59Z',
  },
  {
    id: 5030166378,
    user: { login: 'coderabbitai[bot]' },
    state: 'COMMENTED',
    commit_id: SHA.x7e500b34,
    submitted_at: '2026-08-26T12:09:08Z',
  },
  {
    id: 5030520937,
    user: { login: 'coderabbitai[bot]' },
    state: 'COMMENTED',
    commit_id: SHA.c26e453d,
    submitted_at: '2026-08-26T12:46:19Z',
  },
];
const AUTHORS = [
  { login: 'coderabbitai[bot]', context: 'CodeRabbit' },
  { login: 'cursor[bot]', context: 'Cursor Bugbot' },
];
/** The status #3276's head actually carried. */
const COMPLETED = [{ name: 'CodeRabbit', state: 'success', description: 'Review completed' }];

/** The shipped default. Adjudicates nothing — see the config's premise note. */
const OFF = { headSha: SHA.head, policy: 'off', authors: AUTHORS, checks: COMPLETED };

const stale = (reviews, over = {}) =>
  staleReviews(reviews, {
    headSha: SHA.head,
    policy: 'claimed-verdict',
    authors: AUTHORS,
    checks: COMPLETED,
    ...over,
  });

test('RED, #3276: `Review completed` on a head whose newest review is three commits back', () => {
  const found = stale(REVIEWS_3276);
  assert.equal(found.length, 1);
  assert.equal(found[0].login, 'coderabbitai[bot]');
  assert.equal(found[0].context, 'CodeRabbit');
  // The NEWEST review is the one compared. `7e500b34` is older and also stale,
  // but reporting it would mean the ordering is not being applied at all.
  assert.equal(found[0].reviewedSha, SHA.c26e453d);
});

test('ANTI-VACUITY: the same shape with the newest review AT the head reports nothing', () => {
  // Without this, an implementation that always reports stale passes the test
  // above. #3315, #3309 and #2931 are this case live.
  const current = REVIEWS_3276.map((r) =>
    r.id === 5030520937 ? { ...r, commit_id: SHA.head } : r,
  );
  assert.deepEqual(stale(current), []);
});

test('ORDERING: a later review of an OLDER commit still leaves the PR stale', () => {
  // Mutating ORDER rather than values: shuffling the array must not change the
  // answer, and the tie-break must be exercised rather than assumed.
  const shuffled = [...REVIEWS_3276].reverse();
  assert.equal(shuffled[0].id, 5030520937, 'the fixture really is reordered');
  assert.equal(stale(shuffled).length, 1);
  assert.equal(stale(shuffled)[0].reviewedSha, SHA.c26e453d);

  const tie = [
    {
      id: 1,
      user: { login: 'coderabbitai[bot]' },
      state: 'COMMENTED',
      commit_id: SHA.head,
      submitted_at: '2026-08-26T12:00:00Z',
    },
    {
      id: 2,
      user: { login: 'coderabbitai[bot]' },
      state: 'COMMENTED',
      commit_id: SHA.c26e453d,
      submitted_at: '2026-08-26T12:00:00Z',
    },
  ];
  // Same timestamp: the id breaks the tie, and the larger id is the later
  // review. It names an older commit, so the PR IS stale. Reverse the ids and
  // the same two rows must come back clean — that is the assumption, made
  // falsifiable rather than left implicit.
  assert.equal(stale(tie).length, 1, 'the id tie-break decides, and it decides stale');
  const flipped = [
    { ...tie[0], id: 2 },
    { ...tie[1], id: 1 },
  ];
  assert.deepEqual(stale(flipped), []);
});

test('NO NAG: a reviewer still working is not stale — the head status is not `success`', () => {
  // Clause (b) of the default policy. A bot mid-review has a `pending` context,
  // so a stale `commit_id` under it is a race, not a defect.
  assert.deepEqual(stale(REVIEWS_3276, { checks: [{ name: 'CodeRabbit', state: 'pending' }] }), []);
  assert.deepEqual(stale(REVIEWS_3276, { checks: [] }), []);
});

test('NO NAG: an author with NO review event is never reported, and that is the stated hole', () => {
  // #3316 and #3205 carry `CodeRabbit :: success / Review completed` and ZERO
  // review events of any kind. Absence of a review is not evidence of
  // staleness, and no `commit_id` comparison can see a reviewer that leaves no
  // review object.
  assert.deepEqual(stale([]), []);
});

test('DEDUPE: a flagged context is SUPPRESSED, not dropped — an empty list means clean', () => {
  // RED before the fix: this returned `[]`, so the caller could not tell
  // "clean" from "found, but already said" and printed the part 3 tick over a
  // finding it had made, with `staleReviewSeverity` inoperative.
  const deduped = stale(REVIEWS_3276, { alreadyFlagged: ['CodeRabbit'] });
  assert.equal(deduped.length, 1, 'the finding survives; only the sentence is redundant');
  assert.equal(deduped[0].suppressedBy, 'CodeRabbit');
  assert.equal(deduped[0].reviewedSha, SHA.c26e453d);
  // …and the dedupe is scoped to the context named, not to everything.
  const other = stale(REVIEWS_3276, { alreadyFlagged: ['Cursor Bugbot'] });
  assert.equal(other.length, 1);
  assert.equal(other[0].suppressedBy, null, 'an unrelated context suppresses nothing');
  // The genuinely clean case is the ONLY one that is empty, which is what makes
  // an empty list readable as a pass.
  assert.deepEqual(stale([], { alreadyFlagged: ['CodeRabbit'] }), []);
});

test('OFF: the shipped default adjudicates nothing, and refuses nothing either', () => {
  // #3276's own fixture, the shape the rule was built for, under `off`.
  assert.deepEqual(staleReviews(REVIEWS_3276, { ...OFF }), []);
  // And `off` is INERT rather than merely silent: the fail-closed guards exist
  // to stop a bad read printing a pass, and `off` prints no pass, so an
  // unreadable head or an unreadable review list must not take the gate down
  // over a question this policy never asks. Each of these throws under
  // `claimed-verdict` — asserted in the fail-closed tests below.
  assert.deepEqual(staleReviews(REVIEWS_3276, { ...OFF, headSha: 'HEAD' }), []);
  assert.deepEqual(staleReviews(null, { ...OFF }), []);
  assert.deepEqual(staleReviews(REVIEWS_3276, { ...OFF, authors: [] }), []);
  const broken = REVIEWS_3276.map((r) => (r.id === 5030520937 ? { ...r, commit_id: 'nope' } : r));
  assert.deepEqual(staleReviews(broken, { ...OFF }), []);
  // MUTATION GUARD: `off` must be inert, not a synonym for "never fires". An
  // unrecognised policy is still BAD_CONFIG, so the early return cannot be
  // reached by a typo.
  assert.throws(
    () => staleReviews(REVIEWS_3276, { ...OFF, policy: 'Off' }),
    (e) => e instanceof ReviewSignalError && e.reason === 'BAD_CONFIG',
  );
});

test('ORDERING: `id` alone — a head review with no `submitted_at` is not masked', () => {
  // RED before the fix: the key was `(submitted_at, id)`, so a review with no
  // timestamp sorted to `''` and lost to EVERY dated review. Here the NEWEST
  // review names the head and carries no `submitted_at`, and the older dated
  // one names `c26e453d`. Under the old key this reported a CURRENT PR as
  // stale — the finding the JSDoc says cannot be invented.
  const undated = [
    {
      id: 5030520937,
      user: { login: 'coderabbitai[bot]' },
      state: 'COMMENTED',
      commit_id: SHA.c26e453d,
      submitted_at: '2026-08-26T12:46:19Z',
    },
    {
      id: 5030999999,
      user: { login: 'coderabbitai[bot]' },
      state: 'COMMENTED',
      commit_id: SHA.head,
    },
  ];
  assert.deepEqual(stale(undated), []);
  // ANTI-VACUITY: flip which of the two names the head and it IS stale, so the
  // clean result above is the ordering speaking and not a swallowed row.
  const flipped = [
    { ...undated[0], commit_id: SHA.head },
    { ...undated[1], commit_id: SHA.c26e453d },
  ];
  assert.equal(stale(flipped).length, 1);
  assert.equal(stale(flipped)[0].reviewedSha, SHA.c26e453d);
  assert.equal(stale(flipped)[0].submittedAt, null, 'the timestamp is printed, not compared');
});

test('POLICY: the three policies scope differently, and each is exercised', () => {
  const humanApproved = [
    {
      id: 10,
      user: { login: 'louistrue' },
      state: 'APPROVED',
      commit_id: SHA.c26e453d,
      submitted_at: '2026-08-26T12:46:19Z',
    },
  ];
  const base = { headSha: SHA.head, authors: AUTHORS, checks: [] };

  // `claimed-verdict`: no configured context claims a verdict, so nothing.
  assert.deepEqual(staleReviews(humanApproved, { ...base, policy: 'claimed-verdict' }), []);
  // `configured-authors`: drops clause (b) but keeps the identity scope, and
  // `louistrue` is not a configured identity.
  assert.deepEqual(staleReviews(humanApproved, { ...base, policy: 'configured-authors' }), []);
  // `all-authors`: this is the policy that flags a human approval predating a
  // rebase. It is NOT the default, and which of the three ships is the choice
  // left to the maintainer.
  const all = staleReviews(humanApproved, { ...base, policy: 'all-authors' });
  assert.equal(all.length, 1);
  assert.equal(all[0].login, 'louistrue');
  assert.equal(all[0].context, null);

  // And `configured-authors` DOES fire on a configured identity with no passing
  // context — otherwise the two `deepEqual([])` above would prove nothing.
  const cr = staleReviews(REVIEWS_3276, { ...base, policy: 'configured-authors' });
  assert.equal(cr.length, 1, 'clause (b) is genuinely dropped by this policy');
});

test('DISMISSED and PENDING reviews are not verdicts on a commit', () => {
  const dismissed = REVIEWS_3276.map((r) =>
    r.id === 5030520937 ? { ...r, state: 'DISMISSED' } : r,
  );
  // The newest SURVIVING review is `7e500b34`, still stale — so the filter is
  // shown to change WHICH review is compared, not merely to shrink the list.
  assert.equal(stale(dismissed)[0].reviewedSha, SHA.x7e500b34);

  const pending = REVIEWS_3276.map((r) => (r.id === 5030520937 ? { ...r, state: 'PENDING' } : r));
  assert.equal(stale(pending)[0].reviewedSha, SHA.x7e500b34);
});

// --------------------------------------------- fail-closed, one test each

test('FAIL CLOSED: an unreadable head SHA refuses rather than reporting every review stale', () => {
  for (const bad of [undefined, null, '', 'HEAD', SHA.head.slice(0, 39), SHA.head.toUpperCase()]) {
    assert.throws(
      () => stale(REVIEWS_3276, { headSha: bad }),
      (e) => e instanceof ReviewSignalError && e.reason === 'NO_HEAD_SHA',
      `head ${JSON.stringify(bad)}`,
    );
  }
});

test('FAIL CLOSED: an unrecognised policy is BAD_CONFIG, never a silent narrowing', () => {
  for (const bad of [undefined, null, '', 'strict', 'CLAIMED-VERDICT']) {
    assert.throws(
      () => stale(REVIEWS_3276, { policy: bad }),
      (e) => e instanceof ReviewSignalError && e.reason === 'BAD_CONFIG',
      `policy ${JSON.stringify(bad)}`,
    );
  }
});

test('FAIL CLOSED: a non-array reviews read is NO_REVIEWS, not "everything is current"', () => {
  for (const bad of [undefined, null, '', {}, 'nope']) {
    assert.throws(
      () => stale(bad),
      (e) => e instanceof ReviewSignalError && e.reason === 'NO_REVIEWS',
      `reviews ${JSON.stringify(bad)}`,
    );
  }
});

test('FAIL CLOSED: an empty reviewer identity list examines nothing, so it refuses', () => {
  for (const policy of ['claimed-verdict', 'configured-authors']) {
    assert.throws(
      () => stale(REVIEWS_3276, { policy, authors: [] }),
      (e) => e instanceof ReviewSignalError && e.reason === 'EMPTY_REVIEW_AUTHORS',
      policy,
    );
    assert.throws(
      () => stale(REVIEWS_3276, { policy, authors: undefined }),
      (e) => e instanceof ReviewSignalError && e.reason === 'EMPTY_REVIEW_AUTHORS',
      `${policy} / undefined`,
    );
  }
  // `all-authors` does not scope by identity, so an empty list is meaningful
  // there and must NOT throw — the guard is tied to what actually reads it.
  assert.equal(
    staleReviews(REVIEWS_3276, {
      headSha: SHA.head,
      policy: 'all-authors',
      authors: [],
      checks: COMPLETED,
    }).length,
    2,
  );
});

test('FAIL CLOSED: an unreadable `commit_id` on a counted review refuses', () => {
  for (const bad of [undefined, null, '', 'c26e453d', 12345]) {
    const broken = REVIEWS_3276.map((r) => (r.id === 5030520937 ? { ...r, commit_id: bad } : r));
    assert.throws(
      () => stale(broken),
      (e) => e instanceof ReviewSignalError && e.reason === 'UNREADABLE_COMMIT_ID',
      `commit_id ${JSON.stringify(bad)}`,
    );
  }
});

test('FAIL CLOSED: a review this policy does NOT count may be malformed without blinding the gate', () => {
  // The mirror of the test above, and the reason scoping happens BEFORE
  // validation: a third party's broken review must not stop the gate seeing
  // CodeRabbit's stale one…
  const broken = [
    ...REVIEWS_3276,
    { id: 999, user: { login: 'somebody' }, state: 'COMMENTED', commit_id: null },
  ];
  assert.equal(stale(broken).length, 1);
  // …but under `all-authors`, which DOES count it, the same input refuses.
  assert.throws(
    () => stale(broken, { policy: 'all-authors' }),
    (e) => e instanceof ReviewSignalError && e.reason === 'UNREADABLE_COMMIT_ID',
  );
});

test('FAIL CLOSED: a review with no usable id has no defensible "newest"', () => {
  for (const bad of [undefined, null, 'abc', Number.NaN]) {
    const broken = REVIEWS_3276.map((r) => (r.id === 5030520937 ? { ...r, id: bad } : r));
    assert.throws(
      () => stale(broken),
      (e) => e instanceof ReviewSignalError && e.reason === 'UNREADABLE_REVIEW_ID',
      `id ${JSON.stringify(bad)}`,
    );
  }
});

test('the shipped config is a valid part 3 config, and its policy is the stated default', () => {
  // Pins the DEFAULT itself, once, so moving it is a deliberate edit here.
  // `off`, and the premise defect that put it there is in the config's own
  // note: CodeRabbit submits no review event when a run finds nothing
  // actionable, so 2 of `claimed-verdict`'s 4 live fires (#3276, #3288) are
  // false and no structured field separates them from the 2 real ones.
  assert.equal(CFG.staleReviewPolicy, 'off');
  assert.equal(CFG.staleReviewSeverity, 'warn');
  assert.ok(STALE_REVIEW_POLICIES.has(CFG.staleReviewPolicy));
  // The two identity spaces really are different, which is why `reviewAuthors`
  // exists at all rather than reusing `reviewers`.
  const logins = CFG.reviewAuthors.map((a) => a.login);
  assert.ok(logins.includes('coderabbitai[bot]'));
  assert.ok(!CFG.reviewers.includes('coderabbitai[bot]'), 'a login is not a check context');
  for (const a of CFG.reviewAuthors) {
    assert.ok(CFG.reviewers.includes(a.context), `${a.context} must also be a part 2 reviewer`);
  }
});

test('PAGINATION: pages are concatenated in order, so the NEWEST review survives the walk', () => {
  // The newest review is on the LAST page. Order matters, so this asserts the
  // sequence rather than the length.
  const pages = [
    [REVIEWS_3276[0], REVIEWS_3276[1]],
    [REVIEWS_3276[2]],
  ];
  const flat = flattenReviewPages(pages, 'reviews');
  assert.deepEqual(
    flat.map((r) => r.id),
    [5030129859, 5030166378, 5030520937],
  );
  // …and the flattened list is what produces the #3276 finding, so a walk that
  // lost the last page would report the WRONG commit rather than nothing.
  assert.equal(stale(flat)[0].reviewedSha, SHA.c26e453d);
  // An empty walk is a legitimate answer (a PR with no reviews at all), and it
  // is NOT the same as an unreadable one.
  assert.deepEqual(flattenReviewPages([], 'reviews'), []);
  assert.deepEqual(flattenReviewPages([[]], 'reviews'), []);
});

test('FAIL CLOSED: a pagination walk that did not complete is REVIEWS_TRUNCATED', () => {
  // Dropping the last page would compare an older review and report a CURRENT
  // PR as stale — a false finding, the one direction a gate must never fail.
  for (const bad of [null, undefined, {}, 'oops', 42]) {
    assert.throws(
      () => flattenReviewPages([[REVIEWS_3276[0]], bad], 'reviews'),
      (e) => e instanceof ReviewSignalError && e.reason === 'REVIEWS_TRUNCATED',
      `page ${JSON.stringify(bad)}`,
    );
  }
});

test('FAIL CLOSED: an unreadable pagination result is NO_REVIEWS', () => {
  for (const bad of [null, undefined, {}, 'oops']) {
    assert.throws(
      () => flattenReviewPages(bad, 'reviews'),
      (e) => e instanceof ReviewSignalError && e.reason === 'NO_REVIEWS',
      `pages ${JSON.stringify(bad)}`,
    );
  }
});

test('CHECK-RUN PAGINATION: an object-paged walk is flattened in order', () => {
  // The check-runs endpoint pages an OBJECT, not a bare array, so the shape
  // check is on `check_runs`. A truncated walk here drops a reviewer CONTEXT,
  // and part 2 adjudicates a missing context by SILENCE — a false negative, not
  // a failure, which is why this refuses rather than using what arrived.
  const pages = [
    { total_count: 3, check_runs: [{ name: 'a' }, { name: 'b' }] },
    { total_count: 3, check_runs: [{ name: 'CodeRabbit' }] },
  ];
  assert.deepEqual(
    flattenCheckRunPages(pages, 'check runs').map((c) => c.name),
    ['a', 'b', 'CodeRabbit'],
  );
  assert.deepEqual(flattenCheckRunPages([], 'check runs'), []);
});

test('FAIL CLOSED: a check-run walk that did not complete is NO_CHECK_RUNS', () => {
  for (const bad of [null, undefined, {}, 'oops', [null], [{ total_count: 1 }], [{ check_runs: 1 }]]) {
    assert.throws(
      () => flattenCheckRunPages(bad, 'check runs'),
      (e) => e instanceof ReviewSignalError && e.reason === 'NO_CHECK_RUNS',
      `pages ${JSON.stringify(bad)}`,
    );
  }
});

// ------------------------------------------- workflow base-branch filter (#3433)

/**
 * A regex over source text (`/^\s*branches:\s*(\[.*\])\s*$/m`) is what this
 * function replaced. Measured against that regex directly, BEFORE this fix,
 * to pin the failure it left rather than merely describe it: a `branches:`
 * key written as a block sequence produced NO match, so a guard asserting
 * "no base-branch filter present" stayed green over a workflow that in fact
 * had one. #3433 measured this exact gap live on `pr-review-signal.yml` — the
 * regression suite ran 48/48 with the filter reintroduced in block style, and
 * only caught it (47/48) when the filter was reintroduced inline.
 */
const OLD_TEXT_REGEX_BRANCHES_OF = (text) => /^\s*branches:\s*(\[.*\])\s*$/m.exec(text)?.[1];

test('RED: the old text-regex guard misses the block-sequence spelling (#3433)', () => {
  const inline = 'on:\n  pull_request:\n    branches: [main]\n';
  const block = 'on:\n  pull_request:\n    branches:\n      - main\n';
  assert.ok(
    OLD_TEXT_REGEX_BRANCHES_OF(inline),
    'sanity: the old regex does catch the inline spelling it was written for',
  );
  assert.equal(
    OLD_TEXT_REGEX_BRANCHES_OF(block),
    undefined,
    'this is the hole: the old regex reports NO filter on a workflow that has one, because the ' +
      'value is a block sequence rather than `[...]` on the same line',
  );
});

test('pullRequestBranchFilterKeys: every spelling GitHub Actions accepts resolves to `branches`', () => {
  const cases = {
    'inline flow sequence': 'on:\n  pull_request:\n    branches: [main]\njobs:\n  x: {}\n',
    'block sequence': 'on:\n  pull_request:\n    branches:\n      - main\njobs:\n  x: {}\n',
    'quoted flow sequence': 'on:\n  pull_request:\n    branches: ["main"]\njobs:\n  x: {}\n',
    'single unbracketed scalar': 'on:\n  pull_request:\n    branches: main\njobs:\n  x: {}\n',
    'reached through an alias': [
      'anchors:',
      '  bases: &bases [main]',
      'on:',
      '  pull_request:',
      '    branches: *bases',
      'jobs:',
      '  x: {}',
      '',
    ].join('\n'),
  };
  for (const [label, yamlText] of Object.entries(cases)) {
    assert.deepEqual(pullRequestBranchFilterKeys(yamlText), ['branches'], label);
  }
});

test('pullRequestBranchFilterKeys: `branches-ignore` is its own key with the same filtering effect', () => {
  const yamlText = 'on:\n  pull_request:\n    branches-ignore: [dev]\njobs:\n  x: {}\n';
  assert.deepEqual(pullRequestBranchFilterKeys(yamlText), ['branches-ignore']);
});

test('pullRequestBranchFilterKeys: no filter on the trigger reports empty, not a false positive', () => {
  const noFilter = 'on:\n  pull_request:\n    types: [opened]\njobs:\n  x: {}\n';
  const bareTrigger = 'on:\n  pull_request:\njobs:\n  x: {}\n';
  assert.deepEqual(pullRequestBranchFilterKeys(noFilter), []);
  assert.deepEqual(pullRequestBranchFilterKeys(bareTrigger), []);
});
