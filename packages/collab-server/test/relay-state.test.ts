/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `fetchRoomStateVector` against the real server (#4446): the probe reads
 * the state vector `addConnection` sends as sync step 1, and it tracks what
 * the server has actually applied — a local write is NOT covered until the
 * server has received it, and is covered right after.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { WebSocket } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import { fetchRoomStateVector, stateVectorCovers } from '@ifc-lite/collab';
import { MemoryPersistence, startCollabServer } from '../src/server.js';

describe('fetchRoomStateVector', () => {
  it('reports what the server holds, before and after an owner write lands', async () => {
    const handle = await startCollabServer({ port: 0, persistence: new MemoryPersistence() });
    const address = handle.httpServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const url = `ws://127.0.0.1:${port}`;
    const probe = () => fetchRoomStateVector(url, 'room-sv', { WebSocketPolyfill: WebSocket, timeoutMs: 5000 });

    // Fresh room: the server holds nothing.
    expect(await probe()).toEqual(new Map());

    const owner = new Y.Doc();
    // Write BEFORE connecting: the local state vector is ahead of the server's.
    owner.getMap('entities').set('/wall', 'IfcWall');
    const target = Y.encodeStateVector(owner);
    expect(stateVectorCovers(target, await probe())).toBe(false);

    const provider = new WebsocketProvider(url, 'room-sv', owner, { WebSocketPolyfill: WebSocket as never, disableBc: true });
    await new Promise<void>((resolve) => (provider.synced ? resolve() : provider.once('sync', () => resolve())));
    // Now the server has the write; the probe must say so (allow the frame to land).
    const deadline = Date.now() + 3000;
    let covered = false;
    while (!covered && Date.now() < deadline) {
      covered = stateVectorCovers(target, await probe());
      if (!covered) await new Promise((r) => setTimeout(r, 25));
    }
    expect(covered).toBe(true);
    // The probe joined and left silently: once its close lands, the owner is the only peer again.
    const peers = async () => (await handle.roomManager.stats()).find((s) => s.roomId === 'room-sv')?.peerCount;
    const closeDeadline = Date.now() + 3000;
    while ((await peers()) !== 1 && Date.now() < closeDeadline) await new Promise((r) => setTimeout(r, 25));
    expect(await peers()).toBe(1);

    provider.destroy();
    await handle.stop();
  }, 15_000);

  it('rejects instead of hanging when the server is unreachable', async () => {
    await expect(
      fetchRoomStateVector('ws://127.0.0.1:9', 'nope', { WebSocketPolyfill: WebSocket, timeoutMs: 2000 }),
    ).rejects.toThrow(/relay probe/);
  });
});
