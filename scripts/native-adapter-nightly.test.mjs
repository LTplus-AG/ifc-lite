/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The nightly native-adapter coverage record and its bisect, driven through
// the real CLIs (scripts/native-adapter-nightly.mjs, native-adapter-bisect.mjs)
// against temporary git histories and a fake `gh` on PATH that serves canned
// run and job listings and records every call. A revert of either CLI turns
// these red rather than failing to load.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';
import { audit } from './check-native-adapter-triggers.mjs';

const REPO = join(import.meta.dirname, '..');
const RANGE = join(REPO, 'scripts/native-adapter-nightly.mjs');
const BISECT = join(REPO, 'scripts/native-adapter-bisect.mjs');
const TITLE = 'ci: scheduled Geometry platform (native adapter) lane failed';

// A hook's GIT_DIR or GIT_INDEX_FILE would point git -C at the real repository.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

/** A main branch of a base commit plus one commit per entry of `files`; returns { root, shas: [base, ...] }. */
function linearRepo(context, files) {
  const root = mkdtempSync(join(tmpdir(), 'native-adapter-nightly-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => {
    const r = spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env: cleanEnv() });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  const shas = [];
  for (const file of ['README.md', ...files]) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), `${file}\n`);
    git('add', '-A');
    git('commit', '-q', '-m', `touch ${file}`);
    shas.push(git('rev-parse', 'HEAD'));
  }
  return { root, shas, git };
}

// The fake `gh`: `api <path>` answers from world.api (404 otherwise), the
// listings from world.issues/labels, `run download` writes world.record; every
// call is appended to the log. CommonJS, so it runs without a package.json.
const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs');
const world = JSON.parse(fs.readFileSync(process.env.FAKE_GH_WORLD, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');
const [a, b] = args;
if (a === 'api') {
  if (!(b in world.api)) { process.stderr.write('HTTP 404: ' + b + '\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify(world.api[b]));
} else if (a === 'issue' && b === 'list') process.stdout.write(JSON.stringify(world.issues || []));
else if (a === 'label' && b === 'list') process.stdout.write(JSON.stringify(world.labels || []));
else if (a === 'run' && b === 'download') {
  if (!world.record) { process.stderr.write('no artifact matches name nightly-range\\n'); process.exit(1); }
  fs.writeFileSync(args[args.indexOf('--dir') + 1] + '/nightly-range.json', JSON.stringify(world.record));
}
`;

/** Parses $GITHUB_OUTPUT, heredoc values included. */
function outputs(text) {
  const out = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^([\w-]+)(?:<<(\S+)|=(.*))$/); // @source-text-assertion-ok subject is the CLI's own output
    if (!m) continue;
    if (m[3] !== undefined) {
      out[m[1]] = m[3];
      continue;
    }
    let end = i + 1;
    while (end < lines.length && lines[end] !== m[2]) end += 1;
    out[m[1]] = lines.slice(i + 1, end).join('\n');
    i = end;
  }
  return out;
}

/** Runs `script args` in `cwd` against `world`; returns its status, outputs and the gh calls it made. */
function run(context, script, args, { cwd, env = {}, world = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'native-adapter-nightly-run-'));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin/gh'), FAKE_GH);
  chmodSync(join(dir, 'bin/gh'), 0o755);
  writeFileSync(join(dir, 'world.json'), JSON.stringify({ api: {}, ...world }));
  for (const f of ['output', 'summary', 'gh.log']) writeFileSync(join(dir, f), '');
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...cleanEnv(),
      PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH}`,
      FAKE_GH_WORLD: join(dir, 'world.json'),
      FAKE_GH_LOG: join(dir, 'gh.log'),
      GITHUB_OUTPUT: join(dir, 'output'),
      GITHUB_STEP_SUMMARY: join(dir, 'summary'),
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_SERVER_URL: 'https://github.com',
      ...env,
    },
  });
  const calls = readFileSync(join(dir, 'gh.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { status: r.status, stdout: r.stdout, outputs: outputs(readFileSync(join(dir, 'output'), 'utf8')), calls, dir };
}

const job = (name, conclusion) => ({ name, conclusion });
const FULL_GREEN = [job('native-adapter', 'success'), job('Native corpus (shard 0/2)', 'success'), job('Native corpus (shard 1/2)', 'success'), job('Native corpus result', 'success')];
const RUNS = (page) => `repos/o/r/actions/workflows/geometry-platform.yml/runs?branch=main&status=completed&per_page=100&page=${page}`;
const JOBS = (id) => `repos/o/r/actions/runs/${id}/jobs?filter=latest&per_page=100`;
/** A world serving `runs` on one page and each run's jobs. */
const runWorld = (runs, jobsById) => ({ api: { [RUNS(1)]: { workflow_runs: runs }, ...Object.fromEntries(Object.entries(jobsById).map(([id, jobs]) => [JOBS(id), { jobs }])) } });

function range(context, cwd, head, world, runId = '99') {
  const r = run(context, RANGE, ['range', '--out', 'record.json'], { cwd, env: { GITHUB_SHA: head, GITHUB_RUN_ID: runId }, world });
  const record = existsSync(join(cwd, 'record.json')) ? JSON.parse(readFileSync(join(cwd, 'record.json'), 'utf8')) : null;
  rmSync(join(cwd, 'record.json'), { force: true });
  return { ...r, record };
}

// ------------------------------------------------------------ the coverage range

test('the record is the newest green FULL run on main, never a PR, branch, partial or red run', (context) => {
  const { root, shas } = linearRepo(context, ['a', 'b', 'c']);
  const runs = [
    { id: 8, head_branch: 'main', event: 'pull_request', head_sha: shas[3] }, // a fork PR from a branch named main
    { id: 7, head_branch: 'feature', event: 'workflow_dispatch', head_sha: shas[3] },
    { id: 6, head_branch: 'main', event: 'workflow_dispatch', head_sha: shas[3] }, // dispatched without the corpus
    { id: 5, head_branch: 'main', event: 'schedule', head_sha: shas[2] }, // red
    { id: 4, head_branch: 'main', event: 'schedule', head_sha: shas[1], html_url: 'https://x/run/4' },
    { id: 3, head_branch: 'main', event: 'schedule', head_sha: shas[0] },
  ];
  const world = runWorld(runs, { 8: FULL_GREEN, 7: FULL_GREEN, 6: [job('native-adapter', 'success')], 5: [job('native-adapter', 'success'), job('Native corpus result', 'failure')], 4: FULL_GREEN, 3: FULL_GREEN });
  const r = range(context, root, shas[3], world);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.outputs.last_green, shas[1]);
  assert.deepEqual(r.calls.map((c) => c[1]), [RUNS(1), JOBS(6), JOBS(5), JOBS(4)], 'only main full-run candidates are looked up, and the scan stops at the first green one');
  // The current run is never its own record.
  const self = range(context, root, shas[3], runWorld([{ id: 99, head_branch: 'main', event: 'schedule', head_sha: shas[3] }, ...runs.slice(4)], { 99: FULL_GREEN, 4: FULL_GREEN }));
  assert.equal(self.outputs.last_green, shas[1]);
  // A re-run of an older red run keeps its old commit: a green run created after it is no record for it.
  const rerun = range(context, root, shas[2], runWorld([{ id: 120, head_branch: 'main', event: 'schedule', head_sha: shas[3] }, ...runs.slice(4)], { 120: FULL_GREEN, 4: FULL_GREEN }), '110');
  assert.equal(rerun.status, 0, rerun.stdout);
  assert.equal(rerun.outputs.last_green, shas[1]);
  // An unset run id hides nothing rather than every run.
  const unset = range(context, root, shas[3], runWorld(runs.slice(4), { 4: FULL_GREEN }), '');
  assert.equal(unset.outputs.last_green, shas[1]);
});

test('a run covers every commit since the last green full run, red and missing nights included', (context) => {
  const { root, shas } = linearRepo(context, ['n1', 'n2', 'n3', 'n4']);
  // Green at shas[1]; the nights at shas[2] (red) and shas[3] (cancelled) covered nothing.
  const runs = [
    { id: 3, head_branch: 'main', event: 'schedule', head_sha: shas[3] },
    { id: 2, head_branch: 'main', event: 'schedule', head_sha: shas[2] },
    { id: 1, head_branch: 'main', event: 'schedule', head_sha: shas[1], html_url: 'https://x/run/1' },
  ];
  const world = runWorld(runs, { 3: [job('native-adapter', 'cancelled')], 2: [job('native-adapter', 'failure'), job('Native corpus result', 'success')], 1: FULL_GREEN });
  const r = range(context, root, shas[4], world);
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual({ head: r.outputs.head, last_green: r.outputs.last_green, count: r.outputs.count }, { head: shas[4], last_green: shas[1], count: '3' });
  assert.deepEqual(r.record.commits.map((c) => c.sha), shas.slice(2), 'the artifact the bisect reads lists the same commits');
  assert.match(r.outputs.detail, /covers 3 first-parent commit\(s\) on main since the last green full run/); // @source-text-assertion-ok subject is the CLI's own output
  assert.ok(r.outputs.detail.includes(`https://github.com/o/r/compare/${shas[1]}...${shas[4]}`), r.outputs.detail); // @source-text-assertion-ok subject is the CLI's own output
  assert.ok(r.outputs.detail.includes('touch n2'), 'the issue names each commit'); // @source-text-assertion-ok subject is the CLI's own output
  assert.match(readFileSync(join(r.dir, 'summary'), 'utf8'), /## Nightly coverage range/); // @source-text-assertion-ok subject is the CLI's own output
  // Main did not move: the run still re-checks HEAD, and says so.
  const same = range(context, root, shas[1], world);
  assert.equal(same.outputs.count, '0');
  assert.match(same.outputs.detail, /^No commits on main since the last green full run/); // @source-text-assertion-ok subject is the CLI's own output
});

test('no record, or a record main no longer holds, fails with a reason instead of covering a guessed range', (context) => {
  const { root, shas, git } = linearRepo(context, ['a']);
  const red = [3, 2, 1].map((id) => ({ id, head_branch: 'main', event: 'schedule', head_sha: shas[0] }));
  const none = range(context, root, shas[1], runWorld(red, { 3: [job('native-adapter', 'failure')], 2: [job('native-adapter', 'cancelled')], 1: [job('Native corpus result', 'failure')] }));
  assert.equal(none.status, 1);
  assert.equal(none.record, null);
  assert.match(none.outputs.detail, /no green full run of .* on main in its last 300 completed runs/); // @source-text-assertion-ok subject is the CLI's own output
  assert.deepEqual(none.calls.map((c) => c[1]), [RUNS(1), JOBS(3), JOBS(2), JOBS(1)], 'a short page ends the scan');
  // A green run on a commit that is not on main's history.
  git('checkout', '-q', '-b', 'side', shas[0]);
  writeFileSync(join(root, 'side.txt'), 'x\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'side');
  const orphan = git('rev-parse', 'HEAD');
  const rewritten = range(context, root, shas[1], runWorld([{ id: 1, head_branch: 'main', event: 'schedule', head_sha: orphan, html_url: 'u' }], { 1: FULL_GREEN }));
  assert.equal(rewritten.status, 1);
  assert.match(rewritten.outputs.detail, /is not an ancestor of .*main was rewritten/); // @source-text-assertion-ok subject is the CLI's own output
});

test('#10619: every path BATCH_EXCLUDE takes off merge-queue batches lands in the nightly range', (context) => {
  // Read through a child, so a revert of the batch module reads as an empty list here, not a load error.
  const listed = spawnSync(process.execPath, ['--input-type=module', '-e', `import { BATCH_EXCLUDE } from ${JSON.stringify(join(REPO, 'scripts/lib/native-adapter-batch.mjs'))}; console.log(JSON.stringify(BATCH_EXCLUDE));`], { encoding: 'utf8' });
  const excluded = listed.status === 0 ? JSON.parse(listed.stdout) : [];
  assert.ok(excluded.length > 0, 'BATCH_EXCLUDE is readable and non-empty');
  // The nightly route around the range is intact: unfiltered schedule, whole lane, record, report and bisect.
  assert.deepEqual(audit(REPO), []);
  const files = excluded.map((glob) => glob.replaceAll('**', 'x/x').replaceAll('*', 'x'));
  const { root, shas } = linearRepo(context, files);
  const r = range(context, root, shas.at(-1), runWorld([{ id: 1, head_branch: 'main', event: 'schedule', head_sha: shas[0], html_url: 'u' }], { 1: FULL_GREEN }));
  assert.equal(r.status, 0, r.stdout);
  const covered = new Set(r.record.commits.map((c) => c.sha));
  excluded.forEach((glob, i) => assert.ok(covered.has(shas[i + 1]), `${glob}: its commit is missing from the nightly range`));
});

// ------------------------------------------------------------ the bisect

const NIGHTLY = { NIGHTLY_RUN_ID: '1', NIGHTLY_RUN_URL: 'https://x/run/1', BISECT_RUN_URL: 'https://x/bisect', SERVER: 'https://github.com' };
const RED_JOBS = [job('native-adapter', 'failure'), job('Native corpus (shard 0/2)', 'success'), job('Native corpus (shard 1/2)', 'failure'), job('Native corpus result', 'failure')];

const BISECT_RUNS = 'repos/o/r/actions/workflows/native-adapter-bisect.yml/runs?per_page=100';
/** No other bisect is running unless the world says so; finished runs and this run itself never count. */
const IDLE = { [BISECT_RUNS]: { workflow_runs: [{ id: 3, status: 'completed' }, { id: 50, status: 'in_progress' }] } };
const plan = (context, cwd, env, world) => run(context, BISECT, ['plan'], { cwd, env: { ...NIGHTLY, GITHUB_RUN_ID: '50', ...env }, world: { ...world, api: { ...IDLE, ...world.api } } });
/** The value after `flag` in a recorded gh call. */
const arg = (call, flag) => call[call.findIndex((a) => a === flag) + 1];
const posted = (calls) => calls.filter((c) => c[0] === 'issue' && (c[1] === 'comment' || c[1] === 'create')).map((c) => arg(c, '--body'));

/** Drives the real plan and next steps round by round until a verdict, probing with `fails(sha)`. */
function bisect(context, root, { good, bad, fails, flaky = false, jobs = RED_JOBS }) {
  const world = { api: { [JOBS(1)]: { jobs } }, record: { last_green: good, head: bad }, issues: [{ number: 5, title: TITLE }], labels: [{ name: 'nightly-red' }] };
  let planned = plan(context, root, { EVENT: 'workflow_run' }, world);
  assert.equal(planned.status, 0, planned.stdout);
  const start = posted(planned.calls);
  const probes = [];
  for (let round = 0; round < 50; round += 1) {
    const p = planned.outputs;
    assert.equal(planned.status, 0, planned.stdout);
    probes.push(p.probe);
    const result = flaky && p.phase === 'confirm' ? 'success' : fails(p.probe) ? 'failure' : 'success';
    const step = run(context, BISECT, ['next'], { cwd: root, world, env: { ...NIGHTLY, PLAN_RESULT: 'success', PROBE_RESULT: result, PROBE: p.probe, GOOD: p.good, BAD: p.bad, PHASE: p.phase, ADAPTER: p.adapter, SHARDS: p.shards, ROUND: p.round, ORIGIN: p.origin } });
    assert.equal(step.status, 0, step.stdout);
    const dispatch = step.calls.find((c) => c[0] === 'workflow' && c[1] === 'run');
    if (!dispatch) return { start, verdict: posted(step.calls), calls: step.calls, probes, first: planned };
    assert.deepEqual(dispatch.slice(0, 7), ['workflow', 'run', 'native-adapter-bisect.yml', '--repo', 'o/r', '--ref', 'main']);
    const inputs = Object.fromEntries(dispatch.flatMap((arg, i) => (dispatch[i - 1] === '-f' ? [arg.split(/=(.*)/s).slice(0, 2)] : [])));
    planned = plan(context, root, { EVENT: 'workflow_dispatch', GOOD: inputs.good, BAD: inputs.bad, PHASE: inputs.phase, ADAPTER: inputs.adapter, SHARDS: inputs.shards, ROUND: inputs.round, ORIGIN: inputs.origin }, { ...world, record: null });
  }
  assert.fail('the bisect did not terminate');
}

test('the bisect names the first bad commit wherever it is, in about log2(n) probes', (context) => {
  // Every position for short ranges; both ends and an odd middle for a longer one.
  for (const [n, positions] of [[1, [0]], [2, [0, 1]], [3, [0, 1, 2]], [9, [0, 4, 8]]]) {
    const { root, shas } = linearRepo(context, Array.from({ length: n }, (_, i) => `f${i}.txt`));
    const [good, ...commits] = shas;
    for (const k of positions) {
      const { start, verdict, probes } = bisect(context, root, { good, bad: commits.at(-1), fails: (sha) => new Set(commits.slice(k)).has(sha) });
      assert.equal(start.length, 1, 'one start notice');
      assert.match(start[0], new RegExp(`^Bisect started for the red nightly run https://x/run/1: ${n} commit\\(s\\) after `)); // @source-text-assertion-ok subject is the CLI's own output
      assert.equal(verdict.length, 1, `n=${n} k=${k}: one verdict`);
      assert.match(verdict[0], new RegExp(`^First bad commit: https://github.com/o/r/commit/${commits[k]} \\(touch f${k}\\.txt\\)`), `n=${n} k=${k}: ${verdict[0]}`); // @source-text-assertion-ok subject is the CLI's own output
      // The first commit's parent is the last green nightly, which no probe re-ran: say so rather than claim it passes.
      assert.match(verdict[0], k === 0 ? /is the last green nightly, which this bisect did not re-run/ : /Its parent \w+ passes native-adapter/, `n=${n} k=${k}: ${verdict[0]}`); // @source-text-assertion-ok subject is the CLI's own output
      assert.equal(probes[0], commits.at(-1), 'the first round re-runs the red HEAD');
      assert.ok(probes.length <= 1 + Math.ceil(Math.log2(n)), `n=${n} k=${k}: ${probes.length} probes`);
      assert.equal(new Set(probes).size, probes.length, 'no commit is probed twice');
    }
  }
});

test('the bisect re-runs exactly what failed, and posts on the labelled tracking issue', (context) => {
  const { root, shas } = linearRepo(context, ['a', 'b']);
  const target = (jobs) => {
    const p = plan(context, root, { EVENT: 'workflow_run' }, { api: { [JOBS(1)]: { jobs } }, record: { last_green: shas[0], head: shas[2] }, labels: [{ name: 'nightly-red' }] });
    assert.equal(p.status, 0, p.stdout);
    return { probe: p.outputs.probe, adapter: p.outputs.adapter, shards: p.outputs.shards, calls: p.calls };
  };
  assert.deepEqual(target(RED_JOBS).shards, '[1]');
  const adapterOnly = target([job('native-adapter', 'timed_out'), ...FULL_GREEN.slice(1)]);
  assert.deepEqual([adapterOnly.adapter, adapterOnly.shards], ['true', '']);
  // The start notice opens the issue when the reporter did not, labelled.
  const created = adapterOnly.calls.find((c) => c[0] === 'issue' && c[1] === 'create');
  assert.deepEqual([arg(created, '--title'), arg(created, '--label')], [TITLE, 'nightly-red']);
});

test('a failure that does not reproduce on the red HEAD is reported as flaky, not bisected', (context) => {
  const { root, shas } = linearRepo(context, ['a', 'b', 'c']);
  const { verdict, probes } = bisect(context, root, { good: shas[0], bad: shas[3], fails: () => true, flaky: true });
  assert.match(verdict[0], /^The failure did not reproduce: native-adapter and corpus shard\(s\) 1 passed on a re-run of /); // @source-text-assertion-ok subject is the CLI's own output
  assert.equal(probes.length, 1);
});

test('a cancelled probe stops the bisect with the command that resumes it', (context) => {
  const { root, shas } = linearRepo(context, ['a', 'b', 'c']);
  const step = run(context, BISECT, ['next'], { cwd: root, world: { labels: [{ name: 'nightly-red' }] }, env: { ...NIGHTLY, PLAN_RESULT: 'success', PROBE_RESULT: 'cancelled', PROBE: shas[2], GOOD: shas[0], BAD: shas[3], PHASE: 'bisect', ADAPTER: 'true', SHARDS: '', ROUND: '2' } });
  assert.equal(step.status, 0, step.stdout);
  assert.ok(!step.calls.some((c) => c[0] === 'workflow'), 'no next round');
  const [body] = posted(step.calls);
  assert.match(body, /^Bisect stopped: the probe of \w+ ended `cancelled`/); // @source-text-assertion-ok subject is the CLI's own output
  assert.ok(body.includes(`-f good=${shas[0]} -f bad=${shas[3]} -f phase=bisect -f adapter=true`), body); // @source-text-assertion-ok subject is the CLI's own output
});

test('a red nightly with no coverage record, or a plan that failed, is said on the issue', (context) => {
  const { root } = linearRepo(context, []);
  const p = plan(context, root, { EVENT: 'workflow_run' }, { api: { [JOBS(1)]: { jobs: [job('native-adapter', 'failure')] } }, record: null });
  assert.equal(p.status, 0, p.stdout);
  assert.equal(p.outputs.probe, '');
  assert.match(p.outputs.notice, /no nightly-range record \(.*\), so the commit range is unknown/); // @source-text-assertion-ok subject is the CLI's own output
  const told = run(context, BISECT, ['next'], { cwd: root, world: { labels: [{ name: 'nightly-red' }] }, env: { ...NIGHTLY, PLAN_RESULT: 'success', PROBE: '', NOTICE: p.outputs.notice } });
  assert.deepEqual(posted(told.calls), [p.outputs.notice]);
  const failed = run(context, BISECT, ['next'], { cwd: root, world: { labels: [{ name: 'nightly-red' }] }, env: { ...NIGHTLY, PLAN_RESULT: 'failure' } });
  assert.match(posted(failed.calls)[0], /^Bisect could not plan \(plan job: failure\)/); // @source-text-assertion-ok subject is the CLI's own output
});

test('a dispatched round refuses inputs that are not a forward range of full SHAs', (context) => {
  const { root, shas } = linearRepo(context, ['a', 'b']);
  const base = { EVENT: 'workflow_dispatch', ADAPTER: 'true', SHARDS: '' };
  for (const [env, why] of [
    [{ GOOD: 'HEAD~1', BAD: shas[2] }, 'not a full SHA'],
    [{ GOOD: shas[2], BAD: shas[0] }, 'backwards'],
    [{ GOOD: shas[0], BAD: shas[2], ADAPTER: 'false' }, 'nothing to probe'],
    [{ GOOD: shas[0], BAD: shas[2], SHARDS: '["0; rm -rf /"]' }, 'shards not indices'],
  ]) {
    const p = plan(context, root, { ...base, ...env }, {});
    assert.notEqual(p.status, 0, why);
    assert.equal(p.outputs.probe, undefined, `${why}: no probe planned`);
  }
});

test('a red night a probe cannot reproduce, or another bisect already covers, is said instead of bisected', (context) => {
  const { root, shas } = linearRepo(context, ['a', 'b']);
  const notice = (jobs, record, api = {}) => {
    const p = plan(context, root, { EVENT: 'workflow_run' }, { api: { [JOBS(1)]: { jobs }, ...api }, record });
    assert.equal(p.status, 0, p.stdout);
    assert.equal(p.outputs.probe, '', 'nothing probed');
    assert.deepEqual(posted(p.calls), [], 'plan posts nothing; next posts the notice');
    return p.outputs.notice;
  };
  const record = { last_green: shas[0], head: shas[2] };
  // Only the aggregate failed, every shard green: re-running shards would call a real break a flake.
  const aggregate = notice([job('native-adapter', 'success'), job('Native corpus (shard 0/2)', 'success'), job('Native corpus (shard 1/2)', 'success'), job('Native corpus result', 'failure')], record);
  assert.match(aggregate, /only the corpus aggregate failed, with every shard green/); // @source-text-assertion-ok subject is the CLI's own output
  // #10629 review r4603499517: the lane passed and the run is red anyway (here the nightly-range job). The notice
  // names the job, and next posts it on the issue, so the red night is never silent.
  const lanePassed = notice([...FULL_GREEN, job('Nightly coverage range', 'failure')], record);
  assert.match(lanePassed, /no native-adapter or corpus shard job failed.*Jobs that did not succeed: Nightly coverage range \(failure\)/); // @source-text-assertion-ok subject is the CLI's own output
  const told = run(context, BISECT, ['next'], { cwd: root, world: { labels: [{ name: 'nightly-red' }] }, env: { ...NIGHTLY, PLAN_RESULT: 'success', PROBE: '', NOTICE: lanePassed } });
  assert.deepEqual(posted(told.calls), [lanePassed]);
  // A lane that never reported is not called green.
  assert.match(notice([job('Native corpus result', 'skipped')], record), /native-adapter is not in the run's job listing/); // @source-text-assertion-ok subject is the CLI's own output
  // Red on the very commit the last green run passed: nothing in the repo changed.
  const same = notice(RED_JOBS, { last_green: shas[2], head: shas[2] });
  assert.match(same, /ran the same commit as the last green run .* the cause is outside the repo/); // @source-text-assertion-ok subject is the CLI's own output
  // A bisect already running: red nights in a row share their last green commit.
  const busy = notice(RED_JOBS, record, { [BISECT_RUNS]: { workflow_runs: [{ id: 7, status: 'waiting', html_url: 'https://x/bisect/7' }] } });
  assert.match(busy, /one is already running \(https:\/\/x\/bisect\/7\)/); // @source-text-assertion-ok subject is the CLI's own output
});

test('a range that reshards the corpus anywhere inside it probes every shard, however the bisect started', (context) => {
  // The manifest changes and is then removed again, so the range's endpoints are identical.
  const { root, shas, git } = linearRepo(context, ['tests/models/manifest.json']);
  git('rm', '-q', 'tests/models/manifest.json');
  git('commit', '-q', '-m', 'drop the manifest again');
  const head = git('rev-parse', 'HEAD');
  const p = plan(context, root, { EVENT: 'workflow_run' }, { api: { [JOBS(1)]: { jobs: RED_JOBS } }, record: { last_green: shas[0], head }, labels: [{ name: 'nightly-red' }] });
  assert.equal(p.status, 0, p.stdout);
  assert.equal(p.outputs.shards, '[0,1]');
  assert.match(posted(p.calls)[0], /changes how models are sharded, so every probe re-runs all shards/); // @source-text-assertion-ok subject is the CLI's own output
  // Started or resumed by hand naming fewer shards: refused, since `good` is only known green on those. The shard
  // count comes from main's workflow, here the real one (8); naming all of them is accepted.
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  writeFileSync(join(root, '.github/workflows/geometry-platform.yml'), readFileSync(join(REPO, '.github/workflows/geometry-platform.yml'), 'utf8'));
  const manual = { EVENT: 'workflow_dispatch', GOOD: shas[0], BAD: head, PHASE: 'confirm', ADAPTER: 'false' };
  const one = plan(context, root, { ...manual, SHARDS: '[1]' }, {});
  assert.notEqual(one.status, 0);
  assert.equal(one.outputs.probe, undefined, 'no probe planned');
  const all = plan(context, root, { ...manual, SHARDS: '[0,1,2,3,4,5,6,7]' }, {});
  assert.equal(all.status, 0, all.stdout);
  assert.equal(all.outputs.probe, head);
});
