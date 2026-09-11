/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The no-op `edited` replay, pinned at three levels: the two pure decisions,
 * the CLI's exit codes driven through fixture files (never `gh`), and the
 * wiring in test.yml that makes the replay the thing a required check reads.
 *
 * Run: node --test scripts/lib/ci-verdict-replay.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { AGGREGATE_CHECK_NAME, isNoopEdit, runIdOf, selectReplayVerdict } from './ci-verdict-replay.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const CLI = join(REPO_ROOT, 'scripts/ci-verdict-replay.mjs');
const TEST_YML = join(REPO_ROOT, '.github/workflows/test.yml');

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

const prEvent = (action, changes, sha = SHA) => ({ action, changes, pull_request: { number: 1, head: { sha } } });

const run = (name, runId, status, conclusion, completed_at, sha = SHA) => ({
  name,
  head_sha: sha,
  status,
  conclusion,
  completed_at,
  details_url: `https://github.com/o/r/actions/runs/${runId}/job/${runId}1`,
  html_url: `https://github.com/o/r/actions/runs/${runId}/job/${runId}1`,
});

// ---------------------------------------------------------------- decisions

test('isNoopEdit: a title or body edit is a no-op; a retarget, a push or any other event is not', () => {
  assert.equal(isNoopEdit(prEvent('edited', { title: { from: 'old' } })), true);
  assert.equal(isNoopEdit(prEvent('edited', { body: { from: 'old' } })), true);
  assert.equal(isNoopEdit(prEvent('edited', {})), true, 'an empty changes object cannot be a base move');
  assert.equal(isNoopEdit(prEvent('edited', undefined)), true);
  // THE RETARGET, which must keep its full run (#3772).
  assert.equal(isNoopEdit(prEvent('edited', { base: { ref: { from: 'feature' }, sha: { from: 'x' } } })), false);
  assert.equal(isNoopEdit(prEvent('edited', { base: { ref: { from: 'feature' } }, title: { from: 'o' } })), false, 'base + title is still a retarget');
  for (const action of ['opened', 'synchronize', 'reopened', 'ready_for_review', 'labeled']) {
    assert.equal(isNoopEdit(prEvent(action, {})), false, action);
  }
  assert.equal(isNoopEdit({ action: 'edited', changes: {} }, 'issues'), false, 'an issue edit is not a PR edit');
  assert.equal(isNoopEdit({ ref: 'refs/heads/main' }, 'push'), false);
  assert.equal(isNoopEdit({ merge_group: {} }, 'merge_group'), false);
  assert.equal(isNoopEdit(null), false);
  assert.equal(isNoopEdit(undefined), false);
});

test('selectReplayVerdict: the LATEST COMPLETED aggregate for the SHA, never this run\'s own', () => {
  const runs = [
    run(AGGREGATE_CHECK_NAME, 100, 'completed', 'failure', '2026-09-11T10:00:00Z'),
    run(AGGREGATE_CHECK_NAME, 200, 'completed', 'success', '2026-09-11T11:00:00Z'),
    run(AGGREGATE_CHECK_NAME, 300, 'in_progress', null, null), // this run
    run('Node tests', 200, 'completed', 'failure', '2026-09-11T12:00:00Z'), // wrong name
    run(AGGREGATE_CHECK_NAME, 400, 'completed', 'success', '2026-09-11T13:00:00Z', OTHER), // wrong sha
  ];
  const v = selectReplayVerdict(runs, { sha: SHA, excludeRunId: 300 });
  assert.equal(v.found, true);
  assert.equal(v.conclusion, 'success');
  assert.equal(v.success, true);
  assert.equal(v.runId, '200');
  assert.equal(v.completedAt, '2026-09-11T11:00:00Z');
});

test('selectReplayVerdict: only `success` replays green; every other conclusion is a failure', () => {
  for (const c of ['failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'stale', 'skipped', null]) {
    const v = selectReplayVerdict([run(AGGREGATE_CHECK_NAME, 1, 'completed', c, '2026-09-11T10:00:00Z')], { sha: SHA });
    assert.equal(v.found, true, String(c));
    assert.equal(v.success, false, `${c} must not replay as a pass`);
  }
});

test('selectReplayVerdict: the newest wins even when listed first, and the excluded run is skipped even when newest', () => {
  const runs = [
    run(AGGREGATE_CHECK_NAME, 2, 'completed', 'failure', '2026-09-11T12:00:00Z'),
    run(AGGREGATE_CHECK_NAME, 1, 'completed', 'success', '2026-09-11T10:00:00Z'),
  ];
  assert.equal(selectReplayVerdict(runs, { sha: SHA }).conclusion, 'failure');
  assert.equal(selectReplayVerdict(runs, { sha: SHA, excludeRunId: '2' }).conclusion, 'success');
});

test('selectReplayVerdict: nothing to replay is FOUND=false with a reason, never a pass', () => {
  assert.equal(selectReplayVerdict([], { sha: SHA }).found, false);
  assert.equal(selectReplayVerdict([run(AGGREGATE_CHECK_NAME, 1, 'in_progress', null, null)], { sha: SHA }).found, false, 'in progress is not completed');
  assert.equal(selectReplayVerdict([run(AGGREGATE_CHECK_NAME, 1, 'completed', 'success', '2026-09-11T10:00:00Z')], { sha: SHA, excludeRunId: 1 }).found, false, 'only this run\'s own');
  assert.equal(selectReplayVerdict([run(AGGREGATE_CHECK_NAME, 1, 'completed', 'success', '2026-09-11T10:00:00Z')], { sha: 'abc' }).found, false, 'a short sha is refused');
  assert.equal(selectReplayVerdict(null, { sha: SHA }).found, false);
  assert.match(selectReplayVerdict([], { sha: SHA }).reason, /no completed/);
});

test('runIdOf reads the run id from an Actions details_url and nothing else', () => {
  assert.equal(runIdOf({ details_url: 'https://github.com/o/r/actions/runs/34595555257/job/103251768251' }), '34595555257');
  assert.equal(runIdOf({ details_url: 'https://vercel.com/x' }), null);
  assert.equal(runIdOf({}), null);
});

// ---------------------------------------------------------------- the CLI

function cli(args, files) {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-replay-'));
  try {
    const argv = [CLI, ...args];
    if (files.event !== undefined) {
      writeFileSync(join(dir, 'event.json'), JSON.stringify(files.event));
      argv.push('--event-file', join(dir, 'event.json'));
    }
    if (files.checkRuns !== undefined) {
      writeFileSync(join(dir, 'runs.json'), JSON.stringify({ total_count: files.checkRuns.length, check_runs: files.checkRuns }));
      argv.push('--check-runs-file', join(dir, 'runs.json'));
    }
    const output = join(dir, 'output.txt');
    writeFileSync(output, '');
    argv.push('--output', output);
    const env = { ...process.env };
    delete env.GITHUB_EVENT_PATH;
    delete env.GITHUB_EVENT_NAME;
    delete env.GITHUB_OUTPUT;
    const r = spawnSync(process.execPath, argv, { encoding: 'utf8', env });
    return { code: r.status, out: `${r.stdout}\n${r.stderr}`, outputs: readFileSync(output, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const GREEN = [run(AGGREGATE_CHECK_NAME, 100, 'completed', 'success', '2026-09-11T11:00:00Z')];
const RED = [run(AGGREGATE_CHECK_NAME, 100, 'completed', 'failure', '2026-09-11T11:00:00Z')];

test('--probe: a body edit of a head with a verdict is noop=true', () => {
  const r = cli(['--probe', '--run-id', '300'], { event: prEvent('edited', { body: { from: 'x' } }), checkRuns: GREEN });
  assert.equal(r.code, 0, r.out);
  assert.match(r.outputs, /^noop=true$/m);
  assert.match(r.out, /already exists \(success, run 100/);
});

test('--probe: a body edit of a head with a RED verdict is still noop=true (the replay will be red)', () => {
  const r = cli(['--probe', '--run-id', '300'], { event: prEvent('edited', { body: { from: 'x' } }), checkRuns: RED });
  assert.equal(r.code, 0, r.out);
  assert.match(r.outputs, /^noop=true$/m);
});

test('--probe: a retarget is noop=false, whatever verdicts the head carries', () => {
  const r = cli(['--probe', '--run-id', '300'], { event: prEvent('edited', { base: { ref: { from: 'f' } } }), checkRuns: GREEN });
  assert.equal(r.code, 0, r.out);
  assert.match(r.outputs, /^noop=false$/m);
  assert.match(r.out, /not a no-op edit/);
});

test('--probe: a synchronize, and a body edit with NO verdict yet, both run the full lane set', () => {
  const sync = cli(['--probe', '--run-id', '300'], { event: prEvent('synchronize', {}), checkRuns: GREEN });
  assert.match(sync.outputs, /^noop=false$/m);
  const none = cli(['--probe', '--run-id', '300'], { event: prEvent('edited', { body: { from: 'x' } }), checkRuns: [] });
  assert.equal(none.code, 0, none.out);
  assert.match(none.outputs, /^noop=false$/m);
  assert.match(none.out, /no completed/);
  // Only this run's own aggregate exists (still in progress): nothing to replay.
  const own = cli(['--probe', '--run-id', '300'], { event: prEvent('edited', { body: { from: 'x' } }), checkRuns: [run(AGGREGATE_CHECK_NAME, 300, 'in_progress', null, null)] });
  assert.match(own.outputs, /^noop=false$/m);
});

test('--probe: a push or merge_group payload is noop=false without touching the API', () => {
  const r = cli(['--probe', '--event-name', 'push'], { event: { ref: 'refs/heads/main' } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.outputs, /^noop=false$/m);
});

test('--replay: exit 0 on a recorded success, 1 on anything else, 2 when nothing is there', () => {
  const green = cli(['--replay', '--run-id', '300'], { event: prEvent('edited', { body: { from: 'x' } }), checkRuns: GREEN });
  assert.equal(green.code, 0, green.out);
  assert.match(green.out, /replaying .* = success from run 100/);

  const red = cli(['--replay', '--run-id', '300'], { event: prEvent('edited', { body: { from: 'x' } }), checkRuns: RED });
  assert.equal(red.code, 1, red.out);
  assert.match(red.out, /recorded verdict is "failure"/);

  const cancelled = cli(['--replay', '--run-id', '300'], { event: prEvent('edited', {}), checkRuns: [run(AGGREGATE_CHECK_NAME, 100, 'completed', 'cancelled', '2026-09-11T11:00:00Z')] });
  assert.equal(cancelled.code, 1, cancelled.out);

  const none = cli(['--replay', '--run-id', '300'], { event: prEvent('edited', {}), checkRuns: [] });
  assert.equal(none.code, 2, none.out);
  assert.match(none.out, /REFUSING/);
});

test('--replay ignores this run\'s own in-progress aggregate and replays the earlier one', () => {
  const r = cli(['--replay', '--run-id', '300'], {
    event: prEvent('edited', {}),
    checkRuns: [run(AGGREGATE_CHECK_NAME, 300, 'in_progress', null, null), ...GREEN],
  });
  assert.equal(r.code, 0, r.out);
});

test('the CLI refuses an unknown flag and a missing mode instead of doing nothing quietly', () => {
  assert.equal(cli(['--bogus'], {}).code, 1);
  assert.equal(cli([], {}).code, 1);
});

// ---------------------------------------------------------------- the wiring

/** A job's text from test.yml (2-space job key to the next), comments dropped. */
function job(id) {
  const text = readFileSync(TEST_YML, 'utf8');
  const m = new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=\\n  [A-Za-z_][A-Za-z0-9_-]*:|(?![\\s\\S]))`, 'm').exec(text);
  assert.ok(m, `test.yml must carry a job with id \`${id}\``);
  return m[1].split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
}

test('WIRING: `changes` probes, the aggregate replays on noop and judges otherwise, and nothing skips silently', () => {
  const changes = job('changes');
  assert.match(changes, /^\s+noop: \$\{\{ steps\.noop\.outputs\.noop/m, '`changes` must expose a `noop` output');
  assert.match(changes, /node scripts\/ci-verdict-replay\.mjs --probe/, '`changes` must run the probe');
  // The paths filter is what makes every lane's `== 'true'` false on a no-op:
  // it must not run then, or the lanes would run on a head that has a verdict.
  assert.match(changes, /if: steps\.noop\.outputs\.noop != 'true'/, 'the filter steps must be skipped on a no-op');

  const agg = job('test');
  assert.match(agg, /if: needs\.changes\.outputs\.noop == 'true'[\s\S]*node scripts\/ci-verdict-replay\.mjs --replay/, 'the aggregate must replay on noop');
  assert.match(agg, /if: needs\.changes\.outputs\.noop != 'true'[\s\S]*declare -A results/, 'the aggregate must still judge every lane when not a no-op');

  // The one lane with no path filter of its own would otherwise run on every
  // body edit; it is gated on the probe like the filtered lanes effectively are.
  assert.match(job('rust-semver'), /^\s{4}if: needs\.changes\.outputs\.noop != 'true'/m, 'rust-semver must skip on a no-op');

  // The gate needs to read check runs. Without this scope the probe fails
  // closed (noop=false, full run) and the saving silently never happens.
  const text = readFileSync(TEST_YML, 'utf8');
  assert.match(text, /^permissions:\n(?:  [a-z-]+: read\n|  #[^\n]*\n)*  checks: read/m, 'the workflow must hold `checks: read`');
});

test('WIRING: no job gates on `github.event.changes.base`; the decision lives in the probe', () => {
  // The workflow comment on the `edited` trigger explains why: a skipped job
  // reads as a pass to the required-check evaluation. The probe reads the
  // event payload instead and the aggregate REPLAYS rather than skips.
  const code = readFileSync(TEST_YML, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.ok(!/github\.event\.changes\.base/.test(code));
});
