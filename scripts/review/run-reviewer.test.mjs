/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The property under test is the one the review gate cannot check for itself:
 * THIS FILE MUST NEVER TURN A FAILURE INTO A CLEAN VERDICT. Every branch below
 * exists to prove some flavour of "the model did not answer" comes out as a
 * non-zero exit and never as an empty review.
 *
 * `spawn` is injected, so a drained pool, an expired token and a truncated
 * envelope are all reachable without a model, a token or a network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, fenceUntrusted, buildPrompt, runReviewer, DISALLOWED_TOOLS } from './run-reviewer.mjs';

const ok = (result, extra = {}) => () => ({ status: 0, stdout: JSON.stringify({ result, ...extra }), stderr: '' });
const INPUT = {
  headSha: 'a'.repeat(40),
  files: [{ path: 'src/a.ts', patch: '@@ -1,1 +1,2 @@\n a\n+b', addedLineRanges: [[2, 2]] }],
  unreviewable: [{ path: 'src/huge.ts', reason: 'no patch returned; too large' }],
};

// ============================================================== classification

test('a usage-limit message classifies as QUOTA_DRAINED', () => {
  for (const s of ['Usage limit reached', 'rate limit exceeded', '429 Too Many Requests', 'server overloaded']) {
    assert.equal(classify(s), 'QUOTA_DRAINED', s);
  }
});

test('an auth message classifies as AUTH_FAILED, and wins over a limit mention', () => {
  assert.equal(classify('invalid api key'), 'AUTH_FAILED');
  // Auth failures often also mention limits; the auth remedy is the useful one.
  assert.equal(classify('401 unauthorized: rate limit info follows'), 'AUTH_FAILED');
});

test('an UNRECOGNISED error is MODEL_ERROR, never a pass', () => {
  // The catch-all is what makes text matching safe: a third party can reword its
  // errors at any time, and the only thing that must not change is that an
  // unknown failure still fails.
  assert.equal(classify('something nobody has seen before'), 'MODEL_ERROR');
  assert.equal(classify(''), 'MODEL_ERROR');
});

// ================================================================ the fence

test('the untrusted fence carries a random nonce, so diff content cannot close it', () => {
  const a = fenceUntrusted('x');
  const b = fenceUntrusted('x');
  assert.notEqual(a, b, 'a fixed delimiter is guessable, and this repository is public');
  assert.match(a, /<<<UNTRUSTED-DIFF-[0-9a-f]{18}/);
});

test('the prompt puts the rubric OUTSIDE the fence and the diff INSIDE it', () => {
  const p = buildPrompt('RUBRIC-TEXT', INPUT);
  const fenceStart = p.indexOf('<<<UNTRUSTED-DIFF-');
  assert.ok(p.indexOf('RUBRIC-TEXT') < fenceStart, 'rubric is trusted and comes first');
  assert.ok(p.indexOf('+b') > fenceStart, 'the patch is inside the fence');
});

test('files the reviewer was NOT shown are named, so it cannot report them clean', () => {
  const p = buildPrompt('R', INPUT);
  assert.match(p, /src\/huge\.ts \(no patch returned; too large\)/);
  assert.match(p, /do not report them clean/);
});

// ====================================================== every failure is a failure

test('a non-zero exit with a usage limit is QUOTA_DRAINED, not an empty review', () => {
  assert.throws(
    () => runReviewer({ prompt: 'p', model: 'sonnet', spawn: () => ({ status: 1, stdout: '', stderr: 'Usage limit reached' }) }),
    (e) => e.reason === 'QUOTA_DRAINED' && /do NOT re-run/.test(e.message),
  );
});

test('`is_error: true` alongside EXIT 0 still fails', () => {
  // This is the claude-code-action #1644 shape: success by exit code, nothing by
  // content. An exit code alone is not evidence here either.
  assert.throws(
    () => runReviewer({ prompt: 'p', model: 'sonnet', spawn: ok('Usage limit reached', { is_error: true }) }),
    (e) => e.reason === 'QUOTA_DRAINED',
  );
});

test('an EMPTY result on a successful exit is a failure, not a clean review', () => {
  for (const empty of ['', '   ', '\n']) {
    assert.throws(
      () => runReviewer({ prompt: 'p', model: 'sonnet', spawn: ok(empty) }),
      (e) => e.reason === 'EMPTY_RESPONSE',
      JSON.stringify(empty),
    );
  }
});

test('an unparseable envelope is a failure, not an empty review', () => {
  assert.throws(
    () => runReviewer({ prompt: 'p', model: 'sonnet', spawn: () => ({ status: 0, stdout: 'not json', stderr: '' }) }),
    (e) => e.reason === 'BAD_ENVELOPE',
  );
});

test('a spawn error fails rather than returning nothing', () => {
  assert.throws(
    () => runReviewer({ prompt: 'p', model: 'sonnet', spawn: () => ({ error: new Error('ENOENT'), status: null, stdout: '', stderr: '' }) }),
    (e) => e.reason === 'MODEL_ERROR',
  );
});

test('THE ONLY SUCCESS PATH: exit 0, no is_error, non-empty text', () => {
  const r = runReviewer({ prompt: 'p', model: 'sonnet', spawn: ok('{"verdict":"clean"}', { num_turns: 1 }) });
  assert.equal(r.text, '{"verdict":"clean"}');
  assert.equal(r.envelope.num_turns, 1);
});

// ====================================================== the tool surface

test('every tool is disallowed explicitly, not left to a default', () => {
  // A default that widens in a future CLI version would hand the reviewer a
  // shell without anyone editing this file.
  let seen = null;
  runReviewer({ prompt: 'p', model: 'sonnet', spawn: (_c, args) => { seen = args; return { status: 0, stdout: JSON.stringify({ result: '{}' }), stderr: '' }; } });
  const flag = seen[seen.indexOf('--disallowedTools') + 1];
  for (const t of ['Bash', 'Edit', 'Write', 'Read', 'WebFetch', 'Task']) {
    assert.ok(flag.includes(t), `${t} must be disallowed`);
  }
  assert.equal(flag, DISALLOWED_TOOLS);
  assert.ok(seen.includes('--strict-mcp-config'), 'MCP is pinned empty');
  assert.equal(seen[seen.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.equal(seen[seen.indexOf('--max-turns') + 1], '1', 'single shot');
});
