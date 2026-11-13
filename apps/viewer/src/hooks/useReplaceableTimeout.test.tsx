/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { act } from 'react';
import { render, cleanup } from '@/test/render.js';
import { reportClock } from '@/test/error-report-timing.js';
import { useReplaceableTimeout, type ReplaceableTimeout } from './useReplaceableTimeout';

let handle: ReplaceableTimeout;
function Owner() {
  handle = useReplaceableTimeout();
  return null;
}

it('a newer schedule supersedes the pending one, so an earlier run cannot reset a later run\'s status (B1)', async (t) => {
  // #9742: real waits can overshoot the 40 ms deadline on a loaded host.
  const clock = reportClock(t);
  render(<Owner />);
  const fired: string[] = [];
  act(() => handle.schedule(() => fired.push('first'), 40));
  await clock.advance(20);
  act(() => handle.schedule(() => fired.push('second'), 40));
  await clock.advance(30);
  assert.deepEqual([...fired], [], 'the first run\'s timer was dropped at its own deadline');
  await clock.advance(10);
  assert.deepEqual(fired, ['second']);
});

it('cancel (a new run starting) and unmount both drop the pending callback (B1)', async (t) => {
  const clock = reportClock(t);
  render(<Owner />);
  const fired: string[] = [];
  act(() => handle.schedule(() => fired.push('cancelled'), 20));
  act(() => handle.cancel());
  await clock.advance(50);
  assert.deepEqual([...fired], [], 'cancel alone drops the pending callback');

  act(() => handle.schedule(() => fired.push('unmounted'), 20));
  cleanup();
  await clock.advance(50);
  assert.deepEqual([...fired], [], 'unmount drops the pending callback');
});
