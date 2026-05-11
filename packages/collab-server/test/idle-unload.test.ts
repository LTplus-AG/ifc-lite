/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { MemoryPersistence } from '../src/persistence.js';
import { RoomManager } from '../src/room-manager.js';

describe('idle room unloading', () => {
  it('sweepIdle drops zero-peer rooms after idleUnloadMs', async () => {
    const mgr = new RoomManager({
      persistence: new MemoryPersistence(),
      idleUnloadMs: 50,
    });
    await mgr.getOrCreate('idle-room');
    expect(mgr.list()).toContain('idle-room');

    // Backdate the lastActiveAt by sleeping past the idle window.
    await new Promise((r) => setTimeout(r, 70));

    const dropped = await mgr.sweepIdle();
    expect(dropped).toContain('idle-room');
    expect(mgr.list()).not.toContain('idle-room');

    await mgr.unloadAll();
  });

  it('keeps a room loaded if it has connected peers', async () => {
    const mgr = new RoomManager({
      persistence: new MemoryPersistence(),
      idleUnloadMs: 30,
    });
    const room = await mgr.getOrCreate('busy');
    // Fake a connected peer by inserting a stub into the conns set via
    // addConnection — we just need peerCount > 0.
    room.addConnection({
      // Minimal stub; we never actually send/receive.
      ws: { readyState: 1, OPEN: 1, send: () => {}, close: () => {}, terminate: () => {} } as unknown as import('ws').WebSocket,
      principal: { userId: 'u', role: 'editor' },
      awarenessClients: new Set<number>(),
    });

    await new Promise((r) => setTimeout(r, 100));
    const dropped = await mgr.sweepIdle();
    expect(dropped).not.toContain('busy');

    await mgr.unloadAll();
  });
});
