/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  acquireFederationLoadSlot,
  releaseFederationLoadSlot,
  __resetFederationLoadGate,
  __getFederationLoadGateStats,
} from './federationLoadGate.js';

describe('federationLoadGate', () => {
  beforeEach(() => {
    __resetFederationLoadGate();
  });

  it('admits a single load immediately regardless of size', async () => {
    const id = await acquireFederationLoadSlot(8000);
    assert.strictEqual(__getFederationLoadGateStats().activeCount, 1);
    releaseFederationLoadSlot(id);
    assert.strictEqual(__getFederationLoadGateStats().activeCount, 0);
  });

  it('admits two small loads concurrently when budget allows', async () => {
    const a = await acquireFederationLoadSlot(50);
    const b = await acquireFederationLoadSlot(50);
    const stats = __getFederationLoadGateStats();
    assert.strictEqual(stats.activeCount, 2);
    assert.strictEqual(stats.queuedCount, 0);
    releaseFederationLoadSlot(a);
    releaseFederationLoadSlot(b);
  });

  it('queues a second large load when the budget is full', async () => {
    const first = await acquireFederationLoadSlot(2048);
    let secondAcquired = false;
    const secondPromise = acquireFederationLoadSlot(2048).then((id) => {
      secondAcquired = true;
      return id;
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(secondAcquired, false);
    assert.strictEqual(__getFederationLoadGateStats().queuedCount, 1);

    releaseFederationLoadSlot(first);
    const second = await secondPromise;
    assert.strictEqual(secondAcquired, true);
    releaseFederationLoadSlot(second);
  });

  it('FIFO order: first queued resolves first', async () => {
    const blocker = await acquireFederationLoadSlot(2048);

    const order: string[] = [];
    const aPromise = acquireFederationLoadSlot(2048).then((id) => { order.push('a'); return id; });
    const bPromise = acquireFederationLoadSlot(50).then((id) => { order.push('b'); return id; });

    await new Promise((r) => setTimeout(r, 10));
    // Releasing the blocker frees the budget for the head of the FIFO queue.
    // A 2048 MB load costs more than the whole budget, so the first-queued load
    // is admitted alone (single-file exception) and the 50 MB load stays queued
    // until it releases. Awaiting them together would deadlock — and asserting
    // that B does NOT wake alongside A is exactly what proves the gate respects
    // the budget during the drain (the regression this guards against).
    releaseFederationLoadSlot(blocker);

    const a = await aPromise;
    assert.deepStrictEqual(order, ['a']);
    assert.strictEqual(__getFederationLoadGateStats().queuedCount, 1);

    releaseFederationLoadSlot(a);
    const b = await bPromise;
    assert.deepStrictEqual(order, ['a', 'b']);
    releaseFederationLoadSlot(b);
  });

  it('release wakes multiple queued loads that fit together', async () => {
    const blocker = await acquireFederationLoadSlot(2048);
    const p1 = acquireFederationLoadSlot(50);
    const p2 = acquireFederationLoadSlot(50);

    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(__getFederationLoadGateStats().queuedCount, 2);

    releaseFederationLoadSlot(blocker);
    const [id1, id2] = await Promise.all([p1, p2]);
    assert.strictEqual(__getFederationLoadGateStats().activeCount, 2);
    releaseFederationLoadSlot(id1);
    releaseFederationLoadSlot(id2);
  });

  it('an aborted waiter leaves the queue and never takes a slot (L6)', async () => {
    // 1000 MB costs 4000 of the default 6144 MB budget, so a second one queues.
    const blocker = await acquireFederationLoadSlot(1000);
    const superseded = new AbortController();
    const waiter = acquireFederationLoadSlot(1000, superseded.signal);
    const behind = acquireFederationLoadSlot(1000);
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(__getFederationLoadGateStats().queuedCount, 2);

    superseded.abort();
    await assert.rejects(waiter, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
    assert.strictEqual(__getFederationLoadGateStats().queuedCount, 1, 'the aborted waiter is dequeued');

    releaseFederationLoadSlot(blocker);
    const behindId = await behind;
    assert.deepStrictEqual(__getFederationLoadGateStats(), { activeCount: 1, queuedCount: 0, activeCostMB: 4000 },
      'only the live waiter is admitted');
    releaseFederationLoadSlot(behindId);
  });

  it('aborting the FIFO head admits a waiter behind it that already fits (L6)', async () => {
    // 4000 + 2000 of the default 6144 MB budget are taken.
    const blockerA = await acquireFederationLoadSlot(1000);
    const blockerB = await acquireFederationLoadSlot(500);
    const superseded = new AbortController();
    const big = acquireFederationLoadSlot(1000, superseded.signal);
    let smallAdmitted = false;
    const small = acquireFederationLoadSlot(50).then((id) => { smallAdmitted = true; return id; });
    releaseFederationLoadSlot(blockerB); // 2144 free: small fits, but waits behind big (FIFO)
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(smallAdmitted, false);

    superseded.abort();
    await assert.rejects(big, { name: 'AbortError' });
    const smallId = await small;
    assert.strictEqual(smallAdmitted, true, 'the waiter behind the aborted head is admitted at once');
    releaseFederationLoadSlot(blockerA);
    releaseFederationLoadSlot(smallId);
  });

  it('a signal aborted before acquiring rejects without taking a slot (L6)', async () => {
    const superseded = new AbortController();
    superseded.abort();
    await assert.rejects(acquireFederationLoadSlot(10, superseded.signal), { name: 'AbortError' });
    assert.strictEqual(__getFederationLoadGateStats().activeCount, 0);
  });

  it('treats negative file size as zero', async () => {
    const id = await acquireFederationLoadSlot(-100);
    assert.strictEqual(__getFederationLoadGateStats().activeCount, 1);
    releaseFederationLoadSlot(id);
  });
});
