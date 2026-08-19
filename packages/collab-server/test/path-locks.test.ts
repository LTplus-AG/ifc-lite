/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';
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

  // `exemptRoles` had no coverage at all: a mutation turning the
  // `lock.exemptRoles?.has(principal.role)` check into a no-op (so the
  // exemption is silently ignored) survived the full suite unchanged
  // (142/142 still green), because no existing test ever set
  // `exemptRoles` on a lock. This pins the "the locking admin can still
  // edit" behaviour documented in the module header.
  it('registry matches respects exemptRoles', () => {
    const reg = createPathLockRegistry();
    const lock = reg.add({
      prefix: 'entities/storey-1/',
      label: 'mep-review',
      exemptRoles: new Set(['admin']),
    });
    expect(reg.matches('entities/storey-1/wall', { userId: 'bob', role: 'editor' })).toBe(lock);
    expect(reg.matches('entities/storey-1/wall', { userId: 'alice', role: 'admin' })).toBeNull();
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

  // The reject-path test above only proves the verifier can say no. It
  // does not prove an allowed write actually reaches other peers — that
  // is a separate, unverified claim about how `handleMessage` dispatches
  // an `{ ok: true }` decision. In the sibling replay-protector verifier,
  // the accept path was silently broken (the transformed `payload` it
  // returned was never dispatched, so every accepted edit vanished)
  // while its own reject-path test stayed green (fixed in #2846). This
  // test drives two real peers through a real `startCollabServer` with
  // `verifyAgainstPathLocks` installed and asserts the downstream
  // effect — peer 2 observing peer 1's write to an *unlocked* path —
  // not just the verifier's return value.
  it('accepts writes to unlocked prefixes and propagates them to other peers via verifyAgainstPathLocks', async () => {
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

    const doc1 = new Y.Doc();
    const prov1 = new WebsocketProvider(url, 'project/main', doc1, {
      WebSocketPolyfill: WebSocket as never,
      disableBc: true,
    });
    const doc2 = new Y.Doc();
    const prov2 = new WebsocketProvider(url, 'project/main', doc2, {
      WebSocketPolyfill: WebSocket as never,
      disableBc: true,
    });
    await Promise.all([
      new Promise<void>((res) => (prov1.synced ? res() : prov1.once('sync', () => res()))),
      new Promise<void>((res) => (prov2.synced ? res() : prov2.once('sync', () => res()))),
    ]);

    // Write to an UNLOCKED path from peer 1.
    const ents1 = doc1.getMap('entities');
    doc1.transact(() => {
      const wall = new Y.Map<unknown>();
      wall.set('kind', 'wall');
      ents1.set('open-wall', wall);
    });

    // Assert the downstream effect on peer 2, not the verifier's decision.
    await vi.waitFor(() => {
      const ents2 = doc2.getMap('entities');
      expect(ents2.has('open-wall')).toBe(true);
    }, { timeout: 5_000, interval: 25 });

    prov1.destroy();
    prov2.destroy();
    await handle.stop();
  }, 10_000);
});
