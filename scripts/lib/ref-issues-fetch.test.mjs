/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Unit tests for the GraphQL-fetching half of #4147's honest-partial-work
 * path, split out of `issue-refs.test.mjs` alongside `./ref-issues-fetch.mjs`
 * itself (#4180 finding B). `check-issue-queue.test.mjs` covers the
 * end-to-end verdicts through the gate's own CLI; this file covers the
 * fail-closed live-fetch wrapper in isolation, the way it couldn't be reached
 * from the end-to-end harness without a real `gh` process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRefsQuery,
  mapRefsPayload,
  fetchRefsPayload,
  buildRefIssues,
  fetchRefIssuesIfNeeded,
} from './ref-issues-fetch.mjs';

// -------------------------------------------------------------- buildRefsQuery

test('buildRefsQuery: aliases r0, r1, ... in call order, one issue(number:N) per entry', () => {
  const q = buildRefsQuery([5, 42]);
  assert.match(q, /r0: issue\(number:5\)/);
  assert.match(q, /r1: issue\(number:42\)/);
  assert.match(q, /query\(\$owner:String!, \$name:String!\)/);
});

test('buildRefsQuery: an empty list still produces a syntactically closed query', () => {
  const q = buildRefsQuery([]);
  assert.match(q, /repository\(owner:\$owner, name:\$name\) \{\s*\}/);
});

// -------------------------------------------------------------- mapRefsPayload

test('mapRefsPayload: maps each alias back to its issue number', () => {
  const payload = { data: { repository: { r0: { number: 5 }, r1: null } } };
  assert.deepEqual(mapRefsPayload(payload, [5, 9]), { 5: { number: 5 }, 9: null });
});

test('mapRefsPayload: a missing repository maps every number to null', () => {
  assert.deepEqual(mapRefsPayload({ data: {} }, [1, 2]), { 1: null, 2: null });
});

// -------------------------------------------------------------- fetchRefsPayload

function fakeSpawn(result) {
  return () => result;
}

test('fetchRefsPayload: numbers.length === 0 never calls gh', () => {
  let called = false;
  const out = fetchRefsPayload({
    repo: 'a/b',
    numbers: [],
    spawn: () => {
      called = true;
      return { status: 0, stdout: '{}' };
    },
    fail: () => {
      throw new Error('should not fail');
    },
  });
  assert.deepEqual(out, {});
  assert.equal(called, false);
});

// `fail` is contractually `(reason, message) => never` (mirrors `existsOrThrow`):
// every real caller's `fail` throws, so `fetchRefsPayload` never checks a
// return value and falls through to the NEXT check if `fail` does not
// actually stop execution. These tests throw a tagged error from `fail`,
// exactly like the gate's real `(reason, message) => { throw new
// IssueQueueError(reason, message); }`, so a fail-closed path that forgot to
// stop would surface as the WRONG reason reaching the assertion, not a false
// pass.
class Failed extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}
const throwingFail = (reason, message) => {
  throw new Failed(reason, message);
};

test('fetchRefsPayload: a spawn error is fail-closed as GH_UNAVAILABLE', () => {
  assert.throws(
    () => fetchRefsPayload({ repo: 'a/b', numbers: [1], spawn: fakeSpawn({ error: new Error('ENOENT') }), fail: throwingFail }),
    (err) => err instanceof Failed && err.reason === 'GH_UNAVAILABLE',
  );
});

test('fetchRefsPayload: GraphQL errors are fail-closed as GRAPHQL_ERRORS', () => {
  assert.throws(
    () =>
      fetchRefsPayload({
        repo: 'a/b',
        numbers: [1],
        spawn: fakeSpawn({ status: 1, stdout: JSON.stringify({ errors: [{ message: 'nope' }] }) }),
        fail: throwingFail,
      }),
    (err) => err instanceof Failed && err.reason === 'GRAPHQL_ERRORS',
  );
});

test('fetchRefsPayload: a non-zero exit with no GraphQL errors is fail-closed as GH_ERROR', () => {
  assert.throws(
    () =>
      fetchRefsPayload({
        repo: 'a/b',
        numbers: [1],
        spawn: fakeSpawn({ status: 1, stdout: '{}', stderr: 'boom' }),
        fail: throwingFail,
      }),
    (err) => err instanceof Failed && err.reason === 'GH_ERROR',
  );
});

test('fetchRefsPayload: unparseable stdout is fail-closed as GH_BAD_JSON', () => {
  assert.throws(
    () => fetchRefsPayload({ repo: 'a/b', numbers: [1], spawn: fakeSpawn({ status: 0, stdout: 'not json' }), fail: throwingFail }),
    (err) => err instanceof Failed && err.reason === 'GH_BAD_JSON',
  );
});

test('fetchRefsPayload: a clean read maps numbers to nodes', () => {
  const stdout = JSON.stringify({ data: { repository: { r0: { number: 7, state: 'OPEN' } } } });
  const out = fetchRefsPayload({
    repo: 'a/b',
    numbers: [7],
    spawn: fakeSpawn({ status: 0, stdout }),
    fail: () => {
      throw new Error('should not fail');
    },
  });
  assert.deepEqual(out, { 7: { number: 7, state: 'OPEN' } });
});

// -------------------------------------------------------------- buildRefIssues

const passthroughLabelSet = (conn) => (conn?.nodes ?? []).map((n) => n.name);
const passthroughTimelineOf = (conn) => conn ?? null;

test('buildRefIssues: excludes a number already in closingIssueNodes', () => {
  const out = buildRefIssues(
    'Refs #9',
    [{ number: 9 }],
    { 9: { number: 9, title: 't', state: 'OPEN', labels: { nodes: [] }, timelineItems: null } },
    passthroughLabelSet,
    passthroughTimelineOf,
  );
  assert.deepEqual(out, []);
});

test('buildRefIssues: a referenced number never resolved is silently dropped', () => {
  const out = buildRefIssues('Refs #9', [], {}, passthroughLabelSet, passthroughTimelineOf);
  assert.deepEqual(out, []);
});

test('buildRefIssues: a resolved referenced issue is normalised like a closing one', () => {
  const out = buildRefIssues(
    'Refs #9',
    [],
    { 9: { number: 9, title: 'hello', state: 'OPEN', labels: { nodes: [{ name: 'ready' }] }, timelineItems: null } },
    passthroughLabelSet,
    passthroughTimelineOf,
  );
  assert.deepEqual(out, [{ number: 9, title: 'hello', state: 'OPEN', labels: ['ready'], labelHistory: null }]);
});

// -------------------------------------------------------------- fetchRefIssuesIfNeeded

test('fetchRefIssuesIfNeeded: closingIssuesReferences non-empty never calls gh', () => {
  let called = false;
  const out = fetchRefIssuesIfNeeded({
    payload: {
      data: {
        repository: {
          pullRequest: { body: 'Refs #9', closingIssuesReferences: { nodes: [{ number: 1 }] } },
        },
      },
    },
    repo: 'a/b',
    spawn: () => {
      called = true;
      return { status: 0, stdout: '{}' };
    },
    fail: () => {
      throw new Error('should not fail');
    },
  });
  assert.deepEqual(out, {});
  assert.equal(called, false);
});

test('fetchRefIssuesIfNeeded: no body references never calls gh', () => {
  let called = false;
  const out = fetchRefIssuesIfNeeded({
    payload: {
      data: { repository: { pullRequest: { body: 'nothing here', closingIssuesReferences: { nodes: [] } } } },
    },
    repo: 'a/b',
    spawn: () => {
      called = true;
      return { status: 0, stdout: '{}' };
    },
    fail: () => {
      throw new Error('should not fail');
    },
  });
  assert.deepEqual(out, {});
  assert.equal(called, false);
});

test('fetchRefIssuesIfNeeded: closes nothing and body has Refs -- calls gh', () => {
  let called = false;
  const stdout = JSON.stringify({ data: { repository: { r0: { number: 9 } } } });
  const out = fetchRefIssuesIfNeeded({
    payload: {
      data: { repository: { pullRequest: { body: 'Refs #9', closingIssuesReferences: { nodes: [] } } } },
    },
    repo: 'a/b',
    spawn: () => {
      called = true;
      return { status: 0, stdout };
    },
    fail: () => {
      throw new Error('should not fail');
    },
  });
  assert.equal(called, true);
  assert.deepEqual(out, { 9: { number: 9 } });
});

