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
    releaseFederationLoadSlot(blocker);

    const [a, b] = await Promise.all([aPromise, bPromise]);
    assert.strictEqual(order[0], 'a');
    releaseFederationLoadSlot(a);
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

  it('treats negative file size as zero', async () => {
    const id = await acquireFederationLoadSlot(-100);
    assert.strictEqual(__getFederationLoadGateStats().activeCount, 1);
    releaseFederationLoadSlot(id);
  });
});
