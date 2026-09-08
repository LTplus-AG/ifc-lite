/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureEvalCommit, EvalCommitError } from './eval-commit.mjs';

const SHA = 'a'.repeat(40);

test('#3833: a present eval head costs no fetch', () => {
  const calls = [];
  const result = ensureEvalCommit(SHA, { exec: (cmd, args) => calls.push([cmd, args]) });
  assert.deepEqual(result, { fetched: false });
  assert.deepEqual(calls, [['git', ['cat-file', '-e', `${SHA}^{commit}`]]]);
});

test('#3833: an unreachable squash head is fetched by its exact pinned id', () => {
  const calls = [];
  let first = true;
  const result = ensureEvalCommit(SHA, { remote: 'upstream', exec: (cmd, args) => {
    calls.push([cmd, args]);
    if (first) { first = false; throw new Error('missing'); }
  } });
  assert.deepEqual(result, { fetched: true });
  assert.deepEqual(calls[1], ['git', ['fetch', '--no-tags', '--depth=1', 'upstream', SHA]]);
  assert.deepEqual(calls[2], ['git', ['cat-file', '-e', `${SHA}^{commit}`]]);
});

test('#3833: an unavailable head aborts instead of lowering recall', () => {
  assert.throws(
    () => ensureEvalCommit(SHA, { exec: () => { throw new Error('missing'); } }),
    (error) => error instanceof EvalCommitError && /refusing to score/.test(error.message),
  );
});

test('#3833: a malformed fixture id never reaches git', () => {
  let called = false;
  assert.throws(() => ensureEvalCommit('synthetic', { exec: () => { called = true; } }), EvalCommitError);
  assert.equal(called, false);
});
