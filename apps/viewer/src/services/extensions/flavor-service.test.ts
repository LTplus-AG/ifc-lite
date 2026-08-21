/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_FLAVOR_ID,
  InMemoryFlavorStorage,
  type FlavorStorage,
} from '@ifc-lite/extensions';
import { FlavorService } from './flavor-service.js';

/**
 * An in-memory store whose `setActiveId` is refused — the shape a quota hit
 * or a blocked IDB transaction presents. Everything else behaves normally,
 * so the pointer keeps whatever value was seeded before the refusal.
 */
function refusingPointerStore(
  seedActiveId?: string,
): FlavorStorage & { setActiveCalls: number; setActiveArgs: (string | undefined)[] } {
  const inner = new InMemoryFlavorStorage();
  const wrapper = {
    setActiveCalls: 0,
    setActiveArgs: [] as (string | undefined)[],
    putFlavor: inner.putFlavor.bind(inner),
    getFlavor: inner.getFlavor.bind(inner),
    listFlavors: inner.listFlavors.bind(inner),
    deleteFlavor: inner.deleteFlavor.bind(inner),
    listSnapshots: inner.listSnapshots.bind(inner),
    restoreSnapshot: inner.restoreSnapshot.bind(inner),
    clear: inner.clear.bind(inner),
    getActiveId: () => Promise.resolve(seedActiveId),
    setActiveId: async (id: string | undefined): Promise<void> => {
      wrapper.setActiveCalls += 1;
      wrapper.setActiveArgs.push(id);
      throw new Error('pointer write refused');
    },
  };
  return wrapper as unknown as FlavorStorage & {
    setActiveCalls: number;
    setActiveArgs: (string | undefined)[];
  };
}

describe('FlavorService.resetToDefaults', () => {
  it('succeeds when the refused pointer write would have stored the id already stored', async () => {
    // The default flavor is already the active one — a second reset writes the
    // pointer it already holds. That write changes nothing, so a refusal must
    // not fail the reset: the baseline flavor landed and the pointer names it.
    const storage = refusingPointerStore(DEFAULT_FLAVOR_ID);
    const service = new FlavorService({ storage });

    const flavor = await service.resetToDefaults();

    assert.equal(flavor.id, DEFAULT_FLAVOR_ID);
    assert.equal(storage.setActiveCalls, 1, 'the write is still attempted');
    // The value compared must be the value written: a write of anything else
    // would have changed the pointer, so calling it a no-op would be a lie.
    assert.deepEqual(storage.setActiveArgs, [DEFAULT_FLAVOR_ID]);
    const stored = await storage.getFlavor(DEFAULT_FLAVOR_ID);
    assert.ok(stored, 'the baseline flavor is on disk');
    assert.equal(await storage.getActiveId(), DEFAULT_FLAVOR_ID);
  });

  it('still fails when the refused pointer write would have moved the pointer', async () => {
    const storage = refusingPointerStore('flv.other');
    const service = new FlavorService({ storage });

    await assert.rejects(() => service.resetToDefaults(), /pointer write refused/);
  });

  it('still fails when the pointer holds nothing', async () => {
    const storage = refusingPointerStore(undefined);
    const service = new FlavorService({ storage });

    await assert.rejects(() => service.resetToDefaults(), /pointer write refused/);
  });

  it('still fails when the pointer is unreadable', async () => {
    // One-directional: a read that cannot answer is not proof of a no-op.
    const storage = refusingPointerStore(DEFAULT_FLAVOR_ID);
    storage.getActiveId = () => Promise.reject(new Error('read io'));
    const service = new FlavorService({ storage });

    await assert.rejects(() => service.resetToDefaults(), /pointer write refused/);
  });

  it('rethrows a refused putFlavor — nothing was written to compare against', async () => {
    const storage = refusingPointerStore(DEFAULT_FLAVOR_ID);
    storage.putFlavor = () => Promise.reject(new Error('flavor write refused'));
    const service = new FlavorService({ storage });

    await assert.rejects(() => service.resetToDefaults(), /flavor write refused/);
    assert.equal(storage.setActiveCalls, 0, 'the pointer write is never reached');
  });
});
