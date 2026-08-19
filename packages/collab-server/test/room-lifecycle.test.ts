/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';
import { MemoryPersistence, type Persistence } from '../src/persistence.js';
import { RoomManager } from '../src/room-manager.js';

/**
 * Reject paths around room load / room cap. Both are the difference between
 * "one room is broken" and "the process is broken", and neither was asserted
 * anywhere before.
 */
describe('RoomManager reject paths', () => {
  it('propagates a persistence load failure and evicts the poisoned room', async () => {
    const failing = { fail: true };
    const persistence: Persistence = {
      async load(roomId: string) {
        if (failing.fail) throw new Error(`corrupt log for ${roomId}`);
        return null;
      },
      async append() {},
      async compact() {},
      async drop() {},
    };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const mgr = new RoomManager({ persistence });

      // The caller must see the failure — a room whose durable log cannot be
      // read must not come back as a silently empty doc that then compacts
      // its emptiness over the real state.
      const beforeTimers = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
      await expect(mgr.getOrCreate('broken')).rejects.toThrow(/corrupt log/);

      // ...and the poisoned entry must not stay cached, or the room is
      // bricked for the process lifetime and keeps occupying a maxRooms slot.
      expect(mgr.list()).not.toContain('broken');
      expect(await mgr.stats()).toEqual([]);

      // The half-built Room's constructor already started y-protocols'
      // Awareness renewal timer before loadFromDisk() threw. Nothing but
      // this closure ever held a reference to that Room, so if the reject
      // path doesn't dispose it explicitly, the timer leaks for the life
      // of the process (never observable via list()/stats() above).
      const afterTimers = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
      expect(afterTimers).toBe(beforeTimers);

      // Once the underlying fault clears, the same id loads normally.
      failing.fail = false;
      const room = await mgr.getOrCreate('broken');
      expect(room.id).toBe('broken');
      expect(mgr.list()).toContain('broken');

      await mgr.unloadAll();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('rejects a new room once maxRooms is reached, without evicting live rooms', async () => {
    const mgr = new RoomManager({ persistence: new MemoryPersistence(), maxRooms: 2 });
    await mgr.getOrCreate('a');
    await mgr.getOrCreate('b');

    await expect(mgr.getOrCreate('c')).rejects.toThrow(/room limit \(2\)/);
    expect(mgr.list()).toEqual(['a', 'b']);

    // An already-loaded room is still served after the cap is hit — the cap
    // guards creation, not lookup.
    const again = await mgr.getOrCreate('a');
    expect(again.id).toBe('a');

    await mgr.unloadAll();
  });
});
