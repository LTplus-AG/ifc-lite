/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { deferCacheWrite, flushDeferredCacheWrites, type CacheWriteScheduler } from './deferred-cache-write.js';

it('NEW-5: encode waits for idle; early navigation/hide flushes once', async () => {
  for (const trigger of ['idle', 'hide', 'navigation']) {
    let idle = () => {};
    let hide = () => {};
    let cancellations = 0;
    const scheduler: CacheWriteScheduler = {
      idle(start) { idle = start; return () => { cancellations++; }; },
      leaving(start) { hide = start; return () => { cancellations++; }; },
    };
    let writes = 0;
    const captured = { model: 'first' };
    let active = captured;
    const done = deferCacheWrite(async () => { assert.equal(active, captured); writes++; }, scheduler);
    assert.equal(writes, 0);
    if (trigger === 'idle') idle();
    else if (trigger === 'hide') hide();
    else flushDeferredCacheWrites();
    assert.equal(writes, 1);
    active = { model: 'next' };
    idle(); hide(); flushDeferredCacheWrites();
    await done;
    assert.equal(writes, 1);
    assert.equal(cancellations, 2);
  }
});
