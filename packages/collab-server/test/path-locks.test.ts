/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { startCollabServer } from '../src/server.js';
import { MemoryPersistence } from '../src/persistence.js';
import { MemoryAuditSink } from '../src/audit-log.js';
import {
  createPathLockRegistry,
  harvestUpdatePaths,
  verifyAgainstPathLocks,
} from '../src/path-locks.js';
import { WebSocket } from 'ws';
import { WebsocketProvider } from 'y-websocket';

function tinyDoc(): Y.Doc {
  const doc = new Y.Doc();
  doc.getMap('entities');
  doc.getMap('relationships');
  doc.getMap('geometry');
  doc.getMap('meta');
  return doc;
}

describe('path-locks', () => {
  it('harvestUpdatePaths returns paths touched by the update', () => {
    const doc = tinyDoc();
    doc.transact(() => {
      const ents = doc.getMap('entities');
      const wall = new Y.Map<unknown>();
      const attrs = new Y.Map<unknown>();
      attrs.set('Name', 'wall');
      wall.set('attributes', attrs);
      ents.set('wall', wall);
    });
    const update = Y.encodeStateAsUpdate(doc);
    const paths = harvestUpdatePaths(update);
    expect(paths.some((p) => p.startsWith('entities'))).toBe(true);
    expect(paths.some((p) => p === 'entities/wall' || p === 'entities/wall/attributes')).toBe(true);
  });

  it('registry add / matches / remove', () => {
    const reg = createPathLockRegistry();
    const lock = reg.add({
      prefix: 'entities/storey-1/',
      label: 'mep-review',
      exemptUserIds: new Set(['admin']),
    });
    expect(reg.matches('entities/storey-1/wall', { userId: 'bob', role: 'editor' })).toBe(lock);
    expect(reg.matches('entities/storey-1/wall', { userId: 'admin', role: 'admin' })).toBeNull();
    expect(reg.matches('entities/other', { userId: 'bob', role: 'editor' })).toBeNull();
    reg.remove(lock);
    expect(reg.matches('entities/storey-1/wall', { userId: 'bob', role: 'editor' })).toBeNull();
  });

  it('rejects writes to locked prefixes via verifyAgainstPathLocks', async () => {
    const reg = createPathLockRegistry();
    reg.add({ prefix: 'entities/locked', label: 'frozen' });
    const audit = new MemoryAuditSink();

    const handle = await startCollabServer({
      port: 0,
      persistence: new MemoryPersistence(),
      auditSink: audit,
      verifyMessage: verifyAgainstPathLocks(reg),
    });
    const port = (handle.httpServer.address() as { port: number }).port;
    const url = `ws://127.0.0.1:${port}`;

    const doc = new Y.Doc();
    const prov = new WebsocketProvider(url, 'project/main', doc, {
      WebSocketPolyfill: WebSocket as never,
      disableBc: true,
    });
    await new Promise<void>((res) => (prov.synced ? res() : prov.once('sync', () => res())));

    // Write to a locked path.
    const ents = doc.getMap('entities');
    doc.transact(() => {
      const wall = new Y.Map<unknown>();
      ents.set('locked-wall', wall);
    });

    await new Promise((r) => setTimeout(r, 100));
    const rejects = audit.entries.filter((e) => e.opType === 'reject');
    expect(rejects.some((e) => String((e.detail as { reason?: string } | undefined)?.reason).startsWith('locked:'))).toBe(true);

    prov.destroy();
    await handle.stop();
  }, 10_000);
});
