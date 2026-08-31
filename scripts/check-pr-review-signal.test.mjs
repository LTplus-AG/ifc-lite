/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Regression harness for the #3312 gate as a PROCESS: real argv, real config
 * reads, real exit codes. `scripts/lib/pr-review-signal.test.mjs` covers the
 * classification; this covers the parts that only exist once there is an
 * `process.exit` to get wrong.
 *
 * The rollup and the review descriptions arrive through `--state-file`, so
 * every branch below is driven without a network, a token, or a real PR — and
 * the SAME `evaluate` runs in CI as runs here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expandJobNames, pullRequestBranchFilterKeys } from './lib/pr-review-signal.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const GATE = join(HERE, 'check-pr-review-signal.mjs');
const CONFIG = join(HERE, 'pr-review-signal.config.json');
const TEST_YML = join(REPO_ROOT, '.github/workflows/test.yml');

const TMP = mkdtempSync(join(tmpdir(), 'pr-review-signal-'));
let seq = 0;

/**
 * A head SHA for the state files that are not about part 3. It is a real
 * 40-hex string because `staleReviews` refuses anything else — see the
 * NO_HEAD_SHA test below, which drives that refusal deliberately.
 */
const ANY_HEAD = '0'.repeat(40);

/** Run the gate over a state file EXACTLY as written — no defaults injected. */
function runRaw(state, extra = []) {
  const path = join(TMP, `state-${(seq += 1)}.json`);
  writeFileSync(path, JSON.stringify(state));
  const r = spawnSync(process.execPath, [GATE, '--state-file', path, ...extra], {
    encoding: 'utf8',
  });
  return { code: r.status, output: `${r.stdout}${r.stderr}` };
}

/**
 * Run the gate over a synthetic rollup.
 *
 * The part 3 inputs are defaulted HERE, in the harness, and NOT in the gate:
 * `main()` passes `state.reviews` and `state.headSha` straight through, so a
 * state file that omits them fails closed with NO_REVIEWS / NO_HEAD_SHA. That
 * refusal is asserted by `runRaw` below; defaulting inside the gate would have
 * made it print a part 3 success line over a question nobody answered.
 */
function run(state, extra = []) {
  return runRaw({ reviews: [], headSha: ANY_HEAD, ...state }, extra);
}

/** Write a config variant and return its path. */
function cfgWith(patch, tag) {
  const cfg = { ...JSON.parse(readFileSync(CONFIG, 'utf8')), ...patch };
  const path = join(TMP, `cfg-${tag}.json`);
  writeFileSync(path, JSON.stringify(cfg));
  return path;
}

/**
 * The severity knob forced to `fail`.
 *
 * The SHIPPED default is `warn` (a rate-limited status never self-heals, so a
 * required check on it stays red until a human pushes — see the config's own
 * note). The tests that assert a review finding turns the PR RED therefore pass
 * this explicitly: they are about the DETECTION and the escalation path, not
 * about which default ships, and pinning them to the default would have made
 * them silently change meaning when it moved. Which default ships is asserted
 * on its own, once, below.
 */
const FATAL = () => ['--config', cfgWith({ reviewVerdictSeverity: 'fail' }, 'fatal')];

const LANE = (name, state = 'success') => ({ name, state });
const HEALTHY = ['Typecheck', 'Lint', 'Node tests'];

// -------------------------------------------------------------- happy path

test('GREEN: every required lane present and no reviewer claims a verdict it lacks', () => {
  const r = run({
    required: HEALTHY,
    lanes: HEALTHY.map((n) => LANE(n)),
    reviewChecks: [{ name: 'CodeRabbit', state: 'success', description: 'Review completed' }],
  });
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /All 3 required lane\(s\)/);
  assert.match(r.output, /none reports a passing state over a review it did not perform/);
});

// ------------------------------------- the wiring, not just the logic

/**
 * VERBATIM from PR #3581's rollup on 2026-08-31, a `.coderabbit.yaml`-only
 * change. `Viewer tests (shard 0..3)` are absent and the UNEXPANDED template is
 * present at `skipped`, because a matrix job skipped by its `if:` publishes one
 * check run before the matrix expands.
 */
// The literal `${{ }}` below is DATA, not a template this file means to interpolate: it is what
// GitHub publishes as the check-run name for a matrix job skipped before it expanded.
// oxlint-disable-next-line no-template-curly-in-string
const SKIPPED_MATRIX_TEMPLATE = 'Viewer tests (shard ${{ matrix.shard }})';

test('END TO END: a wholesale-skipped matrix job passes the REAL required set', () => {
  // NO `required` OVERRIDE, and that is the entire point of this test. Every
  // other case here supplies `HEALTHY`, which has no matrix lane, so the alias
  // map is inert in all of them: deleting the three `aliases,` arguments in
  // `main()` left all 122 tests green while the gate went back to failing every
  // config-only PR. The fix has to be proved to ARRIVE, not merely to exist.
  //
  // Omitting `required` makes `main()` derive it from the real test.yml, so this
  // runs the same wiring CI runs.
  const wf = readFileSync(TEST_YML, 'utf8');
  const lanes = expandJobNames(wf, { exclude: JSON.parse(readFileSync(CONFIG, 'utf8')).excludeJobKeys ?? [] })
    .filter((n) => !n.startsWith('Viewer tests (shard '))
    .map((n) => LANE(n, 'skipped'));
  lanes.push(LANE(SKIPPED_MATRIX_TEMPLATE, 'skipped'));

  const r = run({ lanes, reviewChecks: [] });
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /All \d+ required lane\(s\)/);
  // Reported, never absorbed: the skip is named along with how many lanes it covered.
  assert.match(r.output, /was SKIPPED as a whole job/);
  assert.match(r.output, /its 4 lane\(s\)/);
});

test('a fixture alias with a NON-STRING template is BAD_STATE_FILE, not MISSING_LANES', () => {
  // CodeRabbit, PR #3584. Reproduced before fixing: a `null` template made the
  // gate print MISSING_LANES -- a true verdict reached for a false reason, which
  // is the thing refusing the malformed outer value was supposed to prevent.
  // `undefined` is absent from this list on purpose: JSON.stringify DROPS the key,
  // so it cannot reach a state file at all and asserting on it would test the harness.
  for (const template of [null, 42, '', ['a'], true, {}]) {
    const r = runRaw({
      required: ['Viewer tests (shard 0)', 'Detect changes'],
      lanes: [LANE('Detect changes'), LANE(SKIPPED_MATRIX_TEMPLATE, 'skipped')],
      aliases: { 'Viewer tests (shard 0)': template },
      reviewChecks: [],
      reviews: [],
      headSha: ANY_HEAD,
    });
    assert.equal(r.code, 1, r.output);
    assert.match(r.output, /BAD_STATE_FILE/, `template ${JSON.stringify(template)}`);
    assert.doesNotMatch(r.output, /MISSING_LANES/, 'the reason must be the malformed fixture');
  }
});

test('END TO END: the same rollup WITHOUT the template still fails, naming all four shards', () => {
  // The anti-vacuity pair. If the test above passed for any reason other than
  // the alias map -- a required set that never contained the shards, say -- this
  // one would pass too, and it must not.
  const wf = readFileSync(TEST_YML, 'utf8');
  const lanes = expandJobNames(wf, { exclude: JSON.parse(readFileSync(CONFIG, 'utf8')).excludeJobKeys ?? [] })
    .filter((n) => !n.startsWith('Viewer tests (shard '))
    .map((n) => LANE(n, 'skipped'));

  const r = run({ lanes, reviewChecks: [] });
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /MISSING_LANES: 4 of/);
  for (const shard of [0, 1, 2, 3]) {
    assert.ok(r.output.includes(`Viewer tests (shard ${shard})`), `must name shard ${shard}`);
  }
});

test('END TO END: the template at SUCCESS is not a skip, and does not cover the shards', () => {
  const wf = readFileSync(TEST_YML, 'utf8');
  const lanes = expandJobNames(wf, { exclude: JSON.parse(readFileSync(CONFIG, 'utf8')).excludeJobKeys ?? [] })
    .filter((n) => !n.startsWith('Viewer tests (shard '))
    .map((n) => LANE(n, 'skipped'));
  lanes.push(LANE(SKIPPED_MATRIX_TEMPLATE, 'success'));

  const r = run({ lanes, reviewChecks: [] });
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /MISSING_LANES: 4 of/);
});

/**
 * THE LIVE CALL SITES, ASSERTED STATICALLY, because nothing else can reach them.
 *
 * `main()` needs `gh`, so the harness drives `evaluate` only through
 * `--state-file` and never drives `pollForLanes` at all. That left both LIVE
 * wire-ups deletable with the suite green -- found in review, and the reason the
 * two functions now refuse a missing map at run time. This test moves that
 * refusal earlier, to CI, so a deleted argument is caught before it ships rather
 * than by the first real run.
 *
 * Reading source is a blunt instrument and it is the honest one here: the claim
 * is literally about what the source passes.
 */
test('WIRING: every call to pollForLanes and evaluate passes an alias map', () => {
  const src = readFileSync(GATE, 'utf8');
  // `function` excludes `evaluate`'s own definition, which otherwise matches --
  // and matches WITH an `aliases` parameter, so only the count caught it.
  const calls = [...src.matchAll(/(?<!function )\b(pollForLanes|evaluate)\(\{/g)];
  assert.equal(calls.length, 3, 'two live call sites and the --state-file one; update this if that changes');

  for (const m of calls) {
    // Walk from the `({` to its matching `})` so a nested object cannot end it early.
    let depth = 0;
    let i = src.indexOf('{', m.index);
    const start = i;
    for (; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') { depth -= 1; if (depth === 0) break; }
    }
    const args = src.slice(start, i + 1);
    assert.match(args, /\baliases\b\s*[:,]/, `${m[1]}() at index ${m.index} passes no alias map`);
  }
});

// ------------------------------------------------- the two live failures

test('RED, the #3294 shape: a rollup with no compile lanes fails and NAMES each one', () => {
  const r = run({
    required: HEALTHY,
    lanes: [
      LANE('Vercel – ifc-lite'),
      LANE('Vercel Preview Comments'),
      LANE('CodeRabbit'),
    ],
    reviewChecks: [],
  });
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /MISSING_LANES: 3 of 3/);
  for (const n of HEALTHY) assert.ok(r.output.includes(n), `must name the missing lane ${n}`);
  // The remedy has to name the mechanism that actually caused it, or the next
  // person re-derives the retarget rule from scratch.
  assert.match(r.output, /retargeted to main does NOT fire test\.yml retroactively/);
});

test('RED, the #3429 shape: a PR stacked on a feature-branch base fails and names the real remedy', () => {
  // The #3294 message above ("push an empty commit, or close and reopen")
  // does not work here: test.yml's own `branches: [main]` filter means it
  // will not fire against a non-main base no matter how the PR is nudged.
  // This is the case #3429 asks the gate to surface -- a stacked PR whose
  // lanes are absent not because of a stale retarget, but because they were
  // never going to run against this base at all.
  const r = run({
    required: HEALTHY,
    lanes: [LANE('Vercel – ifc-lite'), LANE('IfcOpenShell parity')],
    reviewChecks: [],
    baseRefName: 'fix-3338-isolate-expansion-gate',
  });
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /MISSING_LANES: 3 of 3/);
  assert.match(r.output, /this PR's base is `fix-3338-isolate-expansion-gate`, not `main`/);
  assert.match(r.output, /retargeting this PR to `main` will/);
  // Must NOT print the #3294 remedy -- pushing an empty commit fixes nothing
  // here, and telling a stacked-PR author to do it is advice that cannot work.
  assert.doesNotMatch(r.output, /retargeted to main does NOT fire test\.yml retroactively/);
});

test('RED, the #3305 shape: CodeRabbit passing while rate limited fails and quotes it', () => {
  const r = run(
    {
      required: HEALTHY,
      lanes: HEALTHY.map((n) => LANE(n)),
      reviewChecks: [{ name: 'CodeRabbit', state: 'success', description: 'Review rate limited' }],
    },
    FATAL(),
  );
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /NO_VERDICT: `CodeRabbit` reports a PASSING state/);
  assert.match(r.output, /"Review rate limited"/);
});

test('the #3305 shape is REPORTED AND QUOTED under the shipped default too', () => {
  // The downgrade to `warn` must not become a deletion. Same input, shipped
  // config: the finding still names the reviewer and still quotes it verbatim,
  // it just does not hold the PR red on a quota that will never clear itself.
  const r = run({
    required: HEALTHY,
    lanes: HEALTHY.map((n) => LANE(n)),
    reviewChecks: [{ name: 'CodeRabbit', state: 'success', description: 'Review rate limited' }],
  });
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /NO_VERDICT: `CodeRabbit` reports a PASSING state/);
  assert.match(r.output, /"Review rate limited"/);
  assert.match(r.output, /merging on it means merging unreviewed/);
});

test('one lane missing out of many still fails — this is not a count floor', () => {
  // The exact defect a numeric floor cannot express: 15 present, and the one
  // absent is the one that compiles the code.
  const required = [...HEALTHY, 'Rust tests'];
  const r = run({
    required,
    lanes: [...HEALTHY.map((n) => LANE(n)), ...Array.from({ length: 20 }, (_, i) => LANE(`Vercel ${i}`))],
    reviewChecks: [],
  });
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /MISSING_LANES: 1 of 4/);
  assert.match(r.output, /Rust tests/);
});

// -------------------------------------------------------------- fork carve-out

test('a FORK PR reports the missing lanes without failing on them', () => {
  const r = run({
    required: HEALTHY,
    lanes: [LANE('Vercel – ifc-lite'), LANE('CodeRabbit')],
    reviewChecks: [],
    isFork: true,
  });
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /Fork PR: 3 of 3 required lane\(s\) absent/);
  for (const n of HEALTHY) assert.ok(r.output.includes(n));
});

test('the fork carve-out does NOT excuse a review that passed without reviewing', () => {
  const r = run({
    required: HEALTHY,
    lanes: [LANE('CodeRabbit')],
    reviewChecks: [{ name: 'CodeRabbit', state: 'success', description: 'Review rate limited' }],
    isFork: true,
  }, FATAL());
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /NO_VERDICT/);
});

// ------------------------------------------------------------- fail closed

test('FAIL CLOSED: an empty rollup exits 1 as NO_ROLLUP, never 0', () => {
  const r = run({ required: HEALTHY, lanes: [], reviewChecks: [] });
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /NO_ROLLUP/);
});

test('FAIL CLOSED: a missing config exits 1 as NO_CONFIG', () => {
  const r = run(
    { required: HEALTHY, lanes: HEALTHY.map((n) => LANE(n)), reviewChecks: [] },
    ['--config', join(TMP, 'nope.json')],
  );
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /NO_CONFIG/);
});

test('FAIL CLOSED: an EMPTY phrase list exits 1 rather than examining nothing', () => {
  const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
  cfg.phrases = [];
  const path = join(TMP, 'empty-phrases.json');
  writeFileSync(path, JSON.stringify(cfg));
  const r = run(
    { required: HEALTHY, lanes: HEALTHY.map((n) => LANE(n)), reviewChecks: [] },
    ['--config', path],
  );
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /BAD_CONFIG/);
});

test('FAIL CLOSED: an EMPTY reviewer list exits 1 rather than adjudicating nobody', () => {
  const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
  cfg.reviewers = [];
  const path = join(TMP, 'empty-reviewers.json');
  writeFileSync(path, JSON.stringify(cfg));
  const r = run(
    { required: HEALTHY, lanes: HEALTHY.map((n) => LANE(n)), reviewChecks: [] },
    ['--config', path],
  );
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /BAD_CONFIG/);
});

test('FAIL CLOSED: a phrase with no `means` exits 1 — an unactionable failure is a bad failure', () => {
  const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
  cfg.phrases = [{ startsWith: 'Review rate limited' }];
  const path = join(TMP, 'no-means.json');
  writeFileSync(path, JSON.stringify(cfg));
  const r = run({ required: HEALTHY, lanes: HEALTHY.map((n) => LANE(n)), reviewChecks: [] }, [
    '--config',
    path,
  ]);
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /BAD_CONFIG/);
});

test('FAIL CLOSED: a workflow file that does not exist exits 1 as NO_WORKFLOW_TEXT', () => {
  const r = run({ required: HEALTHY, lanes: HEALTHY.map((n) => LANE(n)), reviewChecks: [] }, [
    '--workflow',
    join(TMP, 'no-such-workflow.yml'),
  ]);
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /NO_WORKFLOW_TEXT/);
});

test('FAIL CLOSED: an unknown flag exits 1 rather than being ignored', () => {
  const r = run({ required: HEALTHY, lanes: HEALTHY.map((n) => LANE(n)), reviewChecks: [] }, [
    '--totally-unknown',
  ]);
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /BAD_ARGS/);
});

test('FAIL CLOSED: an unreadable --timeout-seconds exits 1 as BAD_DURATION', () => {
  // `Number('soon')` is NaN, and `now() >= NaN` is false forever: the poll would
  // spin silently until the job's own timeout killed it, leaving the
  // PR with no verdict at all. Unreachable from the shipped workflow, which
  // passes a literal, but a gate about absent output must not have a mode that
  // produces none.
  for (const bad of ['soon', '', '0', '-5', 'NaN', 'Infinity']) {
    const r = run({ required: HEALTHY, lanes: HEALTHY.map((n) => LANE(n)), reviewChecks: [] }, [
      '--timeout-seconds',
      bad,
    ]);
    assert.equal(r.code, 1, `--timeout-seconds ${JSON.stringify(bad)} must exit 1: ${r.output}`);
    assert.match(r.output, /BAD_DURATION/);
  }
  // A readable one still runs, so the guard is not simply rejecting the flag.
  const ok = run({ required: HEALTHY, lanes: HEALTHY.map((n) => LANE(n)), reviewChecks: [] }, [
    '--timeout-seconds',
    '900',
  ]);
  assert.equal(ok.code, 0, ok.output);
});

test('FAIL CLOSED: an unreadable --poll-seconds exits 1 too — a 0 s poll is a busy loop', () => {
  const r = run({ required: HEALTHY, lanes: HEALTHY.map((n) => LANE(n)), reviewChecks: [] }, [
    '--poll-seconds',
    '0',
  ]);
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /BAD_DURATION/);
});

test('FAIL CLOSED: live mode with no --repo and no GITHUB_REPOSITORY exits 1', () => {
  const env = { ...process.env };
  delete env.GITHUB_REPOSITORY;
  const r = spawnSync(process.execPath, [GATE, '--pr', '1', '--self-name', 'x'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(r.status, 1);
  assert.match(`${r.stdout}${r.stderr}`, /NO_REPO/);
});

test('FAIL CLOSED: live mode with no --self-name exits 1 rather than polling itself to death', () => {
  const env = { ...process.env, GITHUB_REPOSITORY: 'o/r' };
  delete env.PR_REVIEW_SIGNAL_SELF_NAME;
  const r = spawnSync(process.execPath, [GATE, '--pr', '1'], { encoding: 'utf8', env });
  assert.equal(r.status, 1);
  assert.match(`${r.stdout}${r.stderr}`, /NO_SELF_NAME/);
});

// ------------------------------------------------------------ chicken-and-egg

test('the gate is not in the lane set it requires — self-exclusion is structural', () => {
  // It derives names from test.yml and lives in pr-review-signal.yml, so it
  // cannot wait on itself. Asserted rather than intended: the failure mode if
  // someone moves the job into test.yml is a job that blocks on its own
  // completion forever, and `SELF_REQUIRED` is the named refusal for that.
  const own = readFileSync(join(REPO_ROOT, '.github/workflows/pr-review-signal.yml'), 'utf8');
  const selfName = /^ {4}name:[ \t]*(.+?)[ \t]*$/m.exec(own)?.[1];
  assert.ok(selfName, 'the gate workflow must give its job an explicit name');
  const testYml = readFileSync(TEST_YML, 'utf8');
  assert.ok(
    !testYml.includes(`name: ${selfName}`),
    `"${selfName}" must not also be a job in test.yml, or the gate would require itself`,
  );
});

test('the gate workflow carries NO `paths:` filter, so its own config cannot dodge it', () => {
  // #3305's gate could not fire on the file it guarded because that file was in
  // no path filter. A presence check that can itself be filtered out has the
  // same defect one level up.
  const own = readFileSync(join(REPO_ROOT, '.github/workflows/pr-review-signal.yml'), 'utf8');
  assert.ok(!/^\s*paths(-ignore)?:/m.test(own), 'pr-review-signal.yml must have no path filter');
  assert.match(own, /types:\s*\[[^\]]*edited/, 'it must fire on `edited`, which is the retarget event');
});


// ------------------------------------------------------------- severity knob


test('the shipped config ships `warn`, and says why next to the value', () => {
  // Not a retreat, and pinned so it cannot drift back silently. A rate-limited
  // CodeRabbit status NEVER self-heals -- the complete history on such a SHA is
  // `queued -> in progress -> success/Review rate limited` and then nothing --
  // so `fail` means red until a human pushes, on 8 of 19 open PRs the day this
  // shipped. That is the `@unwired-by-design` class this repo already ruled on.
  const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
  assert.equal(cfg.reviewVerdictSeverity, 'warn');
  assert.ok(
    Array.isArray(cfg.$reviewVerdictSeverityComment) &&
      cfg.$reviewVerdictSeverityComment.join(' ').includes('@unwired-by-design'),
    'the downgrade must carry its reasoning in the file that carries the value',
  );
});

test('severity "warn" downgrades the REVIEW half to advisory but still reports it', () => {
  const r = run(
    {
      required: HEALTHY,
      lanes: HEALTHY.map((n) => LANE(n)),
      reviewChecks: [{ name: 'CodeRabbit', state: 'success', description: 'Review rate limited' }],
    },
    ['--config', cfgWith({ reviewVerdictSeverity: 'warn' }, 'warn')],
  );
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /NO_VERDICT/, 'a downgrade must still SAY it, or it is a deletion');
  assert.ok(!r.output.includes('❌'), 'nothing may render as a hard failure under warn');
});

test('severity "warn" does NOT downgrade the LANE half - an untested diff is not advisory', () => {
  const r = run({ required: HEALTHY, lanes: [LANE('CodeRabbit')], reviewChecks: [] }, [
    '--config',
    cfgWith({ reviewVerdictSeverity: 'warn' }, 'warn2'),
  ]);
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /MISSING_LANES/);
});

test('FAIL CLOSED: an unrecognised severity exits 1 rather than defaulting to advisory', () => {
  for (const bad of ['FAIL', 'ignore', '', null, undefined]) {
    const r = run(
      { required: HEALTHY, lanes: HEALTHY.map((n) => LANE(n)), reviewChecks: [] },
      ['--config', cfgWith({ reviewVerdictSeverity: bad }, `bad-${String(bad)}`)],
    );
    assert.equal(r.code, 1, `severity ${JSON.stringify(bad)} must be rejected: ${r.output}`);
    assert.match(r.output, /BAD_CONFIG/);
  }
});


// -------------------------------------------- the aggregate, and the budget

test('the shipped config EXCLUDES the `test` aggregate, and the exclusion is the only one', () => {
  // `Build + WASM + Rust + Node` is `needs:` twelve jobs and publishes no check
  // run until every one finishes. Measured by `created_at` -- which is when a
  // lane becomes PRESENT, the thing this gate polls for -- from each run's own
  // creation, over the 68 completed test.yml PR runs of 2026-08-25/26 that
  // published it: min 509 s, median 894 s, max 2067 s, and 33 of the 68 past
  // the 900 s budget then in force. Requiring it would false-fail half of every green PR.
  // The last NON-aggregate lane appeared at 161..845 s over the same runs: 0 of
  // 68 past the budget. Full numbers in scripts/lib/pr-review-signal.test.mjs.
  const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
  assert.deepEqual(cfg.excludeJobKeys, ['test'], 'exactly one job is excluded, and it is the aggregate');
});

test('excluding the aggregate removes THAT lane and nothing else from the required set', () => {
  // The risk of an exclusion list is that it quietly swallows a real lane.
  const yml = readFileSync(TEST_YML, 'utf8');
  const all = expandJobNames(yml, { exclude: [] });
  const shipped = expandJobNames(yml, { exclude: ['test'] });
  assert.deepEqual(
    all.filter((n) => !shipped.includes(n)),
    ['Build + WASM + Rust + Node'],
  );
  for (const n of ['Node tests', 'Rust tests', 'Lint', 'Typecheck', 'Build packages + WASM']) {
    assert.ok(shipped.includes(n), `${n} must still be required`);
  }
});

test('THE #3294 SHAPE STILL FAILS under the shipped exclusion, naming every lane', () => {
  // The exclusion must not blunt the detector it was added to. Total absence of
  // test.yml is still total absence with the aggregate out of the set.
  const r = run({
    // No `required`: this drives the REAL derived set from the REAL test.yml
    // through the REAL shipped config, exclusion included.
    lanes: [
      LANE('parity (in-tree fixtures, committed reference)'),
      LANE('full corpus (pinned reference engine)', 'skipped'),
      LANE('Vercel Agent Review', 'neutral'),
      LANE('CodeRabbit'),
      LANE('Vercel Preview Comments'),
      LANE('Vercel – ifc-lite'),
      LANE('Vercel – ifc-lite-dev'),
      LANE('Vercel – ifc-lite-viewer-embed'),
    ],
    reviewChecks: [],
  });
  assert.equal(r.code, 1, r.output);
  const expected = expandJobNames(readFileSync(TEST_YML, 'utf8'), { exclude: ['test'] });
  assert.match(r.output, new RegExp(`MISSING_LANES: ${expected.length} of ${expected.length}`));
  for (const n of expected) assert.ok(r.output.includes(n), `must name the missing lane ${n}`);
  assert.ok(
    !r.output.includes('Build + WASM + Rust + Node'),
    'the excluded aggregate must not be named as missing',
  );
});

// ------------------------------------------- WHICH absence, and which remedy

test('TOTAL absence gets the RETARGET remedy: push an empty commit', () => {
  const r = run({ required: HEALTHY, lanes: [LANE('CodeRabbit')], reviewChecks: [] });
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /NOT ONE lane from test\.yml appeared/);
  assert.match(r.output, /retargeted to main does NOT fire test\.yml retroactively/);
  assert.match(r.output, /Push an empty commit/);
});

test('PARTIAL absence must NOT be diagnosed as a retarget — the live #3301 misdiagnosis', () => {
  // #3301 was named `MISSING_LANES: Rust crate semver` and told to push an
  // empty commit. There was no retarget: #3298 added `rust-semver` to test.yml
  // AFTER that head, so the lane could not exist there and re-firing the same
  // workflow file would produce the same absence. The verdict was defensible;
  // the remedy was advice that cannot work.
  const r = run({
    required: [...HEALTHY, 'Rust crate semver'],
    lanes: HEALTHY.map((n) => LANE(n)),
    reviewChecks: [],
  });
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /MISSING_LANES: 1 of 4/);
  assert.match(r.output, /test\.yml DID fire for this head — 3 of 4 lanes are present/);
  assert.match(r.output, /NOT the #3294 retarget/);
  assert.match(r.output, /can be NEWER than your PR head/);
  assert.ok(
    !/Push an empty commit/.test(r.output),
    'the retarget remedy must not appear on a partial absence: it cannot work',
  );
  assert.ok(!/close and reopen/.test(r.output));
});

test('the two diagnoses are mutually exclusive — no rollup gets both', () => {
  for (const lanes of [[LANE('CodeRabbit')], HEALTHY.slice(0, 2).map((n) => LANE(n))]) {
    const r = run({ required: HEALTHY, lanes, reviewChecks: [] });
    const total = /NOT ONE lane from test\.yml appeared/.test(r.output);
    const partial = /test\.yml DID fire for this head/.test(r.output);
    assert.ok(total !== partial, `exactly one diagnosis, got total=${total} partial=${partial}`);
  }
});

// ---------------------------------------------------- one repository, two reads

/**
 * A stand-in `gh` that records every argv it is handed and answers the three
 * reads the live path makes. Placed first on PATH, so the gate spawns it
 * instead of the real client and no network is touched.
 */
function fakeGh(tag) {
  const dir = join(TMP, `gh-${tag}`);
  mkdirSync(dir, { recursive: true });
  const log = join(dir, 'argv.log');
  const sha = 'a'.repeat(40);
  writeFileSync(
    join(dir, 'gh'),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      'case "$1 $2" in',
      `  "pr view") printf '%s' '{"headRefOid":"${sha}","isCrossRepository":false,` +
        '"statusCheckRollup":[{"name":"Only Lane","conclusion":"success"}]}\' ;;',
      "  *) printf '%s' '[]' ;;",
      'esac',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { dir, log, sha };
}

test('the resolved repo reaches the PR read, not just the commit-status reads', () => {
  // The bug: `repo` was resolved from `--repo` ?? GITHUB_REPOSITORY and handed
  // to the status reads, while the PR read got the raw `--repo` flag — null
  // whenever only the environment variable is set, which is exactly CI. `gh pr
  // view` then resolved the repository from the checked-out git remote, so the
  // rollup and the review descriptions could describe two different
  // repositories, and the PR read failed outright outside a git checkout.
  const { dir, log, sha } = fakeGh('resolved');
  const workflow = join(TMP, 'one-lane.yml');
  writeFileSync(workflow, 'jobs:\n  only:\n    name: Only Lane\n');

  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  env.GITHUB_REPOSITORY = 'owner/from-env';
  delete env.PR_REVIEW_SIGNAL_SELF_NAME;

  const r = spawnSync(
    process.execPath,
    [GATE, '--pr', '7', '--self-name', 'PR review signal', '--workflow', workflow],
    { encoding: 'utf8', env, cwd: TMP },
  );
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);

  const calls = readFileSync(log, 'utf8').trim().split('\n');
  const prRead = calls.filter((c) => c.startsWith('pr view'));
  assert.equal(prRead.length, 1, `expected exactly one PR read, got:\n${calls.join('\n')}`);
  // Every read names the SAME repository, and names it explicitly. `gh` must
  // never be left to infer one from the cwd remote.
  for (const c of calls) {
    assert.ok(
      c.includes('owner/from-env'),
      `\`gh ${c}\` does not carry the resolved repository — it would resolve one from the cwd`,
    );
  }
  assert.ok(prRead[0].includes('--repo owner/from-env'), prRead[0]);
  assert.ok(
    calls.some((c) => c.includes(`repos/owner/from-env/commits/${sha}/status`)),
    `commit-status read missing from:\n${calls.join('\n')}`,
  );
  assert.ok(
    calls.some((c) => c.includes(`repos/owner/from-env/commits/${sha}/check-runs`)),
    `check-runs read missing from:\n${calls.join('\n')}`,
  );
});


test('the gate carries NO base-branch filter, so a stacked PR cannot dodge it (#3429)', () => {
  // #3429: this job used to carry the SAME `branches: [main]` filter as
  // test.yml, on the reasoning that widening it would fail every stacked PR
  // "for a reason that is not a defect" -- every lane test.yml would have
  // published is legitimately absent on a feature-targeted PR. That reasoning
  // is exactly backwards for what this gate exists to do: "legitimately
  // absent" is the fact a reviewer needs surfaced, not a reason to suppress
  // the one job that surfaces it. #3405 and #3428 (both stacked) ran ZERO
  // test.yml lanes and their check lists showed passes and skips only --
  // nothing said "nothing ran", because this gate did not run either.
  //
  // So test.yml keeps `branches: [main]` (a stacked PR should not pay for the
  // whole suite on every push) while THIS job must run on every base, so it
  // can observe a stacked PR's total lane absence and fail loud rather than
  // being silently skipped alongside it. Pinned rather than reasoned about in
  // a comment, because the two files are edited independently.
  //
  // #3433: a text regex here (`/^\s*branches:\s*(\[.*\])\s*$/m`) caught the
  // inline `branches: [main]` spelling but not the equivalent block form
  // (`branches:\n  - main`), so the guard this test IS could itself be
  // defeated by reformatting. Parsed structurally instead -- see
  // `pullRequestBranchFilterKeys` for every spelling this now covers.
  const own = readFileSync(join(REPO_ROOT, '.github/workflows/pr-review-signal.yml'), 'utf8');
  const testYml = readFileSync(TEST_YML, 'utf8');
  assert.deepEqual(
    pullRequestBranchFilterKeys(own),
    [],
    'pr-review-signal.yml must not declare a base-branch filter -- it has to run on stacked PRs to catch them',
  );
  assert.ok(
    pullRequestBranchFilterKeys(testYml).length > 0,
    'test.yml is expected to keep its own base-branch filter; this test documents the asymmetry, not test.yml\'s scope',
  );
});

// ------------------------------------ PART 3: review staleness, as a process

/**
 * PR #3276 as the gate sees it: louistrue's example in #3312.
 *
 * Head `1305f778`, `CodeRabbit :: success / Review completed` on that head, and
 * CodeRabbit's newest review event naming `c26e453d`. Parts 1 and 2 are
 * deliberately CLEAN here — that is the whole point: this PR passed everything
 * the gate could previously ask, which is why staleness needed building.
 */
const HEAD_3276 = '1305f778c0dc817bb344e23f881c2a30963c14c2';
const OLD_3276 = 'c26e453d00000000000000000000000000000000';
const REVIEW_3276 = (commitId) => ({
  id: 5030520937,
  user: { login: 'coderabbitai[bot]' },
  state: 'COMMENTED',
  commit_id: commitId,
  submitted_at: '2026-08-26T12:46:19Z',
});
const COMPLETED_3276 = [
  { name: 'CodeRabbit', state: 'success', description: 'Review completed' },
];
const STATE_3276 = (commitId) => ({
  required: HEALTHY,
  lanes: HEALTHY.map((n) => LANE(n)),
  reviewChecks: COMPLETED_3276,
  reviews: [REVIEW_3276(commitId)],
  headSha: HEAD_3276,
});

/**
 * PART 3 OPTED IN.
 *
 * The SHIPPED default is `off` — see the config's premise note: CodeRabbit
 * submits no review event when a run finds nothing actionable, so 2 of
 * `claimed-verdict`'s 4 live fires were false. The rule still ships, and every
 * test below that exercises it therefore says so explicitly rather than
 * inheriting a default. The `off` behaviour is asserted separately.
 */
const ON = (patch = {}, tag = 'part3-on') => [
  '--config',
  cfgWith({ staleReviewPolicy: 'claimed-verdict', ...patch }, tag),
];

/** The staleness knob forced to `fail`, as `FATAL` does for part 2. */
const FATAL_STALE = () => ON({ staleReviewSeverity: 'fail' }, 'fatal-stale');

test('the #3276 shape: lanes clean, no-verdict clean, and the review still names an older commit', () => {
  const r = run(STATE_3276(OLD_3276), ON());
  assert.match(r.output, /All 3 required lane\(s\)/);
  assert.match(r.output, /none reports a passing state over a review it did not perform/);
  assert.match(r.output, /STALE_REVIEW: `CodeRabbit`/);
  assert.match(r.output, /newest review is of c26e453d/);
  assert.match(r.output, /not of the head 1305f778/);
  // `warn` is the shipped default, so the PR is not held red on it.
  assert.equal(r.code, 0, r.output);
});

test('ANTI-VACUITY: the identical PR with the review AT the head reports no staleness', () => {
  // #3315, #3309 and #2931 live. Without this, an implementation that always
  // reports stale passes the test above.
  const r = run(STATE_3276(HEAD_3276), ON());
  assert.doesNotMatch(r.output, /STALE_REVIEW/);
  assert.match(r.output, /No reviewer claims a verdict on 1305f778 from a review of an older commit/);
  assert.match(r.output, /policy: claimed-verdict/);
  assert.equal(r.code, 0, r.output);
});

test('ESCALATION: `staleReviewSeverity: fail` turns the same finding red', () => {
  const red = run(STATE_3276(OLD_3276), FATAL_STALE());
  assert.equal(red.code, 1, red.output);
  assert.match(red.output, /❌ STALE_REVIEW/);
  // …and the escalated config still passes the current-review case, so the
  // exit code is tracking the finding rather than the flag.
  const green = run(STATE_3276(HEAD_3276), FATAL_STALE());
  assert.equal(green.code, 0, green.output);
});

test('the SHIPPED default for part 3 is `off`, and `off` NEVER prints a tick', () => {
  const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
  assert.equal(cfg.staleReviewSeverity, 'warn');
  assert.equal(cfg.staleReviewPolicy, 'off');

  // #3276's own shape, the one `claimed-verdict` fires on, under the shipped
  // config. It must say the question was not asked — not answer it.
  const r = run(STATE_3276(OLD_3276));
  assert.doesNotMatch(r.output, /No reviewer claims a verdict/, 'a tick nobody earned');
  assert.doesNotMatch(r.output, /STALE_REVIEW: /);
  assert.match(r.output, /STALE_REVIEW not adjudicated/);
  assert.match(r.output, /`staleReviewPolicy` is "off"/);
  assert.equal(r.code, 0, r.output);

  // MUTATION GUARD: `off` is inert, not merely silent. Under `claimed-verdict`
  // each of these is a refusal (asserted below); under `off` the gate does not
  // fall over on a question it never asks.
  const inert = runRaw({ required: HEALTHY, lanes: HEALTHY.map((n) => LANE(n)) });
  assert.equal(inert.code, 0, inert.output);
  assert.match(inert.output, /STALE_REVIEW not adjudicated/);
  assert.doesNotMatch(inert.output, /NO_REVIEWS|NO_HEAD_SHA/);
});

test('NO NAG: a reviewer with no review event and a `Review completed` status is silent', () => {
  // #3316 and #3205 verbatim: `CodeRabbit :: success / Review completed` and
  // zero review events. A stated hole, not an oversight.
  const r = run({ ...STATE_3276(OLD_3276), reviews: [] }, ON());
  assert.doesNotMatch(r.output, /STALE_REVIEW/);
  assert.equal(r.code, 0, r.output);
});

test('DEDUPE: a suppressed finding is said ONCE and still moves the exit code', () => {
  // RED, verbatim, before the fix: this exact input with `staleReviewSeverity`
  // forced to `fail` printed
  //   ✅ No reviewer claims a verdict on 1305f778 from a review of an older commit
  // and exited 0, while the same input under `configured-authors` printed
  //   ❌ STALE_REVIEW: `CodeRabbit` …
  // and exited 1. The dedupe made the severity knob inoperative and rendered a
  // suppressed finding as a clean pass — the defect class this gate exists to
  // remove.
  const rateLimited = {
    ...STATE_3276(OLD_3276),
    reviewChecks: [{ name: 'CodeRabbit', state: 'success', description: 'Review rate limited' }],
  };
  const r = run(rateLimited, FATAL_STALE());
  assert.match(r.output, /NO_VERDICT: `CodeRabbit`/);
  // A tick is the one thing it must never print here.
  assert.doesNotMatch(r.output, /No reviewer claims a verdict/);
  // Said once: the full three-line staleness paragraph is NOT repeated…
  assert.doesNotMatch(r.output, /reads as having reviewed this PR/);
  // …but the finding is stated, and it names what already reported it.
  assert.match(r.output, /STALE_REVIEW: `CodeRabbit` is ALSO stale/);
  assert.match(r.output, /reported above as `CodeRabbit`/);
  assert.match(r.output, /Re-run the reviewer on the head/);
  // And the knob is operative: `fail` is red.
  assert.equal(r.code, 1, r.output);

  // ANTI-VACUITY, both ways. Same rate-limited input with the review AT the
  // head is genuinely clean and prints the tick it earned…
  const clean = run(
    { ...rateLimited, reviews: [REVIEW_3276(HEAD_3276)] },
    FATAL_STALE(),
  );
  assert.match(clean.output, /No reviewer claims a verdict/);
  assert.doesNotMatch(clean.output, /STALE_REVIEW/);
  assert.equal(clean.code, 0, clean.output);
  // …and at the shipped `warn` the suppressed finding is a warning, not red,
  // so the exit code tracks the knob rather than the branch.
  const warned = run(rateLimited, ON());
  assert.match(warned.output, /STALE_REVIEW: `CodeRabbit` is ALSO stale/);
  assert.equal(warned.code, 0, warned.output);
});

// ------------------------------------------------- fail-closed, as a process

test('FAIL CLOSED: a state file that omits `reviews` gets NO_REVIEWS, not a success line', () => {
  // THE BRANCH IT IS TEMPTING TO SKIP. `--state-file` mode is the harness's own
  // path, and the last defect in this file was exactly that path quietly
  // supplying a value (`timedOut: false`) the real path computes. Defaulting
  // `reviews` to `[]` inside the gate would repeat it.
  const r = runRaw(
    { required: HEALTHY, lanes: HEALTHY.map((n) => LANE(n)), headSha: HEAD_3276 },
    ON(),
  );
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /NO_REVIEWS/);
  assert.doesNotMatch(r.output, /No reviewer claims a verdict/);
});

test('FAIL CLOSED: a state file that omits `headSha` gets NO_HEAD_SHA', () => {
  const r = runRaw(
    { required: HEALTHY, lanes: HEALTHY.map((n) => LANE(n)), reviews: [] },
    ON(),
  );
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /NO_HEAD_SHA/);
  assert.doesNotMatch(r.output, /No reviewer claims a verdict/);
});

test('FAIL CLOSED: an unreadable `commit_id` refuses instead of comparing an older review', () => {
  const r = run({ ...STATE_3276(OLD_3276), reviews: [REVIEW_3276('c26e453d')] }, ON());
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /UNREADABLE_COMMIT_ID/);
});

test('FAIL CLOSED: an unrecognised `staleReviewPolicy` is BAD_CONFIG, never a silent downgrade', () => {
  for (const bad of [undefined, 'strict', '']) {
    const cfg = cfgWith({ staleReviewPolicy: bad }, `policy-${JSON.stringify(bad)}`);
    const r = run(STATE_3276(HEAD_3276), ['--config', cfg]);
    assert.equal(r.code, 1, r.output);
    assert.match(r.output, /BAD_CONFIG/);
    assert.match(r.output, /staleReviewPolicy/);
  }
});

test('FAIL CLOSED: an unrecognised `staleReviewSeverity` is BAD_CONFIG', () => {
  for (const bad of [undefined, 'advisory']) {
    const cfg = cfgWith({ staleReviewSeverity: bad }, `sev-${JSON.stringify(bad)}`);
    const r = run(STATE_3276(HEAD_3276), ['--config', cfg]);
    assert.equal(r.code, 1, r.output);
    assert.match(r.output, /staleReviewSeverity/);
  }
});

test('FAIL CLOSED: an empty or malformed `reviewAuthors` refuses', () => {
  const empty = cfgWith({ reviewAuthors: [] }, 'authors-empty');
  const e = run(STATE_3276(HEAD_3276), ['--config', empty]);
  assert.equal(e.code, 1, e.output);
  assert.match(e.output, /EMPTY_REVIEW_AUTHORS/);

  // A `context`-less entry is inert under the default policy, which is the
  // shape that would quietly stop covering a reviewer somebody configured.
  const noContext = cfgWith(
    { reviewAuthors: [{ login: 'coderabbitai[bot]' }] },
    'authors-no-context',
  );
  const n = run(STATE_3276(HEAD_3276), ['--config', noContext]);
  assert.equal(n.code, 1, n.output);
  assert.match(n.output, /needs a non-empty `context`/);

  const noLogin = cfgWith({ reviewAuthors: [{ context: 'CodeRabbit' }] }, 'authors-no-login');
  const l = run(STATE_3276(HEAD_3276), ['--config', noLogin]);
  assert.equal(l.code, 1, l.output);
  assert.match(l.output, /needs a non-empty `login`/);
});

test('WIRING: both API walks are paginated AND flattened through the refusing helper', () => {
  // NOT reachable through `--state-file`, which is exactly why it is asserted
  // over the source. A mutation that replaced `flattenCheckRunPages(pages, …)`
  // with an inline `pages.flatMap((p) => p.check_runs ?? [])` survived the
  // whole suite: the helper's refusal is tested, its USE was not. Both walks
  // are covered, because the same hole existed on the reviews side.
  const src = readFileSync(GATE, 'utf8');
  const fn = (name) => {
    const at = src.indexOf(`function ${name}(`);
    assert.ok(at > 0, `${name} exists`);
    return src.slice(at, src.indexOf('\n}\n', at));
  };
  for (const [name, helper] of [
    ['fetchCheckRunDescriptions', 'flattenCheckRunPages'],
    ['fetchReviews', 'flattenReviewPages'],
  ]) {
    // Comments in these bodies legitimately NAME the fields, so compare code.
    const body = fn(name)
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    // A truncated walk drops rows silently — a false NEGATIVE for part 2 and a
    // false POSITIVE for part 3 — so neither may rest on a `per_page` guess.
    assert.match(body, /'--paginate'/, `${name} must paginate`);
    // `--slurp` is what keeps the page boundaries visible, and it is the only
    // reason the helper can tell a short page from a stopped walk.
    assert.match(body, /'--slurp'/, `${name} must slurp`);
    assert.match(body, new RegExp(`${helper}\\(`), `${name} must flatten via ${helper}`);
    // …and must not hand-roll the flatten around it.
    assert.doesNotMatch(body, /flatMap|\.check_runs\b/, `${name} must not inline the flatten`);
  }
});

test('POLICY: `all-authors` is reachable through the config and changes the answer', () => {
  // Proves the knob is wired end to end rather than merely validated: the same
  // state file, clean under the default, is a finding under `all-authors`.
  const state = {
    required: HEALTHY,
    lanes: HEALTHY.map((n) => LANE(n)),
    reviewChecks: [],
    reviews: [
      {
        id: 10,
        user: { login: 'louistrue' },
        state: 'APPROVED',
        commit_id: OLD_3276,
        submitted_at: '2026-08-26T12:46:19Z',
      },
    ],
    headSha: HEAD_3276,
  };
  // Clean under `claimed-verdict` (no configured context claims a verdict) —
  // compared against `claimed-verdict` explicitly, not against the shipped
  // `off`, which would make the contrast trivially true for the wrong reason.
  const dflt = run(state, ON());
  assert.doesNotMatch(dflt.output, /STALE_REVIEW/);

  const all = run(state, ['--config', cfgWith({ staleReviewPolicy: 'all-authors' }, 'all')]);
  assert.match(all.output, /STALE_REVIEW: `louistrue`/);
  // The finding names the scoping rule that produced it — a staleness warning
  // read without its policy is a policy nobody can argue with.
  assert.match(all.output, /Scoping policy: `all-authors`/);
});

test('FAIL CLOSED: a bad `staleReviewPolicy` is caught EAGERLY, not masked by the PR state', () => {
  // `staleReviews` validates the policy too, so a test that only drives the
  // happy-path state file passes with the config-read guard deleted — a
  // mutation check caught exactly that. The guard's job is to reject a config
  // TYPO as a config typo, before anything else about the PR can throw first.
  // An empty rollup makes part 1 throw NO_ROLLUP, so the lazy path can no
  // longer be the one producing the message.
  const cfg = cfgWith({ staleReviewPolicy: 'strict' }, 'policy-eager');
  const r = runRaw({ required: HEALTHY, lanes: [] }, ['--config', cfg]);
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /BAD_CONFIG/);
  assert.match(r.output, /staleReviewPolicy/);
  assert.doesNotMatch(r.output, /NO_ROLLUP/, 'the config is read before the rollup is judged');

  // Same for the severity knob, and same reason.
  const sev = cfgWith({ staleReviewSeverity: 'advisory' }, 'sev-eager');
  const s = runRaw({ required: HEALTHY, lanes: [] }, ['--config', sev]);
  assert.equal(s.code, 1, s.output);
  assert.match(s.output, /staleReviewSeverity/);
  assert.doesNotMatch(s.output, /NO_ROLLUP/);

  // …and for an empty `reviewAuthors`, which `staleReviews` also rejects — so
  // without the empty rollup this assertion would pass with the config-read
  // guard deleted. The mutation sweep caught exactly that.
  const authors = cfgWith({ reviewAuthors: [] }, 'authors-eager');
  const a = runRaw({ required: HEALTHY, lanes: [] }, ['--config', authors]);
  assert.equal(a.code, 1, a.output);
  assert.match(a.output, /EMPTY_REVIEW_AUTHORS/);
  assert.doesNotMatch(a.output, /NO_ROLLUP/);
});
