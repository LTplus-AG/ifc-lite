/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Unit tests for the #4147 PARTIAL_WORK machinery in `issue-refs.mjs`.
 * `check-issue-queue.test.mjs` covers the end-to-end verdicts through the
 * gate's own CLI; this file covers the pure pieces in isolation, including
 * the regex edge cases. The GraphQL-fetching half (the fail-closed live-fetch
 * wrapper `check-issue-queue.test.mjs` cannot reach without a real `gh`
 * process) moved to `./ref-issues-fetch.test.mjs` alongside its module
 * (#4180 finding B).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractRefIssueNumbers,
  partialWorkVerdict,
  unqueuedRefsNote,
  findNearMissRefIssueNumbers,
  nearMissRefsNote,
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

// --------------------------------------------------- findNearMissRefIssueNumbers

test('findNearMissRefIssueNumbers: catches a backtick-wrapped mid-sentence Refs #N', () => {
  // The confirmed real shape (#4151, #4152): "...`Refs #3612`, and requesting
  // the `unqueued` label..." -- an inline code span, not at line start, so
  // the strict REF_KEYWORD_RE no longer matches it.
  const body = 'This slice continues `Refs #3612`, and requesting the `unqueued` label meanwhile.';
  assert.deepEqual(extractRefIssueNumbers(body), []);
  assert.deepEqual(findNearMissRefIssueNumbers(body), [3612]);
});

test('findNearMissRefIssueNumbers: catches a mid-sentence Refs #N with no backticks', () => {
  const body = 'this change refs #9 as prior art but does not close it';
  assert.deepEqual(findNearMissRefIssueNumbers(body), [9]);
});

test('findNearMissRefIssueNumbers: catches a blockquoted Refs #N', () => {
  const body = '> Refs #5 from the original report';
  assert.deepEqual(findNearMissRefIssueNumbers(body), [5]);
});

test('findNearMissRefIssueNumbers: does NOT report a match found only inside a fenced code block', () => {
  // This is the confirmed exploit shape #4147's tightening closed: quoting
  // someone else's commit message verbatim. Silently dropped -- no hint that
  // would tell an attacker to "move it out of the fence".
  const body = '```\nRefs #12\n```';
  assert.deepEqual(extractRefIssueNumbers(body), []);
  assert.deepEqual(findNearMissRefIssueNumbers(body), []);
});

test('findNearMissRefIssueNumbers: a number the strict matcher DID accept is excluded', () => {
  // Its format was already fine -- re-flagging it as a near-miss would be false.
  const body = 'Refs #1\nand also mentions refs #1 again mid-sentence';
  assert.deepEqual(extractRefIssueNumbers(body), [1]);
  assert.deepEqual(findNearMissRefIssueNumbers(body), []);
});

test('findNearMissRefIssueNumbers: empty body or no reference at all yields nothing', () => {
  assert.deepEqual(findNearMissRefIssueNumbers(''), []);
  assert.deepEqual(findNearMissRefIssueNumbers('no mention of any issue here'), []);
  assert.deepEqual(findNearMissRefIssueNumbers(undefined), []);
});

test('findNearMissRefIssueNumbers: dedupes and preserves first-seen order', () => {
  // Prefixed with prose so neither mention starts a line (which the strict
  // matcher would then accept, per its own multiline `^`).
  const body = 'This slice refs #9, and mid-sentence refs #9 again, then refs #3 later.';
  assert.deepEqual(extractRefIssueNumbers(body), []);
  assert.deepEqual(findNearMissRefIssueNumbers(body), [9, 3]);
});

// ------------------------------------------------------------- nearMissRefsNote

test('nearMissRefsNote: empty when there are no near-miss numbers', () => {
  assert.deepEqual(nearMissRefsNote([]), []);
});

test('nearMissRefsNote: names the number(s) and the accepted form', () => {
  const out = nearMissRefsNote([3612]);
  assert.equal(out.length, 1);
  assert.match(out[0], /#3612/);
  assert.match(out[0], /REMEDY/);
  assert.match(out[0], /start of its own line/);
});
