/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The server relays awareness; it is not itself a peer (#2791).
 *
 * y-protocols' `Awareness` constructor self-registers a local state of `{}` for
 * its own clientID, so `new Awareness(this.doc)` inside `Room` used to publish
 * the SERVER as a participant. Every client counted it, so every room badge
 * read one too high: "(2)" directly above a roster reading "You're the only
 * one here", because the roster filters on a `user` field and the badge did
 * not.
 *
 * How the ghost actually reached clients, measured rather than assumed: NOT via
 * the connect-time snapshot in `addConnection`, but via the ~15s renewal. A
 * lone client polled every 2s saw only itself through t=14s and picked up a
 * second, empty state at t=16s, which then persisted. That matches the
 * production observation this was filed from (t=18s, one remote peer, `{}`).
 * `_checkInterval` in y-protocols/awareness.js:59-63 re-sets the local state
 * once `outdatedTimeout / 2` (15s) has elapsed, which broadcasts it.
 *
 * The second test therefore drives that exact renewal call instead of sleeping
 * for 15s of wall clock. The third test is the no-regression half: clearing the
 * server's own state must not stop it forwarding real peers to each other.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { WebSocket } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import { MemoryPersistence, startCollabServer } from '../src/server.js';

async function startServer() {
  const handle = await startCollabServer({ port: 0, persistence: new MemoryPersistence() });
  const address = handle.httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { handle, url: `ws://127.0.0.1:${port}` };
}

function connect(url: string, room: string) {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(url, room, doc, {
    WebSocketPolyfill: WebSocket as never,
    disableBc: true,
  });
  return { doc, provider };
}

const synced = (p: WebsocketProvider) =>
  new Promise<void>((resolve) => {
    if (p.synced) return resolve();
    p.once('sync', () => resolve());
  });

/** Awareness clientIDs visible to `provider` other than its own. */
function remoteClientIds(provider: WebsocketProvider, ownClientId: number): number[] {
  return [...provider.awareness.getStates().keys()].filter((id) => id !== ownClientId);
}

const describeStates = (provider: WebsocketProvider) =>
  JSON.stringify([...provider.awareness.getStates().entries()]);

describe('server awareness is not a peer', () => {
  it('a room publishes no awareness state of its own', async () => {
    const { handle, url } = await startServer();
    const { provider } = connect(url, 'room-invariant');
    await synced(provider);

    const room = await handle.roomManager.peek('room-invariant');
    expect(room, 'room was not created').toBeTruthy();
    const own = room!.awareness.getLocalState();
    const published = [...room!.awareness.getStates().keys()];

    expect(own, `server still publishes a local awareness state: ${JSON.stringify(own)}`).toBeNull();
    expect(
      published.includes(room!.awareness.clientID),
      `server's own clientID ${room!.awareness.clientID} is in its published states ${JSON.stringify(published)}`,
    ).toBe(false);

    provider.destroy();
    await handle.stop();
  }, 15_000);

  it('a renewal tick broadcasts no server peer to a lone client', async () => {
    const { handle, url } = await startServer();
    const { doc, provider } = connect(url, 'solo-room');
    await synced(provider);

    const room = await handle.roomManager.peek('solo-room');
    expect(room).toBeTruthy();

    // Exactly what y-protocols' _checkInterval does every 15s
    // (awareness.js:61-63). With the server's state left in place this
    // re-broadcasts `{}` and the client gains a phantom peer; with it cleared
    // the local state is null and there is nothing to renew.
    room!.awareness.setLocalState(room!.awareness.getLocalState());

    // Give the broadcast time to land. The earlier measured propagation was
    // well under 100ms, so 500ms is slack, not a race.
    await new Promise((r) => setTimeout(r, 500));

    expect(
      remoteClientIds(provider, doc.clientID),
      `lone client sees a phantom peer: ${describeStates(provider)}`,
    ).toEqual([]);

    provider.destroy();
    await handle.stop();
  }, 15_000);

  it('still relays a real peer between two clients', async () => {
    const { handle, url } = await startServer();
    const a = connect(url, 'pair-room');
    const b = connect(url, 'pair-room');
    await Promise.all([synced(a.provider), synced(b.provider)]);

    a.provider.awareness.setLocalStateField('user', { id: 'u-a', name: 'A' });

    const deadline = Date.now() + 3000;
    let fromB: unknown;
    while (Date.now() < deadline) {
      fromB = b.provider.awareness.getStates().get(a.doc.clientID);
      if (fromB) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(fromB, 'B never received A awareness state').toBeTruthy();
    expect((fromB as { user?: { id?: string } }).user?.id).toBe('u-a');

    // ...and B sees exactly ONE peer: A, with no server ghost beside it.
    expect(remoteClientIds(b.provider, b.doc.clientID)).toEqual([a.doc.clientID]);

    a.provider.destroy();
    b.provider.destroy();
    await handle.stop();
  }, 15_000);
});
