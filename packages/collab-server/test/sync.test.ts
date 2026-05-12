/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * End-to-end: two y-websocket clients sync through `startCollabServer`.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { WebSocket } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import { MemoryPersistence, startCollabServer } from '../src/server.js';

describe('end-to-end sync', () => {
  it('two clients converge through the websocket server', async () => {
    const handle = await startCollabServer({
      port: 0,
      persistence: new MemoryPersistence(),
    });
    const address = handle.httpServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const url = `ws://127.0.0.1:${port}`;

    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const provA = new WebsocketProvider(url, 'room-1', docA, {
      WebSocketPolyfill: WebSocket as never,
      disableBc: true,
    });
    const provB = new WebsocketProvider(url, 'room-1', docB, {
      WebSocketPolyfill: WebSocket as never,
      disableBc: true,
    });

    const synced = (p: WebsocketProvider) =>
      new Promise<void>((resolve) => {
        if (p.synced) return resolve();
        p.once('sync', () => resolve());
      });
    await Promise.all([synced(provA), synced(provB)]);

    const mapA = docA.getMap('test');
    const mapB = docB.getMap('test');

    docA.transact(() => mapA.set('foo', 'from-A'));

    // Wait for the value to land on B.
    await waitFor(() => mapB.get('foo') === 'from-A', 2000);
    expect(mapB.get('foo')).toBe('from-A');

    docB.transact(() => mapB.set('bar', 42));
    await waitFor(() => mapA.get('bar') === 42, 2000);
    expect(mapA.get('bar')).toBe(42);

    provA.destroy();
    provB.destroy();
    await handle.stop();
  }, 10_000);
});

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}
