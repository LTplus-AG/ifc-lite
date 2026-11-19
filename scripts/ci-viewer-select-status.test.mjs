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

test('only `on` posts, and never for a fork PR', () => {
  assert.equal(decideStatus({ phase: 'pending', ...base, mode: 'shadow' }).post, false);
  assert.equal(decideStatus({ phase: 'pending', ...base, mode: undefined }).post, false);
  assert.equal(decideStatus({ phase: 'pending', ...base, mode: 'ON' }).post, true, "Actions' == is case-insensitive");
  assert.match(decideStatus({ phase: 'pending', ...base, headRepo: 'someone/ifc-lite' }).reason, /fork PR/);
  assert.deepEqual(decideStatus({ phase: 'pending', ...base }), { post: true, state: 'pending', description: 'Selected viewer tests are running' });
});

test('final: success when the files passed (a retry counts) or nothing was selected', () => {
  assert.deepEqual(final({ result: { files: 3, passed: true } }), { post: true, state: 'success', description: '3 selected files passed' });
  assert.equal(final({ result: { files: 1, passed: true, passedOnRetry: ['src/a.test.ts'] } }).description, '1 selected file passed (1 after a retry)');
  assert.equal(final({ run: 'false', runOutcome: 'skipped', result: null }).state, 'success');
});

test('final: failure names the failing files, and every missing verdict is a failure', () => {
  const failed = final({ result: { files: 4, passed: false, failedFiles: ['src/a.test.ts', 'src/b.test.tsx'] } });
  assert.deepEqual(failed, { post: true, state: 'failure', description: '2 of 4 selected files failed: src/a.test.ts, src/b.test.tsx' });
  assert.match(final({ result: { files: 2, passed: false, failedFiles: [] } }).description, /no file could be tied to/);
  assert.equal(final({ jobStatus: 'cancelled', result: { files: 1, passed: true } }).state, 'failure', 'cancelled: no verdict');
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

test('main: a failed post fails --final (the pending status still holds the gate) but never --pending', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'viewer-status-'));
  await withApi(500, async (api, posts) => {
    assert.equal(await main(['--pending'], env(api)), 0, 'the tests job depends on the pending job');
    assert.equal(await main(['--final', dir], env(api, { JOB_STATUS: 'success', SELECT_OUTCOME: 'success', SELECT_RUN: 'false' })), 1);
    assert.equal(posts.length, 2);
    assert.equal(posts[0].body.state, 'pending');
  });
});

test('main: a fork PR or `shadow` posts nothing', async () => {
  await withApi(201, async (api, posts) => {
    assert.equal(await main(['--pending'], env(api, { HEAD_REPO: 'someone/ifc-lite' })), 0);
    assert.equal(await main(['--pending'], env(api, { CI_PR_VIEWER_SELECT: 'shadow' })), 0);
    assert.equal(posts.length, 0);
  });
});

// ---------------------------------------------------------------- the wiring

const JOBS = parse(readFileSync(join(REPO_ROOT, '.github/workflows/test.yml'), 'utf8')).jobs;
const PENDING = JOBS['viewer-selection-pending'];
const TESTS = JOBS['viewer-tests-selected'];
const squash = (s) => String(s).replace(/\s+/g, ' ').trim();

test('WIRING: the pending job runs on the tests job lane, `on` only, and the tests job waits for it', () => {
  const lane = [
    "github.event_name == 'pull_request'",
    "needs.changes.outputs.lane == 'fast'",
    "needs.changes.outputs.batch != 'true'",
    "needs.changes.outputs.noop != 'true'",
    "(needs.changes.outputs.frontend == 'true' || needs.changes.outputs.rust == 'true')",
  ];
  for (const clause of lane) {
    assert.ok(squash(PENDING.if).includes(clause), `pending: ${clause}`); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML; there is no runtime to drive instead
    assert.ok(squash(TESTS.if).includes(clause), `tests: ${clause}`); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML; there is no runtime to drive instead
  }
  assert.ok(squash(PENDING.if).includes("vars.CI_PR_VIEWER_SELECT == 'on'")); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML; there is no runtime to drive instead
  assert.ok(TESTS.needs.includes('viewer-selection-pending'), 'its pending status can never land after the verdict');
  // In shadow the pending job is skipped; without these the tests job would be skipped with it.
  assert.ok(squash(TESTS.if).startsWith("!cancelled() && needs.build.result == 'success' &&")); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML; there is no runtime to drive instead
  assert.equal(PENDING['continue-on-error'], true, 'like the tests job, it cannot fail the Test run');
});

test('WIRING: only these two jobs may write statuses, and both post on the PR head', () => {
  for (const [key, job] of Object.entries(JOBS)) {
    const writes = job.permissions?.statuses === 'write';
    assert.equal(writes, key === 'viewer-selection-pending' || key === 'viewer-tests-selected', key);
  }
  const steps = [PENDING.steps.at(-1), TESTS.steps.find((s) => s.name === 'Post the PR viewer selection status')];
  for (const s of steps) {
    /* eslint-disable no-template-curly-in-string */
    assert.equal(s.env.HEAD_SHA, '${{ github.event.pull_request.head.sha }}', 'the head, not the merge commit');
    assert.equal(s.env.HEAD_REPO, '${{ github.event.pull_request.head.repo.full_name }}');
    /* eslint-enable no-template-curly-in-string */
  }
  const finalStep = steps[1];
  assert.equal(finalStep.env.JOB_NAME, TESTS.name, 'the job-link lookup matches by name');
  assert.ok(String(PENDING.steps.at(-1).run).includes('--pending')); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML; there is no runtime to drive instead
});

test('WIRING: .mergify.yml keeps a failing or pending status out, by the name this script posts', () => {
  const cfg = parse(readFileSync(join(REPO_ROOT, '.mergify.yml'), 'utf8'));
  const gate = JSON.stringify(cfg.merge_protections_settings.auto_merge_conditions);
  assert.ok(gate.includes(`-check-failure=${STATUS_CONTEXT}`)); // @source-text-assertion-ok subject is the parsed config
  assert.ok(gate.includes(`-check-pending=${STATUS_CONTEXT}`)); // @source-text-assertion-ok subject is the parsed config
});
