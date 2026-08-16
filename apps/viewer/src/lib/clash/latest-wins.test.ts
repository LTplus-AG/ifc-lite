/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `createLatestWinsGuard` is the exact mechanism `useClash`'s `focusClash`
 * uses to stop a stale intersection-solid compute (clash A, resolved late)
 * from overwriting the currently-focused clash B's result. This pins the
 * guard itself: token issuance, staleness detection when a later `begin()`
 * ran before the async result arrives, and that a teardown-only `begin()`
 * (return value discarded, as every clear path does) still invalidates.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLatestWinsGuard } from './latest-wins.js';

describe('createLatestWinsGuard', () => {
  it('the first token is current until a second begin() runs', () => {
    const guard = createLatestWinsGuard();
    const token = guard.begin();
    assert.equal(guard.isCurrent(token), true);
  });

  it('an OLD token is stale once a NEWER begin() has run — the A-then-B race', () => {
    const guard = createLatestWinsGuard();
    // Simulates: focusClash(A) kicks off a compute, then — before it
    // resolves — focusClash(B) runs (the exact "clicked A, then quickly
    // clicked B" scenario the guard exists for).
    const tokenA = guard.begin();
    const tokenB = guard.begin();
    assert.equal(guard.isCurrent(tokenA), false, 'A must be stale once B has begun');
    assert.equal(guard.isCurrent(tokenB), true, 'B is the current request');
  });

  it('a teardown-only begin() (return value discarded) still invalidates the prior token', () => {
    const guard = createLatestWinsGuard();
    const token = guard.begin();
    // `clearHighlight` / `clearAll` / the panel's unmount cleanup call
    // `begin()` purely to invalidate — they never capture the token.
    guard.begin();
    assert.equal(guard.isCurrent(token), false);
  });

  it('two more begin() calls in a row: only the LAST is current', () => {
    const guard = createLatestWinsGuard();
    const t1 = guard.begin();
    const t2 = guard.begin();
    const t3 = guard.begin();
    assert.equal(guard.isCurrent(t1), false);
    assert.equal(guard.isCurrent(t2), false);
    assert.equal(guard.isCurrent(t3), true);
  });

  it('tokens are distinct across calls (never reuses a value while stale)', () => {
    const guard = createLatestWinsGuard();
    const seen = new Set<number>();
    for (let i = 0; i < 5; i += 1) seen.add(guard.begin());
    assert.equal(seen.size, 5);
  });
});
