/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Disconnect/reconnect (spec §13).
 *
 * Peer A makes edits while offline. When it reconnects, those edits sync
 * to peer B and B sees them. The server's persistence absorbs anything
 * that happened during the offline window.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { WebSocket } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import { MemoryPersistence, startCollabServer } from '../src/server.js';
import { MemoryAuditSink } from '../src/audit-log.js';

async function waitFor(check: () => boolean, timeoutMs: number) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('disconnect / reconnect', () => {
  it('A goes offline, edits, comes back, B converges', async () => {
    const audit = new MemoryAuditSink();
    const handle = await startCollabServer({
      port: 0,
      persistence: new MemoryPersistence(),
      auditSink: audit,
    });
    const port = (handle.httpServer.address() as { port: number }).port;
    const url = `ws://127.0.0.1:${port}`;

    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const provA = new WebsocketProvider(url, 'room-x', docA, {
      WebSocketPolyfill: WebSocket as never,
      disableBc: true,
    });
    const provB = new WebsocketProvider(url, 'room-x', docB, {
      WebSocketPolyfill: WebSocket as never,
      disableBc: true,
    });
    const synced = (p: WebsocketProvider) =>
      new Promise<void>((res) => (p.synced ? res() : p.once('sync', () => res())));
    await Promise.all([synced(provA), synced(provB)]);

    docA.getMap('m').set('online', 1);
    await waitFor(() => docB.getMap('m').get('online') === 1, 2000);

    // A disconnects.
    provA.disconnect();
    await waitFor(() => !provA.wsconnected, 1000);

    // A makes offline edits.
    docA.getMap('m').set('offline', 'oops');
    docA.getMap('m').set('count', 42);

    // B doesn't see them yet.
    expect(docB.getMap('m').get('offline')).toBeUndefined();

    // A reconnects; edits propagate.
    provA.connect();
    await waitFor(() => docB.getMap('m').get('offline') === 'oops', 5000);
    expect(docB.getMap('m').get('count')).toBe(42);

    // Audit log saw connect / sync / update events.
    const types = new Set(audit.entries.map((e) => e.opType));
    expect(types.has('connect')).toBe(true);
    expect(types.has('update')).toBe(true);

    provA.destroy();
    provB.destroy();
    await handle.stop();
  }, 15_000);
});
