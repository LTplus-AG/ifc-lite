/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5729: the dirty-PR scan went red on `main` run after run because its one
 * `gh pr list ... statusCheckRollup --limit 100` GraphQL query timed out at
 * the gateway (HTTP 504). These drive `fetchOpenPrs` through a fake `gh` that
 * answers the way the real one does, including the 504, so each property is
 * checked without the network:
 *   - no single call asks for more than one PR's rollup;
 *   - a transient 5xx is retried, and a persistent one still FAILS (the scan's
 *     exit 2, "could not look"), never an empty list;
 *   - a non-transient error is not retried;
 *   - a PR that closed between the list and its own fetch is dropped.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchOpenPrs, ghJsonWithRetry, PR_FIELDS } from './open-pr-fetch.mjs';

class ScanError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}
const fail = (reason, message) => new ScanError(reason, message);
const GATEWAY = 'HTTP 504: 504 Gateway Timeout (https://api.github.com/graphql)';

const pr = (number, extra = {}) => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  baseRefName: 'main',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  isDraft: false,
  statusCheckRollup: [{ __typename: 'CheckRun', name: 'Lint', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  state: 'OPEN',
  ...extra,
});

/**
 * A fake `gh`. The ONE query shape GitHub times out on -- a list that asks for
 * `statusCheckRollup` -- always answers 504, which is the production defect.
 */
function fakeGh({ open, viewFailures = {}, listFailures = 0 }) {
  const calls = [];
  const failuresLeft = { ...viewFailures };
  let listFailuresLeft = listFailures;
  const run = async (args) => {
    calls.push(args);
    const json = args[args.indexOf('--json') + 1] ?? '';
    if (args[0] === 'pr' && args[1] === 'list') {
      if (json.includes('statusCheckRollup')) return { status: 1, stdout: '', stderr: GATEWAY };
      if (listFailuresLeft > 0) {
        listFailuresLeft -= 1;
        return { status: 1, stdout: '', stderr: GATEWAY };
      }
      return { status: 0, stdout: JSON.stringify(open.map((p) => ({ number: p.number }))), stderr: '' };
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      const n = Number(args[2]);
      const f = failuresLeft[n];
      if (f && f.times > 0) {
        f.times -= 1;
        return { status: 1, stdout: '', stderr: f.stderr };
      }
      const row = open.find((p) => p.number === n);
      const fields = json.split(',');
      return {
        status: 0,
        stdout: JSON.stringify(Object.fromEntries(fields.map((k) => [k, row[k]]))),
        stderr: '',
      };
    }
    return { status: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
  };
  return { run, calls };
}

const quiet = { sleep: async () => {}, log: () => {}, backoffMs: [1, 1, 1] };

test('#5729 GREEN: every open PR comes back in `gh pr list --json` shape, one rollup per call', async () => {
  const open = [pr(12), pr(7, { mergeable: 'CONFLICTING', statusCheckRollup: [] }), pr(3)];
  const gh = fakeGh({ open });
  const prs = await fetchOpenPrs({ repo: 'o/r', limit: 100, fail, ghOptions: { ...quiet, run: gh.run } });
  assert.deepEqual(prs.map((p) => p.number), [12, 7, 3], 'list order is kept');
  for (const p of prs) {
    assert.deepEqual(Object.keys(p).sort(), PR_FIELDS.split(',').sort(), 'exactly the old fields, `state` dropped');
  }
  assert.equal(prs[1].mergeable, 'CONFLICTING');
  for (const args of gh.calls) {
    if (args[1] === 'list') assert.ok(!args.join(' ').includes('statusCheckRollup'), 'the list call is the cheap one');
  }
  assert.equal(gh.calls.filter((a) => a[1] === 'view').length, 3);
});

test('#5729 RED shape: the old single heavy query is exactly what the fake (and GitHub) time out on', async () => {
  const gh = fakeGh({ open: [pr(1)] });
  await assert.rejects(
    ghJsonWithRetry({
      ...quiet,
      run: gh.run,
      args: ['pr', 'list', '--state', 'open', '--json', PR_FIELDS, '--limit', '100', '--repo', 'o/r'],
      what: 'the open PR list',
      fail,
    }),
    (e) => e.reason === 'GH_ERROR' && /504/.test(e.message) && /after 3 retries/.test(e.message),
  );
});

test('#5729: a transient 504 on one PR is retried and the scan completes', async () => {
  const open = [pr(1), pr(2)];
  const gh = fakeGh({ open, viewFailures: { 2: { times: 2, stderr: GATEWAY } }, listFailures: 1 });
  const logged = [];
  const prs = await fetchOpenPrs({
    repo: 'o/r',
    limit: 100,
    fail,
    ghOptions: { ...quiet, run: gh.run, log: (l) => logged.push(l) },
  });
  assert.deepEqual(prs.map((p) => p.number), [1, 2]);
  assert.equal(logged.length, 3, 'one list retry and two view retries, each logged');
});

test('#5729 CONTRACT: a 5xx that outlasts the retries still FAILS -- never a partial or empty list', async () => {
  const open = [pr(1), pr(2)];
  const gh = fakeGh({ open, viewFailures: { 2: { times: 99, stderr: GATEWAY } } });
  await assert.rejects(
    fetchOpenPrs({ repo: 'o/r', limit: 100, fail, ghOptions: { ...quiet, run: gh.run } }),
    (e) => e instanceof ScanError && e.reason === 'GH_ERROR' && /PR #2/.test(e.message),
  );
});

test('#5729: a non-transient error is not retried', async () => {
  const gh = fakeGh({ open: [pr(1)], viewFailures: { 1: { times: 1, stderr: 'HTTP 401: Bad credentials' } } });
  await assert.rejects(
    fetchOpenPrs({ repo: 'o/r', limit: 100, fail, ghOptions: { ...quiet, run: gh.run } }),
    (e) => e.reason === 'GH_ERROR' && /401/.test(e.message) && !/retr/.test(e.message),
  );
  assert.equal(gh.calls.filter((a) => a[1] === 'view').length, 1);
});

test('#5729: a PR that closed between the list and its fetch is dropped, not scanned', async () => {
  const open = [pr(1), pr(2, { state: 'MERGED' }), pr(3)];
  const gh = fakeGh({
    open,
    viewFailures: { 3: { times: 1, stderr: "GraphQL: Could not resolve to a PullRequest with the number of 3." } },
  });
  const prs = await fetchOpenPrs({ repo: 'o/r', limit: 100, fail, ghOptions: { ...quiet, run: gh.run } });
  assert.deepEqual(prs.map((p) => p.number), [1]);
});

test('#5729: an unreadable number list fails closed', async () => {
  const run = async () => ({ status: 0, stdout: '{"not":"an array"}', stderr: '' });
  await assert.rejects(
    fetchOpenPrs({ repo: 'o/r', limit: 100, fail, ghOptions: { ...quiet, run } }),
    (e) => e.reason === 'GH_BAD_JSON',
  );
  const run2 = async () => ({ status: 0, stdout: '[{"number":"x"}]', stderr: '' });
  await assert.rejects(
    fetchOpenPrs({ repo: 'o/r', limit: 100, fail, ghOptions: { ...quiet, run: run2 } }),
    (e) => e.reason === 'GH_BAD_JSON',
  );
});

test('#5729: zero open PRs is an empty list after a SUCCESSFUL list call', async () => {
  const gh = fakeGh({ open: [] });
  assert.deepEqual(await fetchOpenPrs({ repo: 'o/r', limit: 100, fail, ghOptions: { ...quiet, run: gh.run } }), []);
});

test('#5729 review: a row without a known state is UNREADABLE and fails, never silently dropped', async () => {
  for (const bad of [{ number: 1 }, null, [], { number: 2, state: 'OPEN' }]) {
    const run = async (args) =>
      args[1] === 'list'
        ? { status: 0, stdout: '[{"number":1}]', stderr: '' }
        : { status: 0, stdout: JSON.stringify(bad), stderr: '' };
    await assert.rejects(
      fetchOpenPrs({ repo: 'o/r', limit: 100, fail, ghOptions: { ...quiet, run } }),
      (e) => e.reason === 'GH_BAD_JSON',
      JSON.stringify(bad),
    );
  }
});

test("#5729 review: GraphQL's own query-timeout message is retried like a 504", async () => {
  const open = [pr(1)];
  const gh = fakeGh({
    open,
    viewFailures: {
      1: { times: 1, stderr: 'GraphQL: Something went wrong while executing your query. This may be the result of a timeout.' },
    },
  });
  const prs = await fetchOpenPrs({ repo: 'o/r', limit: 100, fail, ghOptions: { ...quiet, run: gh.run } });
  assert.deepEqual(prs.map((p) => p.number), [1]);
});

test('#5729 review: after one PR fails for good, the other workers stop taking new PRs', async () => {
  const open = Array.from({ length: 20 }, (_, i) => pr(i + 1));
  const gh = fakeGh({ open, viewFailures: { 1: { times: 99, stderr: 'HTTP 401: Bad credentials' } } });
  await assert.rejects(
    fetchOpenPrs({ repo: 'o/r', limit: 100, fail, concurrency: 2, ghOptions: { ...quiet, run: gh.run } }),
    (e) => e.reason === 'GH_ERROR',
  );
  const views = gh.calls.filter((a) => a[1] === 'view').length;
  assert.ok(views < 20, `only ${views} of 20 PRs were fetched after the failure`);
});
