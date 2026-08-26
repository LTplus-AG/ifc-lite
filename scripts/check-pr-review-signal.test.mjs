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
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const r = run({
    required: HEALTHY,
    lanes: HEALTHY.map((n) => LANE(n)),
    reviewChecks: [{ name: 'CodeRabbit', state: 'success', description: 'Review rate limited' }],
  });
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /NO_VERDICT: `CodeRabbit` reports a PASSING state/);
  assert.match(r.output, /"Review rate limited"/);
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
  });
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

/** Write a config variant and return its path. */
function cfgWith(patch, tag) {
  const cfg = { ...JSON.parse(readFileSync(CONFIG, 'utf8')), ...patch };
  const path = join(TMP, `cfg-${tag}.json`);
  writeFileSync(path, JSON.stringify(cfg));
  return path;
}

test('the shipped config ships `fail`, as requested on #3312', () => {
  assert.equal(JSON.parse(readFileSync(CONFIG, 'utf8')).reviewVerdictSeverity, 'fail');
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
