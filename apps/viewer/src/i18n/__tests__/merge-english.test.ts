/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeEnglishEntries } from './merge-english';

test('PR #8896: duplicate English keys cannot silently replace distinct messages', () => {
  const target: Record<string, unknown> = {};
  mergeEnglishEntries(target, { 'action.remove': 'Remove' }, 'first.en.ts');
  assert.throws(() => mergeEnglishEntries(target,
    { 'action.new': 'New', 'action.remove': 'Delete permanently' }, 'second.en.ts'),
  /second.en.ts: duplicate English catalogue key action.remove/);
  assert.deepEqual(target, { 'action.remove': 'Remove' }, 'a rejected batch must leave the catalogue unchanged');
  assert.throws(() => mergeEnglishEntries(target, { 'action.remove': 'Remove' }, 'third.en.ts'), /duplicate English catalogue key/);
  mergeEnglishEntries(target, { 'action.keep': 'Keep' }, 'fourth.en.ts');
  assert.deepEqual(target, { 'action.remove': 'Remove', 'action.keep': 'Keep' });
});
