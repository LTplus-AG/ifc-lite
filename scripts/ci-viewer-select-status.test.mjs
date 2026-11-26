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
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import { STATUS_CONTEXT, STUCK, decideStatus, main } from './ci-viewer-select-status.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO = 'LTplus-AG/ifc-lite';
const base = { mode: 'on', headRepo: REPO, repo: REPO, jobStatus: 'success', selectOutcome: 'success', run: 'true', runOutcome: 'success' };
const final = (extra) => decideStatus({ phase: 'final', ...base, ...extra });

const ENTRY = { event: 'pull_request', lane: 'fast', batch: 'false', noop: 'false', frontend: 'true', rust: 'false' };
const entry = (extra) => decideStatus({ phase: 'entry', ...base, ...ENTRY, ...extra });
const shards = (shardsResult, extra) => decideStatus({ phase: 'shards', ...base, ...ENTRY, lane: 'full', shardsResult, ...extra });

test('entry: pending when the run gates (either lane), else success "not gated", never for a fork PR', () => {
  assert.deepEqual(entry({}), { post: true, state: 'pending', description: `Selected viewer tests running; ${STUCK}` });
  assert.equal(entry({ mode: 'ON' }).state, 'pending', "Actions' == is case-insensitive");
  assert.equal(entry({ frontend: 'false', rust: 'true' }).state, 'pending');
  assert.deepEqual(entry({ lane: 'full' }), { post: true, state: 'pending', description: `Full lane: waiting for the viewer shards; ${STUCK}` }, 'never success before a shard ran');
  assert.equal(entry({ lane: 'full', frontend: 'false', rust: 'false' }).state, 'success', 'no shard runs: not gated');
  assert.deepEqual(entry({ mode: 'off' }), { post: true, state: 'success', description: 'Not gated on this run (CI_PR_VIEWER_SELECT is "off")' });
  assert.equal(entry({ mode: 'shadow' }).state, 'success');
  assert.equal(entry({ mode: undefined }).state, 'success');
  assert.equal(entry({ frontend: 'false', rust: 'false' }).description, 'Not gated on this run (no frontend or Rust change)');
  assert.equal(entry({ headRepo: 'someone/ifc-lite' }).post, false, 'fork PR: its token cannot write statuses');
  assert.equal(entry({ noop: 'true' }).post, false, 'a no-op edit must not release or reset anything');
  assert.equal(entry({ batch: 'true' }).post, false);
  assert.equal(entry({ event: 'push' }).post, false);
});

test('shards: success only when every shard passed; cancelled or skipped posts nothing', () => {
  assert.deepEqual(shards('success'), { post: true, state: 'success', description: 'Full lane: every viewer shard passed' });
  assert.equal(shards('failure').state, 'failure');
  assert.equal(shards('cancelled').post, false, 'the pending stays');
  assert.equal(shards('skipped').post, false, 'the build failed: the pending stays');
  assert.equal(shards('success', { lane: 'fast' }).post, false, 'the fast lane is the tests job');
  assert.equal(shards('success', { mode: 'shadow' }).post, false);
  assert.equal(shards('success', { headRepo: 'someone/ifc-lite' }).post, false);
});

test('final: a missing verdict names the remedy; expired build artifacts say so', () => {
  assert.deepEqual(final({ downloadOutcome: 'failure', runOutcome: 'skipped', result: null }),
    { post: true, state: 'failure', description: 'Build artifacts unavailable (kept 1 day; download failure); re-run all jobs or push' });
  assert.equal(final({ runOutcome: 'skipped', result: null }).description, 'The selected tests did not report (step skipped); re-run all jobs or push');
  assert.equal(final({ selectOutcome: 'failure' }).description, 'The selection step ended failure; re-run all jobs or push');
  assert.equal(final({ result: { files: 3, passed: false, timedOut: true } }).description, 'The selected tests timed out (3 files); re-run all jobs or push');
  assert.deepEqual(final({ result: { files: 3, passed: false, timedOut: true, notStarted: true } }),
    { post: true, state: 'failure', description: 'No job time left to run the selected tests; re-run all jobs or push' });
  assert.equal(final({ downloadOutcome: 'success', result: { files: 1, passed: true } }).state, 'success');
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

test('final: a selection step that publishes no run decision fails instead of reading as nothing selected', () => {
  assert.equal(final({ run: undefined, runOutcome: 'skipped', result: null }).state, 'failure');
  assert.equal(final({ run: '', runOutcome: 'skipped', result: null }).state, 'failure');
  assert.equal(final({ run: 'TRUE ', runOutcome: 'skipped', result: null }).state, 'failure');
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
async function withApi(code, fn, reads = {}) {
  const posts = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      if (req.method === 'GET') {
        const read = reads[req.url];
        const data = typeof read === 'function' ? await read() : read;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data ?? { jobs: [{ name: 'Viewer tests, advisory (selected for this PR)', html_url: 'https://github.com/x/job/9' }] }));
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
const STATUS_PATH = `/repos/${REPO}/commits/${SHA}/status?per_page=100`;
const RUNS_PATH = `/repos/${REPO}/actions/workflows/test.yml/runs?event=pull_request&head_sha=${SHA}&per_page=100`;
const CANCELLED_ENV = { CANCELLED_RUN_ID: '42', CANCELLED_RUN_ATTEMPT: '1' };
const CANCELLED_RUN = { id: 42, head_sha: SHA, head_repository: { full_name: REPO }, run_attempt: 1, conclusion: 'cancelled' };
const CANCELLED_RUN_URL = `https://github.com/${REPO}/actions/runs/42`;
const CANCELLED_RUN_PATH = `/repos/${REPO}/actions/runs/42`;
const env = (api, extra = {}) => ({
  GITHUB_API_URL: api, GITHUB_TOKEN: 't0k', GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '1',
  HEAD_SHA: SHA, HEAD_REPO: REPO, CI_PR_VIEWER_SELECT: 'on', ...extra,
});

test('cancelled Test completion fails only the pending status owned by that attempt', async () => {
  const runUrl = CANCELLED_RUN_URL;
  const pending = { context: STATUS_CONTEXT, state: 'pending', target_url: `${runUrl}/job/99` };
  const cancelled = CANCELLED_RUN;
  const cases = [
    { run: cancelled, statuses: [pending], expected: true },
    { run: cancelled, statuses: [{ ...pending, target_url: runUrl }], expected: true },
    { run: cancelled, statuses: [{ ...pending, target_url: `${runUrl}0` }], expected: false },
    { run: cancelled, statuses: [{ ...pending, state: 'success' }], expected: false },
    { run: cancelled, statuses: [], expected: false },
    { run: { ...cancelled, run_attempt: 2 }, statuses: [pending], expected: false },
    { run: cancelled, latest: [{ ...cancelled, run_attempt: 2 }], statuses: [pending], expected: false },
    { run: cancelled, latest: [{ ...cancelled, id: 43, conclusion: null }, cancelled], statuses: [pending], expected: false },
    { run: cancelled, latest: [], statuses: [pending], expected: false },
    { run: cancelled, latest: [{ ...cancelled, id: 43, head_repository: { full_name: 'fork/ifc-lite' } }, cancelled], statuses: [pending], expected: true },
    { run: { ...cancelled, conclusion: null }, statuses: [pending], expected: false },
    { run: cancelled, statuses: [pending], headRepo: 'fork/ifc-lite', expected: false },
  ];
  for (const { run, statuses, headRepo, latest = [run], expected } of cases) {
    await withApi(201, async (api, posts) => {
      await main(['--cancelled'], env(api, {
        HEAD_REPO: headRepo ?? REPO, ...CANCELLED_ENV,
      }));
      assert.deepEqual(posts, expected ? [{
        url: `/repos/${REPO}/statuses/${SHA}`,
        auth: 'Bearer t0k',
        body: {
          state: 'failure', context: STATUS_CONTEXT, target_url: runUrl,
          description: 'Test was cancelled before the viewer verdict; re-run all jobs or push',
        },
      }] : []);
    }, {
      [CANCELLED_RUN_PATH]: run,
      [STATUS_PATH]: { statuses },
      [RUNS_PATH]: { workflow_runs: latest },
    });
  }
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

for (const timing of ['before', 'during', 'after']) {
  test(`PR #11355: newest success wins when it lands ${timing} cancellation reporting`, async () => {
    const newer = { ...CANCELLED_RUN, id: 43, conclusion: 'success' };
    let postNewerVerdict;
    let latest = [CANCELLED_RUN];
    let current = { context: STATUS_CONTEXT, state: 'pending', target_url: CANCELLED_RUN_URL };
    await withApi(201, async (api, posts) => {
      postNewerVerdict = async () => {
        latest = [newer, CANCELLED_RUN];
        await main(['--shards'], env(api, {
          ...entryEnv, GITHUB_RUN_ID: String(newer.id), LANE: 'full', SHARDS_RESULT: 'success',
        }));
        current = posts.at(-1).body;
      };
      if (timing === 'before') await postNewerVerdict();
      await main(['--cancelled'], env(api, CANCELLED_ENV));
      if (timing === 'after') await postNewerVerdict();
      assert.deepEqual(posts.map(({ body }) => body.state), timing === 'after' ? ['failure', 'success'] : ['success']);
      assert.equal(posts.at(-1).body.target_url, `https://github.com/${REPO}/actions/runs/${newer.id}`);
    }, {
      [CANCELLED_RUN_PATH]: CANCELLED_RUN,
      [STATUS_PATH]: async () => {
        const snapshot = current;
        if (timing === 'during') await postNewerVerdict();
        return { statuses: [snapshot] };
      },
      [RUNS_PATH]: () => ({ workflow_runs: latest }),
    });
  });
}

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

test('main --shards posts the full-lane verdict, and a failed post fails the (advisory) job', async () => {
  const shardsEnv = { ...entryEnv, LANE: 'full' };
  await withApi(201, async (api, posts) => {
    assert.equal(await main(['--shards'], env(api, { ...shardsEnv, SHARDS_RESULT: 'failure' })), 0);
    assert.equal(await main(['--shards'], env(api, { ...shardsEnv, SHARDS_RESULT: 'cancelled' })), 0);
    assert.equal(posts.length, 1, 'cancelled posts nothing');
    assert.equal(posts[0].body.state, 'failure');
  });
  await withApi(500, async (api) => {
    assert.equal(await main(['--shards'], env(api, { ...shardsEnv, SHARDS_RESULT: 'success' })), 1);
  });
});

test('main: a stalled API ends the post in time: --entry still fails open, --final fails', async () => {
  // Accepts the request and never answers.
  const server = createServer(() => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const api = `http://127.0.0.1:${server.address().port}`;
  try {
    const t0 = Date.now();
    assert.equal(await main(['--entry'], env(api, { ...entryEnv, STATUS_API_TIMEOUT_MS: '200' })), 0);
    const dir = mkdtempSync(join(tmpdir(), 'viewer-status-'));
    assert.equal(await main(['--final', dir], env(api, { JOB_STATUS: 'success', SELECT_OUTCOME: 'success', SELECT_RUN: 'false', STATUS_API_TIMEOUT_MS: '200' })), 1);
    assert.ok(Date.now() - t0 < 10_000, 'bounded by the request deadline, not the job timeout');
  } finally {
    server.closeAllConnections();
    server.close();
  }
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

/** Fast run A leaves `left`, then `ci:full` + close/reopen: B cancels A (which posts nothing). */
function fullLaneAfter(left) {
  const s = sha();
  s.write(entry({}));
  if (left === 'failure') s.write(final({ result: { files: 1, passed: false, failedFiles: ['src/a.test.ts'] } }));
  s.write(final({ jobStatus: 'cancelled', result: null }));
  s.write(entry({ lane: 'full' }));
  assert.equal(s.get(), 'pending', 'B never says success at entry');
  return s;
}

test('ORDERING: a later full-lane run releases a hold the fast run left only when its shards pass', () => {
  for (const left of ['pending', 'failure']) {
    const passed = fullLaneAfter(left);
    passed.write(shards('success'));
    assert.equal(passed.get(), 'success', `${left}, shards passed`);
    const failed = fullLaneAfter(left);
    failed.write(shards('failure'));
    assert.equal(failed.get(), 'failure', `${left}, a shard failed`);
    const cancelled = fullLaneAfter(left);
    cancelled.write(shards('cancelled'));
    assert.equal(cancelled.get(), 'pending', `${left}, B cancelled: still held`);
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

const SHARDS = JOBS['viewer-tests'];
const SHARDS_STATUS = JOBS['viewer-shards-status'];

/**
 * A job's `if:` evaluated for real: a minimal Actions-expression evaluator
 * for the forms these jobs use (`==`, `!=`, `&&`, `||`, parentheses, string
 * literals, three contexts, `!cancelled()` on a run that is not cancelled),
 * case-insensitive like Actions. Throws on anything else, so a new clause
 * cannot read as "runs".
 */
function jobRuns(job, ctx) {
  const lit = (v) => JSON.stringify(String(v ?? '').toLowerCase());
  const js = String(job.if)
    .replace(/'([^']*)'/g, (_, v) => lit(v))
    .replace(/!cancelled\(\)/g, 'true')
    .replace(/\bvars\.CI_PR_VIEWER_SELECT\b/g, lit(ctx.mode))
    .replace(/\bgithub\.event_name\b/g, lit(ctx.event))
    .replace(/\bneeds\.changes\.outputs\.(\w+)\b/g, (_, k) => lit(ctx[k]))
    .replace(/\bneeds\.viewer-tests\.result\b/g, lit(ctx.shardsResult))
    .replace(/==/g, '===').replace(/!===/g, '!==');
  if (!/^[\s"a-z_.\-()&|=!]*$/.test(js)) throw new Error(`cannot evaluate ${job.name}'s if: ${js}`); // @source-text-assertion-ok evaluator guard: refuses a workflow expression it cannot evaluate, rather than reading it as true
  return Function(`return (${js});`)();
}

test('WIRING: entry gates exactly the runs a verdict job will close, on either lane', () => {
  let cases = 0;
  for (const mode of ['on', 'shadow', 'off', ''])
    for (const lane of ['fast', 'full'])
      for (const frontend of ['true', 'false'])
        for (const rust of ['true', 'false']) {
          const ctx = { ...ENTRY, replay: 'false', mode, lane, frontend, rust };
          const on = mode === 'on';
          const selected = jobRuns(TESTS, ctx) && on;
          const shardsRan = jobRuns(SHARDS, ctx);
          const full = shardsRan && on;
          const d = entry(ctx);
          assert.equal(d.state === 'pending', selected || full, `pending iff a verdict follows: ${JSON.stringify(ctx)}`);
          for (const result of ['success', 'failure']) {
            const after = { ...ctx, shardsResult: shardsRan ? result : 'skipped' };
            assert.equal(jobRuns(SHARDS_STATUS, after), full, `the full-lane verdict job runs exactly when the shards gate: ${JSON.stringify(after)}`);
          }
          assert.equal(jobRuns(SHARDS_STATUS, { ...ctx, shardsResult: 'cancelled' }), false, 'cancelled shards: no verdict job');
          if (full) assert.equal(shards('success', ctx).state, 'success', 'and it can close what entry opened');
          assert.ok(!(selected && full), 'one verdict per run');
          cases += 1;
        }
  assert.equal(cases, 32);
  for (const job of [TESTS, SHARDS_STATUS]) {
    const ran = { ...ENTRY, lane: job === TESTS ? 'fast' : 'full', mode: 'on', shardsResult: 'success' };
    assert.equal(jobRuns(job, ran), true, `${job.name}: the base case runs`);
    assert.equal(jobRuns(job, { ...ran, noop: 'true' }), false, `${job.name}: a no-op edit (entry posts nothing)`);
    assert.equal(jobRuns(job, { ...ran, batch: 'true' }), false, `${job.name}: a batch`);
  }
});

test('WIRING: the full-lane verdict job reads the shards, after `changes`, advisory to the run', () => {
  assert.deepEqual(SHARDS_STATUS.needs, ['changes', 'viewer-tests']);
  assert.equal(SHARDS_STATUS['continue-on-error'], true);
  assert.deepEqual(SHARDS_STATUS.permissions, { contents: 'read', statuses: 'write' }, 'the only write is the status');
  const step = SHARDS_STATUS.steps.at(-1);
  /* eslint-disable no-template-curly-in-string */
  assert.equal(step.env.SHARDS_RESULT, '${{ needs.viewer-tests.result }}');
  assert.equal(step.env.HEAD_SHA, '${{ github.event.pull_request.head.sha }}');
  /* eslint-enable no-template-curly-in-string */
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

test('WIRING: only `changes`, the tests job and the full-lane verdict job write statuses, on the PR head', () => {
  const writers = ['changes', 'viewer-tests-selected', 'viewer-shards-status'];
  for (const [key, job] of Object.entries(JOBS)) {
    assert.equal(job.permissions?.statuses === 'write', writers.includes(key), key);
  }
  for (const s of [ENTRY_STEP, FINAL_STEP]) {
    /* eslint-disable no-template-curly-in-string */
    assert.equal(s.env.HEAD_SHA, '${{ github.event.pull_request.head.sha }}', 'the head, not the merge commit');
    assert.equal(s.env.HEAD_REPO, '${{ github.event.pull_request.head.repo.full_name }}');
    /* eslint-enable no-template-curly-in-string */
  }
  assert.equal(FINAL_STEP.env.JOB_NAME, TESTS.name, 'the job-link lookup matches by name');
  const rerun = TESTS.steps.find((s) => s.name === 'Post the PR viewer selection status as pending');
  assert.equal(rerun.env.JOB_NAME, TESTS.name, 'a stuck pending links the job to re-run');
  /* eslint-disable-next-line no-template-curly-in-string */
  assert.equal(FINAL_STEP.env.DOWNLOAD_OUTCOME, '${{ steps.download.outcome }}');
  assert.ok(TESTS.steps.some((s) => s.id === 'download'), 'the download step the status reads');
  /* eslint-disable-next-line no-template-curly-in-string */
  assert.equal(FINAL_STEP.if, '${{ !cancelled() }}', 'posts after a failed step, never after cancellation');
});

test('WIRING: .mergify.yml keeps a failing or pending status out, by the name this script posts', () => {
  const cfg = parse(readFileSync(join(REPO_ROOT, '.mergify.yml'), 'utf8'));
  const gate = JSON.stringify(cfg.merge_protections_settings.auto_merge_conditions);
  assert.ok(gate.includes(`-check-failure=${STATUS_CONTEXT}`)); // @source-text-assertion-ok subject is the parsed config
  assert.ok(gate.includes(`-check-pending=${STATUS_CONTEXT}`)); // @source-text-assertion-ok subject is the parsed config
});

test('WIRING: all status writers queue in the same per-head-SHA concurrency group', () => {
  const path = join(REPO_ROOT, '.github/workflows/viewer-selection-cancelled.yml');
  const reporter = existsSync(path) ? parse(readFileSync(path, 'utf8')).jobs.report : undefined;
  /* eslint-disable no-template-curly-in-string */
  assert.deepEqual(reporter?.concurrency, {
    group: 'viewer-selection-status-${{ github.event.workflow_run.head_sha }}', queue: 'max',
  });
  for (const job of [CHANGES, TESTS, SHARDS_STATUS]) {
    assert.deepEqual(job.concurrency, {
      group: 'viewer-selection-status-${{ github.event.pull_request.head.sha || github.run_id }}', queue: 'max',
    }, job.name);
  }
  /* eslint-enable no-template-curly-in-string */
});
