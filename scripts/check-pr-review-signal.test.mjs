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

import { expandJobNames } from './lib/pr-review-signal.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const GATE = join(HERE, 'check-pr-review-signal.mjs');
const CONFIG = join(HERE, 'pr-review-signal.config.json');
const TEST_YML = join(REPO_ROOT, '.github/workflows/test.yml');

const TMP = mkdtempSync(join(tmpdir(), 'pr-review-signal-'));
let seq = 0;

/** Run the gate over a synthetic rollup. */
function run(state, extra = []) {
  const path = join(TMP, `state-${(seq += 1)}.json`);
  writeFileSync(path, JSON.stringify(state));
  const r = spawnSync(process.execPath, [GATE, '--state-file', path, ...extra], {
    encoding: 'utf8',
  });
  return { code: r.status, output: `${r.stdout}${r.stderr}` };
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
  // spin silently until the job's own 20-minute timeout killed it, leaving the
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
  // the 900 s budget. Requiring it would false-fail half of every green PR.
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
