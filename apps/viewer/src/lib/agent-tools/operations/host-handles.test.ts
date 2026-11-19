/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evictOldest } from './host-handles';

test('evictOldest drops the oldest evictable handle and keeps pinned ones', () => {
  const handles = new Map([['a', { busy: true }], ['b', { busy: false }], ['c', { busy: false }]]);
  evictOldest(handles, 3, (handle) => !handle.busy);
  assert.deepEqual([...handles.keys()], ['a', 'c']);
  evictOldest(handles, 1, () => false);
  assert.deepEqual([...handles.keys()], ['a', 'c'], 'pinned handles stay above the cap');
  evictOldest(handles, 2);
  assert.deepEqual([...handles.keys()], ['c']);
});
