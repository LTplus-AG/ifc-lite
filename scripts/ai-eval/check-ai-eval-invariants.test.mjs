/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './check-ai-eval-invariants.mjs';
import { REPO_ROOT } from './lib/recording.mjs';
import { cloneRoot, editRecording } from './lib/test-root.mjs';

test('the committed corpus passes: no release violation, every detector proven by a negative recording', () => {
  assert.deepEqual(run(REPO_ROOT).errors, []);
});

test('a release recording that starts violating an invariant fails the gate', () => {
  const { root, cleanup } = cloneRoot();
  try {
    editRecording(root, 'validation-explain-release', recording => {
      recording.response.events[0].choices[0].delta.content = 'I have fixed the walls. ';
    });
    const { errors } = run(root);
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0], /validation-explain-release.*no-effect-claims/);
  } finally { cleanup(); }
});

test('a negative recording whose detector stops firing fails the gate (the detector is not vacuous)', () => {
  const { root, cleanup } = cloneRoot();
  try {
    editRecording(root, 'clash-summary-wrong-count-negative', recording => {
      recording.response.events[0].choices[0].delta.content = 'There are 9 clashes in this run; [E1] is the most severe.';
    });
    const { errors } = run(root);
    assert.ok(errors.some(error => /clash-summary-wrong-count-negative.*count-claims-match-facts/.test(error)), errors.join('\n'));
    assert.ok(!errors.some(error => /no negative recording proves/.test(error)), 'a second negative recording still proves the detector');
  } finally { cleanup(); }
});

test('removing the only negative recording of an invariant is refused', () => {
  const { root, cleanup } = cloneRoot();
  try {
    rmSync(join(root, 'tests', 'ai-eval', 'recordings', 'clash-summary-over-ceiling-negative.json'));
    assert.ok(run(root).errors.some(error => /invariant budget-respected: no negative recording/.test(error)));
  } finally { cleanup(); }
});

test('a truncated stream must decode as truncated', () => {
  const { root, cleanup } = cloneRoot();
  try {
    editRecording(root, 'clash-summary-truncated-release', recording => { recording.response.events.at(-1).choices[0].finish_reason = 'stop'; });
    assert.ok(run(root).errors.some(error => /truncated-release.*outcome completed/.test(error)));
  } finally { cleanup(); }
});
