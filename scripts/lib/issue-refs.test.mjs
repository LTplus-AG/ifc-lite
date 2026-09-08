/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Unit tests for the #4147 PARTIAL_WORK machinery in `issue-refs.mjs`.
 * `check-issue-queue.test.mjs` covers the end-to-end verdicts through the
 * gate's own CLI; this file covers the pure pieces in isolation, including
 * the regex edge cases and the fail-closed live-fetch wrapper that the
 * end-to-end harness cannot reach without a real `gh` process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractRefIssueNumbers,
  buildRefsQuery,
  mapRefsPayload,
  fetchRefsPayload,
  buildRefIssues,
  fetchRefIssuesIfNeeded,
  partialWorkVerdict,
  unqueuedRefsNote,
} from './issue-refs.mjs';

// ------------------------------------------------------- extractRefIssueNumbers

test('extractRefIssueNumbers: matches Refs, References, Part of, Towards, any case, one per line', () => {
  // Each on its own line, which is how these actually appear in a PR body --
  // the keyword must START its line (see the module header); a real body
  // does not run five of these together in one sentence.
  const body = 'Refs #1.\nreferences #2.\nPART OF #3.\ntowards #4.\nREF #5.';
  assert.deepEqual(extractRefIssueNumbers(body), [1, 2, 3, 4, 5]);
});

test('extractRefIssueNumbers: a colon after the keyword is accepted', () => {
  assert.deepEqual(extractRefIssueNumbers('Refs: #7'), [7]);
});

test('extractRefIssueNumbers: after a list marker (-, *, +, 1., 1)) is accepted', () => {
  assert.deepEqual(extractRefIssueNumbers('- Refs #1\n* References #2\n+ Part of #3\n1. Towards #4\n2) Refs #5'), [
    1, 2, 3, 4, 5,
  ]);
});

test('extractRefIssueNumbers: does NOT match Closes/Fixes/Resolves', () => {
  // Those are read from `closingIssuesReferences`, never from the body -- see
  // the module header. This regex must not duplicate that signal.
  assert.deepEqual(extractRefIssueNumbers('Closes #1, Fixes #2, Resolves #3'), []);
});

test('extractRefIssueNumbers: a doubled # or a word ending in the keyword does not match', () => {
  assert.deepEqual(extractRefIssueNumbers('Prefs #1 ##2'), []);
});

test('extractRefIssueNumbers: de-duplicates and preserves first-seen order', () => {
  assert.deepEqual(extractRefIssueNumbers('Refs #9.\nRefs #3.\nRefs #9 again.'), [9, 3]);
});

test('extractRefIssueNumbers: a non-closing sentence naming Closes inside it still does not match', () => {
  // The #2978 lesson (see check-issue-queue.mjs PART 1) is about the CLOSING
  // scanner having no notion of negation. This regex is not that scanner and
  // is never consulted for the closing signal, but it must not accidentally
  // start matching "close" as if it were "refs" either.
  assert.deepEqual(extractRefIssueNumbers('This does not close #2934.\nRefs #10'), [10]);
});

test('extractRefIssueNumbers: "refs" used as an ordinary verb mid-sentence does not match', () => {
  // The prose case: the word appears, but not as a line-leading keyword, so
  // it carries no intent to reference a queue entry. See the module header.
  assert.deepEqual(extractRefIssueNumbers('this function refs #12 in a loop'), []);
});

test('extractRefIssueNumbers: a fenced code block is not scanned', () => {
  assert.deepEqual(extractRefIssueNumbers('This PR fixes a typo.\n\n```\nRefs #12\n```\n'), []);
});

test('extractRefIssueNumbers: a ~~~ fence and an indented fence are also stripped', () => {
  assert.deepEqual(extractRefIssueNumbers('~~~\nRefs #12\n~~~'), []);
  assert.deepEqual(extractRefIssueNumbers('  ```\n  Refs #12\n  ```'), []);
});

test('extractRefIssueNumbers: an inline code span is not scanned', () => {
  assert.deepEqual(extractRefIssueNumbers('See the literal text `Refs #12` in the log output.'), []);
});

test('extractRefIssueNumbers: a blockquoted line is not scanned', () => {
  assert.deepEqual(extractRefIssueNumbers('> Refs #12\n> was someone else\'s comment'), []);
});

test('extractRefIssueNumbers: stripping a fence/span/quote does not eat a real reference on another line', () => {
  const body = [
    'This PR does the actual work.',
    '',
    '```',
    'Refs #999 -- an example from someone else\'s commit',
    '```',
    '',
    '> quoting a reviewer who wrote Refs #888',
    '',
    'Refs #12',
  ].join('\n');
  assert.deepEqual(extractRefIssueNumbers(body), [12]);
});

test('extractRefIssueNumbers: the confirmed hole -- an unrelated PR quoting a ready issue in a code block', () => {
  const body = "This PR fixes an unrelated typo in the README\n\n```\nRefs #3525\n```\n";
  assert.deepEqual(extractRefIssueNumbers(body), []);
});

test('extractRefIssueNumbers: absent, non-string, or empty body is simply no references', () => {
  assert.deepEqual(extractRefIssueNumbers(undefined), []);
  assert.deepEqual(extractRefIssueNumbers(null), []);
  assert.deepEqual(extractRefIssueNumbers(42), []);
  assert.deepEqual(extractRefIssueNumbers(''), []);
});

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

// -------------------------------------------------------------- partialWorkVerdict

const adjudicateAlwaysReady = () => ({ ok: true, applier: 'louistrue', at: '2026-09-08T00:00:00Z' });
const adjudicateNeverReady = () => ({ ok: false, applier: null, at: null });

test('partialWorkVerdict: null when no referenced issue is ready', () => {
  const out = partialWorkVerdict({
    refIssues: [{ number: 1, title: 't', state: 'OPEN' }],
    readyLabel: 'ready',
    adjudicateLabel: adjudicateNeverReady,
    escapeProblem: null,
    escapeReason: null,
  });
  assert.equal(out, null);
});

test('partialWorkVerdict: null when the only ready referenced issue is CLOSED', () => {
  // "a closed issue is not a queue entry" -- the #4147 mitigation.
  const out = partialWorkVerdict({
    refIssues: [{ number: 1, title: 't', state: 'CLOSED' }],
    readyLabel: 'ready',
    adjudicateLabel: adjudicateAlwaysReady,
    escapeProblem: null,
    escapeReason: null,
  });
  assert.equal(out, null);
});

test('partialWorkVerdict: an OPEN, ready referenced issue passes as PARTIAL_WORK', () => {
  const out = partialWorkVerdict({
    refIssues: [{ number: 42, title: 'the thing', state: 'OPEN' }],
    readyLabel: 'ready',
    adjudicateLabel: adjudicateAlwaysReady,
    escapeProblem: null,
    escapeReason: null,
  });
  assert.equal(out.ok, true);
  assert.equal(out.verdict, 'PARTIAL_WORK');
  assert.equal(out.escapeProblem, null);
  assert.match(out.lines.join('\n'), /PARTIAL_WORK: references #42 \(OPEN\)/);
  assert.match(out.lines.join('\n'), /applied by `louistrue`/);
});

test('partialWorkVerdict: a real escape problem is still reported as a note on a PASS', () => {
  const out = partialWorkVerdict({
    refIssues: [{ number: 42, title: 'x', state: 'OPEN' }],
    readyLabel: 'ready',
    adjudicateLabel: adjudicateAlwaysReady,
    escapeProblem: ['SELF_APPLIED_LABEL note'],
    escapeReason: 'SELF_APPLIED_LABEL',
  });
  assert.equal(out.ok, true);
  assert.equal(out.escapeProblem, 'SELF_APPLIED_LABEL');
  assert.match(out.lines.join('\n'), /passes on its referenced `ready` issue regardless/);
});

// -------------------------------------------------------------- unqueuedRefsNote

test('unqueuedRefsNote: empty when there are no referenced issues', () => {
  assert.deepEqual(unqueuedRefsNote([], 'ready'), []);
});

test('unqueuedRefsNote: names the count when referenced issues exist but none passed', () => {
  const out = unqueuedRefsNote([{ number: 1 }, { number: 2 }], 'ready');
  assert.equal(out.length, 1);
  assert.match(out[0], /2 issue\(s\)/);
  assert.match(out[0], /`ready`/);
});
