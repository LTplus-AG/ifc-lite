/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clickControl, task } from './driver.mjs';
test('#9328 click failures name the missing control', async () => {
  await assert.rejects(clickControl({ toString: () => 'button:Export', click: async () => { throw new Error('not visible'); } }), /button:Export.*not visible/);
});
test('#9328 completed gestures survive a later oracle error', async () => {
  const s = { counters: { clicks: 2, keys: 0 } };
  await task(s,'wall',async () => { s.counters.clicks++; });
  await task(s,'export',async () => { throw new Error('blocked'); });
  assert.equal(s.completedTasks[0].actions,1);
  assert.equal(s.completedTasks[1].ok,false);
});
