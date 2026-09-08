/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createDrawingRequestQueue } from './drawingRequestQueue.js';

it('preserves newer drawing work when the in-flight request fails (#3921)', async () => {
  const queue = createDrawingRequestQueue();
  const events: string[] = [];
  let fail!: (error: Error) => void;
  const blocked = new Promise<void>((_resolve, reject) => { fail = reject; });
  const first = queue.request(async () => { events.push('old-start'); await blocked; });
  const skipped = queue.request(async () => { events.push('superseded'); });
  const newest = queue.request(async isCurrent => {
    assert.equal(isCurrent(), true);
    events.push('newest-complete');
  });
  fail(new Error('old source is no longer readable'));
  await Promise.all([first, skipped, newest]);
  assert.deepEqual(events, ['old-start', 'newest-complete']);
});

it('rejects a failed latest request and accepts a later retry (#3921)', async () => {
  const queue = createDrawingRequestQueue();
  const failure = new Error('current source is unreadable');
  await assert.rejects(queue.request(async () => { throw failure; }), failure);
  let retried = false;
  await queue.request(async isCurrent => { assert.equal(isCurrent(), true); retried = true; });
  assert.equal(retried, true);
});

it('cancels queued work and invalidates the running publication (#3921)', async () => {
  const queue = createDrawingRequestQueue();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const events: string[] = [];
  const running = queue.request(async isCurrent => {
    await blocked;
    if (isCurrent()) events.push('published');
  });
  const pending = queue.request(async () => { events.push('queued'); });
  queue.cancel();
  release();
  await Promise.all([running, pending]);
  assert.deepEqual(events, []);
});
