/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { boundedIteratorReturn } from './streamCleanup.js';

describe('boundedIteratorReturn', () => {
  it('resolves promptly even when return() never settles (the stalled-worker case)', async () => {
    // Mirrors a geometry generator parked on an unresolved await: its return()
    // can never settle, so an unbounded await would re-wedge the caller.
    const iterator = { return: () => new Promise<never>(() => { /* never settles */ }) };
    const start = Date.now();
    await boundedIteratorReturn(iterator, 50);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1000, `expected bounded (<1000ms), took ${elapsed}ms`);
  });

  it('awaits a fast return() to completion (lets the generator finally run)', async () => {
    let returned = false;
    const iterator = {
      return: async () => {
        returned = true;
        return { done: true, value: undefined };
      },
    };
    await boundedIteratorReturn(iterator, 1000);
    assert.strictEqual(returned, true);
  });

  it('swallows a rejecting return() without throwing', async () => {
    const iterator = { return: () => Promise.reject(new Error('teardown blew up')) };
    await assert.doesNotReject(() => boundedIteratorReturn(iterator, 1000));
  });

  it('is a no-op when the iterator has no return()', async () => {
    await assert.doesNotReject(() => boundedIteratorReturn({}, 1000));
  });
});
