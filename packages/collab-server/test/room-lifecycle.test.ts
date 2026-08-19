/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
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

      // The half-built Room's constructor already starts y-protocols'
      // Awareness renewal timer before loadFromDisk() throws. Nothing but
      // this closure ever holds a reference to that Room, so the reject path
      // has to dispose it explicitly or the timer leaks for the life of the
      // process. Spy on `Awareness.prototype.destroy` rather than diffing
      // `process.getActiveResourcesInfo()`'s PROCESS-WIDE timer count: that
      // count can be nudged by any other timer created or released while
      // `getOrCreate('broken')` awaits (test-runner internals included),
      // which can hide a real leak here or fail this test for a reason that
      // has nothing to do with it (PR #2821 review).
      const destroySpy = vi.spyOn(Awareness.prototype, 'destroy');

      // The caller must see the failure — a room whose durable log cannot be
      // read must not come back as a silently empty doc that then compacts
      // its emptiness over the real state.
      await expect(mgr.getOrCreate('broken')).rejects.toThrow(/corrupt log/);

      // ...and the poisoned entry must not stay cached, or the room is
      // bricked for the process lifetime and keeps occupying a maxRooms slot.
      expect(mgr.list()).not.toContain('broken');
      expect(await mgr.stats()).toEqual([]);

      // Called twice per y-protocols' own wiring, not this code's doing:
      // `Room.destroy()` disposes `awareness` explicitly and then
      // `doc.destroy()`, and y-protocols registers `doc.on('destroy', ...)`
      // to self-destroy its Awareness too (awareness.js) — so asserting an
      // exact count here would pin an implementation detail of a dependency
      // rather than the property under test: that disposal happened at all.
      expect(destroySpy).toHaveBeenCalled();
      destroySpy.mockRestore();

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
