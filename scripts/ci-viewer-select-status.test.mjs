/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `PR viewer selection` commit status (scripts/ci-viewer-select-status.mjs):
 * what it posts for each job outcome, that it posts to a real HTTP endpoint
 * (a local server standing in for the API), and its wiring in test.yml and
 * .mergify.yml.
 *
 * Run: node --test scripts/ci-viewer-select-status.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import { STATUS_CONTEXT, decideStatus, main } from './ci-viewer-select-status.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO = 'LTplus-AG/ifc-lite';
const base = { mode: 'on', headRepo: REPO, repo: REPO, jobStatus: 'success', selectOutcome: 'success', run: 'true', runOutcome: 'success' };
const final = (extra) => decideStatus({ phase: 'final', ...base, ...extra });

const ENTRY = { event: 'pull_request', lane: 'fast', batch: 'false', noop: 'false', frontend: 'true', rust: 'false' };
const entry = (extra) => decideStatus({ phase: 'entry', ...base, ...ENTRY, ...extra });

test('entry: pending when the run gates, else success "not gated", never for a fork PR', () => {
  assert.deepEqual(entry({}), { post: true, state: 'pending', description: 'Selected viewer tests are running' });
  assert.equal(entry({ mode: 'ON' }).state, 'pending', "Actions' == is case-insensitive");
  assert.equal(entry({ frontend: 'false', rust: 'true' }).state, 'pending');
  assert.deepEqual(entry({ lane: 'full' }), { post: true, state: 'success', description: 'Not gated on this run (full lane: every viewer shard runs)' });
  assert.deepEqual(entry({ mode: 'off' }), { post: true, state: 'success', description: 'Not gated on this run (CI_PR_VIEWER_SELECT is "off")' });
  assert.equal(entry({ mode: 'shadow' }).state, 'success');
  assert.equal(entry({ mode: undefined }).state, 'success');
  assert.equal(entry({ frontend: 'false', rust: 'false' }).description, 'Not gated on this run (no frontend or Rust change)');
  assert.equal(entry({ headRepo: 'someone/ifc-lite' }).post, false, 'fork PR: its token cannot write statuses');
  assert.equal(entry({ noop: 'true' }).post, false, 'a no-op edit must not release or reset anything');
  assert.equal(entry({ batch: 'true' }).post, false);
  assert.equal(entry({ event: 'push' }).post, false);
});

test('final: only in `on`; a cancelled job posts nothing (its pending stays)', () => {
  assert.equal(final({ mode: 'shadow', result: { files: 1, passed: false } }).post, false, 'shadow: the changes job posted "not gated"');
  assert.equal(final({ jobStatus: 'cancelled', result: { files: 1, passed: false } }).post, false, 'cancelled: the pending status stays');
});

test('final: success when the files passed (a retry counts) or nothing was selected', () => {
  assert.deepEqual(final({ result: { files: 3, passed: true } }), { post: true, state: 'success', description: '3 selected files passed' });
  assert.equal(final({ result: { files: 1, passed: true, passedOnRetry: ['src/a.test.ts'] } }).description, '1 selected file passed (1 after a retry)');
  assert.equal(final({ run: 'false', runOutcome: 'skipped', result: null }).state, 'success');
});

test('final: failure names the failing files, and every missing verdict is a failure', () => {
  const failed = final({ result: { files: 4, passed: false, failedFiles: ['src/a.test.ts', 'src/b.test.tsx'] } });
  assert.deepEqual(failed, { post: true, state: 'failure', description: '2 of 4 selected files failed: src/a.test.ts, src/b.test.tsx' });
  assert.deepEqual(final({ result: { files: 2, passed: false, failedFiles: [] } }), { post: true, state: 'failure', description: '2 selected files ran; a failure no file could be tied to' });
  assert.equal(final({ selectOutcome: 'failure' }).state, 'failure');
  assert.equal(final({ runOutcome: 'failure', result: null }).state, 'failure');
  assert.equal(final({ result: null }).state, 'failure', 'no result.json');
  const long = final({ result: { files: 40, passed: false, failedFiles: Array.from({ length: 20 }, (_, i) => `src/some/deep/path/file-${i}.test.ts`) } });
  assert.ok(long.description.length <= 140, 'GitHub rejects a description over 140 characters');
});

/** A local stand-in for the API: records the POSTs, answers `code`. */
async function withApi(code, fn) {
  const posts = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jobs: [{ name: 'Viewer tests, advisory (selected for this PR)', html_url: 'https://github.com/x/job/9' }] }));
        return;
      }
      posts.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, posts);
  } finally {
    server.close();
  }
}

const SHA = 'a'.repeat(40);
const env = (api, extra = {}) => ({
  GITHUB_API_URL: api, GITHUB_TOKEN: 't0k', GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '1',
  HEAD_SHA: SHA, HEAD_REPO: REPO, CI_PR_VIEWER_SELECT: 'on', ...extra,
});

test('main --final posts the verdict on the head sha with the job link', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'viewer-status-'));
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ files: 2, passed: false, failedFiles: ['src/a.test.ts'] }));
  await withApi(201, async (api, posts) => {
    const code = await main(['--final', dir], env(api, {
      JOB_NAME: 'Viewer tests, advisory (selected for this PR)', JOB_STATUS: 'success', SELECT_OUTCOME: 'success', SELECT_RUN: 'true', RUN_OUTCOME: 'success',
    }));
    assert.equal(code, 0);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, `/repos/${REPO}/statuses/${SHA}`);
    assert.equal(posts[0].auth, 'Bearer t0k');
    assert.deepEqual(posts[0].body, { state: 'failure', context: STATUS_CONTEXT, description: '1 of 2 selected files failed: src/a.test.ts', target_url: 'https://github.com/x/job/9' });
  });
});

const entryEnv = { EVENT: 'pull_request', LANE: 'fast', BATCH: 'false', NOOP: 'false', FRONTEND: 'true', RUST: 'false' };

test('main: a failed post fails --final (the pending status still holds the gate) but never --entry (fails open)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'viewer-status-'));
  await withApi(500, async (api, posts) => {
    assert.equal(await main(['--entry'], env(api, entryEnv)), 0, 'a status API blip must not turn `changes` red');
    assert.equal(await main(['--final', dir], env(api, { JOB_STATUS: 'success', SELECT_OUTCOME: 'success', SELECT_RUN: 'false' })), 1);
    assert.equal(posts.length, 2);
    assert.equal(posts[0].body.state, 'pending');
  });
});

test('main --entry: switch rolled back to off posts success "not gated", releasing a held PR', async () => {
  await withApi(201, async (api, posts) => {
    assert.equal(await main(['--entry'], env(api, { ...entryEnv, CI_PR_VIEWER_SELECT: 'off' })), 0);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.state, 'success');
    assert.equal(posts[0].body.context, STATUS_CONTEXT);
  });
});

test('main: a fork PR or a no-op edit posts nothing', async () => {
  await withApi(201, async (api, posts) => {
    assert.equal(await main(['--entry'], env(api, { ...entryEnv, HEAD_REPO: 'someone/ifc-lite' })), 0);
    assert.equal(await main(['--entry'], env(api, { ...entryEnv, NOOP: 'true' })), 0);
    assert.equal(posts.length, 0);
  });
});

/**
 * One sha's status, last write wins, driven through decideStatus in the order
 * test.yml's concurrency group allows (the script header's ORDERING note).
 */
function sha() {
  let status = null;
  const write = (d) => {
    if (d.post) status = d.state;
  };
  return { write, get: () => status };
}

test('ORDERING: a later full-lane run on the same sha releases a hold (pending or failure) the fast run left', () => {
  for (const left of ['pending', 'failure']) {
    const s = sha();
    s.write(entry({}));
    if (left === 'failure') s.write(final({ result: { files: 1, passed: false, failedFiles: ['src/a.test.ts'] } }));
    // `ci:full` + close/reopen: the reopened run cancels the fast one, which posts nothing.
    s.write(final({ jobStatus: 'cancelled', result: null }));
    s.write(entry({ lane: 'full' }));
    assert.equal(s.get(), 'success', left);
  }
});

test('ORDERING: a cancelled fast run cannot overwrite the cancelling run, and its failure is not turned into success', () => {
  // Reopened fast run B cancels fast run A: A's always() step runs after B started.
  const s = sha();
  s.write(entry({}));
  s.write(entry({}));
  s.write(final({ jobStatus: 'cancelled', result: { files: 1, passed: true } }));
  assert.equal(s.get(), 'pending', 'B holds the gate until its own verdict');
  s.write(final({ result: { files: 1, passed: false, failedFiles: ['src/a.test.ts'] } }));
  // A no-op `edited` run queues behind B (no cancel) and posts nothing.
  s.write(entry({ noop: 'true' }));
  assert.equal(s.get(), 'failure', 'the real failure stands');
});

// ---------------------------------------------------------------- the wiring

const JOBS = parse(readFileSync(join(REPO_ROOT, '.github/workflows/test.yml'), 'utf8')).jobs;
const CHANGES = JOBS.changes;
const TESTS = JOBS['viewer-tests-selected'];
const ENTRY_STEP = CHANGES.steps.find((s) => s.name === 'Post the PR viewer selection entry status');
const FINAL_STEP = TESTS.steps.find((s) => s.name === 'Post the PR viewer selection status');

/**
 * The tests job's `if:` evaluated for real: a minimal Actions-expression
 * evaluator for the forms it uses (`==`, `!=`, `&&`, `||`, parentheses,
 * string literals, three contexts), case-insensitive like Actions. Throws on
 * anything else, so a new clause cannot read as "runs".
 */
function testsJobRuns(ctx) {
  const lit = (v) => JSON.stringify(String(v ?? '').toLowerCase());
  const js = String(TESTS.if)
    .replace(/'([^']*)'/g, (_, v) => lit(v))
    .replace(/\bvars\.CI_PR_VIEWER_SELECT\b/g, lit(ctx.mode))
    .replace(/\bgithub\.event_name\b/g, lit(ctx.event))
    .replace(/\bneeds\.changes\.outputs\.(\w+)\b/g, (_, k) => lit(ctx[k]))
    .replace(/==/g, '===').replace(/!===/g, '!==');
  if (!/^[\s"a-z_.\-()&|=!]*$/.test(js)) throw new Error(`cannot evaluate the tests job's if: ${js}`); // @source-text-assertion-ok evaluator guard: refuses a workflow expression it cannot evaluate, rather than reading it as true
  return Function(`return (${js});`)();
}

test('WIRING: entry gates exactly the runs where the tests job runs in `on`; shadow is "not gated"', () => {
  let cases = 0;
  for (const mode of ['on', 'shadow', 'off', ''])
    for (const lane of ['fast', 'full'])
      for (const frontend of ['true', 'false'])
        for (const rust of ['true', 'false']) {
          const ctx = { ...ENTRY, mode, lane, frontend, rust };
          const runs = testsJobRuns(ctx);
          const gated = entry(ctx).state === 'pending';
          assert.equal(gated, runs && mode === 'on', JSON.stringify(ctx));
          cases += 1;
        }
  assert.equal(cases, 32);
  assert.equal(testsJobRuns({ ...ENTRY, mode: 'on', noop: 'true' }), false, 'a no-op edit runs no tests (and entry posts nothing)');
  assert.equal(testsJobRuns({ ...ENTRY, mode: 'on', batch: 'true' }), false);
});

test('WIRING: entry is the last step of `changes` and reads its final outputs', () => {
  assert.equal(CHANGES.steps.at(-1), ENTRY_STEP, 'last, after the lane and filter steps');
  assert.equal(ENTRY_STEP.if, "github.event_name == 'pull_request'");
  for (const [env, output] of [['LANE', 'lane'], ['BATCH', 'batch'], ['NOOP', 'noop'], ['FRONTEND', 'frontend'], ['RUST', 'rust']]) {
    assert.equal(ENTRY_STEP.env[env], CHANGES.outputs[output], `${env} is the job's own ${output} output`);
  }
  assert.ok(TESTS.needs.includes('changes'), 'the verdict always follows the entry status'); // @source-text-assertion-ok subject is the parsed needs list
  // A re-run of the tests job alone re-posts pending before its verdict.
  const rerun = TESTS.steps.find((s) => s.name === 'Post the PR viewer selection status as pending');
  assert.ok(rerun, 'the tests job re-posts the entry status');
  assert.ok(TESTS.steps.indexOf(rerun) < TESTS.steps.findIndex((s) => s.id === 'select'), 'before any test runs'); // @source-text-assertion-ok subject is the parsed step order
  assert.equal(rerun.if, undefined, 'on every attempt');
  for (const [env, output] of [['LANE', 'lane'], ['BATCH', 'batch'], ['NOOP', 'noop'], ['FRONTEND', 'frontend'], ['RUST', 'rust']]) {
    assert.equal(rerun.env[env], `\${{ needs.changes.outputs.${output} }}`, env); // eslint-disable-line no-template-curly-in-string
  }
});

test('WIRING: only `changes` and the tests job may write statuses, and both post on the PR head', () => {
  for (const [key, job] of Object.entries(JOBS)) {
    const writes = job.permissions?.statuses === 'write';
    assert.equal(writes, key === 'changes' || key === 'viewer-tests-selected', key);
  }
  for (const s of [ENTRY_STEP, FINAL_STEP]) {
    /* eslint-disable no-template-curly-in-string */
    assert.equal(s.env.HEAD_SHA, '${{ github.event.pull_request.head.sha }}', 'the head, not the merge commit');
    assert.equal(s.env.HEAD_REPO, '${{ github.event.pull_request.head.repo.full_name }}');
    /* eslint-enable no-template-curly-in-string */
  }
  assert.equal(FINAL_STEP.env.JOB_NAME, TESTS.name, 'the job-link lookup matches by name');
  assert.equal(FINAL_STEP.if, 'always()');
});

test('WIRING: .mergify.yml keeps a failing or pending status out, by the name this script posts', () => {
  const cfg = parse(readFileSync(join(REPO_ROOT, '.mergify.yml'), 'utf8'));
  const gate = JSON.stringify(cfg.merge_protections_settings.auto_merge_conditions);
  assert.ok(gate.includes(`-check-failure=${STATUS_CONTEXT}`)); // @source-text-assertion-ok subject is the parsed config
  assert.ok(gate.includes(`-check-pending=${STATUS_CONTEXT}`)); // @source-text-assertion-ok subject is the parsed config
});
